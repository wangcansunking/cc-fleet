// Real, in-container HTTP edge-case e2e for copilot-reverse.
//
// NOT a mock. Boots the REAL worker proxy (:7891) and the REAL supervisor control API (:7890), then
// drives them over HTTP exactly like a client + the TUI do. The cases here exercise paths that REJECT
// before any upstream call — malformed body, oversized body, bad route, count_tokens, supervision
// lifecycle, and the crash-guard regressions — so a DUMMY token is enough and no Copilot quota is
// spent. A couple of golden round-trips fire a real request only when a real token is mounted.
//
// Exit 0 = all asserted; non-zero = a failure. Mirrors heartbeat-e2e.mjs's check harness.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";

const HOST = "127.0.0.1";
const SUP = 7890, WRK = 7891;
const supUrl = (p) => `http://${HOST}:${SUP}${p}`;
const wrkUrl = (p) => `http://${HOST}:${WRK}${p}`;
const wrkUrl2 = (port, p) => `http://${HOST}:${port}${p}`; // loopback URL for an ad-hoc worker on `port`
const TOKEN_FILE = process.env.TOKEN_FILE || "/run/secrets/creds.json";
const DATA_DIR = `${process.env.HOME || "/root"}/.copilot-reverse`;

function realToken() {
  try { const t = JSON.parse(readFileSync(TOKEN_FILE, "utf8"))?.ghToken; return typeof t === "string" && t ? t : null; }
  catch { return null; }
}
const log = (...a) => console.log(...a);
let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; log(`  ✓ ${name}`); } else { failures++; log(`  ✗ ${name} — ${detail ?? ""}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function ready(url, n = 60) { for (let i = 0; i < n; i++) { try { if ((await fetch(url)).ok) return true; } catch {} await sleep(250); } return false; }
async function jget(u) { const r = await fetch(u); return { s: r.status, j: await r.json().catch(() => null) }; }
async function jpost(u, body, h) { const r = await fetch(u, { method: "POST", headers: { "content-type": "application/json", ...h }, body }); return { s: r.status, t: await r.text() }; }

// The host's primary non-loopback IPv4 (e.g. the container's eth0 address), or null. Used to prove the
// bind boundary: a worker bound to 127.0.0.1 must be UNREACHABLE on this address, while one bound to
// 0.0.0.0 must be reachable on it.
function nonLoopbackIPv4() {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === "IPv4" && !a.internal) return a.address;
  }
  return null;
}
// Raw-TCP reachability probe — distinguishes "kernel accepted the connection" (socket is bound on this
// address) from "connection refused / timed out" (no socket on this address). fetch() can't tell these
// apart as cleanly: a refused TCP connect is the exact "can't even connect" boundary localhost mode
// relies on. Returns "open" | "refused" | "timeout".
function tcpProbe(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = connect({ host, port });
    let done = false;
    const finish = (r) => { if (!done) { done = true; try { sock.destroy(); } catch {} resolve(r); } };
    sock.setTimeout(timeoutMs);
    sock.on("connect", () => finish("open"));
    sock.on("timeout", () => finish("timeout"));
    sock.on("error", () => finish("refused")); // ECONNREFUSED (no listener on this addr) / EHOSTUNREACH
  });
}
// Boot a standalone worker on a chosen BIND_HOST + port with an isolated data dir, wait for /healthz on
// loopback, run `fn`, then kill it. Lets us exercise the bind boundary without disturbing the main
// supervisor-managed worker on :7891.
async function withWorker({ bindHost, port, mode, key }, fn) {
  const home = join(DATA_DIR, `..`, `cr-bind-${port}`);
  const data = join(home, ".copilot-reverse");
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "creds.json"), JSON.stringify({ ghToken: "ghu_dummy0000000000000000000000000000000" }));
  writeFileSync(join(data, "network.json"), JSON.stringify({ mode, ...(key ? { key } : {}) }));
  const child = spawn("node", ["dist/worker/index.js"], { stdio: "inherit", env: { ...process.env, HOME: home, USERPROFILE: home, WORKER_PORT: String(port), BIND_HOST: bindHost } });
  try {
    if (!(await ready(`http://127.0.0.1:${port}/healthz`))) throw new Error(`worker(${bindHost}:${port}) never up`);
    return await fn();
  } finally { child.kill(); await sleep(200); }
}

async function main() {
  const token = realToken();
  // A dummy token lets the worker boot and reject malformed/edge requests before any upstream call;
  // real round-trips only run if a real token was mounted.
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(join(DATA_DIR, "creds.json"), JSON.stringify({ ghToken: token || "ghu_dummy0000000000000000000000000000000" }));
  log(`\ncopilot-reverse — HTTP edge-case e2e\nreal token: ${token ? "yes" : "no (edge cases run on a dummy token; golden skipped)"}\n`);

  const sup = spawn("node", ["dist/supervisor/index.js"], { stdio: "inherit", env: process.env });
  try {
    if (!(await ready(supUrl("/api/status")))) throw new Error("supervisor never up");
    if (!(await ready(wrkUrl("/healthz")))) throw new Error("worker never up");

    log("[proxy] error & edge paths (no upstream call)");
    check("malformed JSON → 400", (await jpost(wrkUrl("/anthropic/v1/messages"), "{bad")).s === 400);
    check(">20mb body → 413", (await jpost(wrkUrl("/anthropic/v1/messages"), JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "x".repeat(21 * 1024 * 1024) }] }))).s === 413);
    check("unknown route → 404", (await fetch(wrkUrl("/nope"))).status === 404);
    check("/healthz ok", (await jget(wrkUrl("/healthz"))).j?.ok === true);
    check("/openai/models non-empty", (await jget(wrkUrl("/openai/models"))).j?.data?.length > 0);
    const models = (await jget(wrkUrl("/anthropic/v1/models"))).j?.data ?? [];
    check("/anthropic/v1/models non-empty", models.length > 0);
    // Model mapping: Claude families must surface as the DASHED canonical ids Claude Code's native
    // picker recognises (claude-opus-4-8) with a friendly display_name + [1m] badge for 1M models —
    // never Copilot's dotted ids. Holds on both the live list and the offline fallback.
    check("no dotted claude ids leak to picker", !models.some((m) => /claude-(opus|sonnet)-4\.[0-9]/.test(m.id)));
    const opus = models.find((m) => m.id.startsWith("claude-opus-4-8"));
    check("opus has friendly display_name", opus?.display_name === "Opus 4.8", opus?.display_name);
    check("opus carries [1m] 1M badge", opus?.id === "claude-opus-4-8[1m]", opus?.id);
    // Single-segment version id (claude-sonnet-5): the friendly name must not regress to a bare id, and
    // as a known-current 1M model it must carry the [1m] badge. In the hermetic gate the dummy token
    // fails discovery, so this rides the offline fallback list (which now lists sonnet-5) — proving the
    // generalised display-name + default-1M path without spending quota.
    const sonnet5 = models.find((m) => m.id.startsWith("claude-sonnet-5"));
    check("sonnet-5 present in picker", !!sonnet5, JSON.stringify(models.map((m) => m.id)));
    check("sonnet-5 has friendly display_name (single-segment version)", sonnet5?.display_name === "Sonnet 5", sonnet5?.display_name);
    check("sonnet-5 carries [1m] 1M badge", sonnet5?.id === "claude-sonnet-5[1m]", sonnet5?.id);
    const ct = await jpost(wrkUrl("/anthropic/v1/messages/count_tokens"), JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }));
    check("count_tokens input_tokens>0", JSON.parse(ct.t).input_tokens > 0, ct.t);

    // Image downscale (model_max_prompt_tokens_exceeded fix): Copilot has no vision tiler on /chat for
    // Claude models — it bills an inline base64 data URL as PLAIN TEXT (~char/4), so a full-res
    // screenshot (~2.3M tokens) blows past the prompt limit. The worker now downscales oversized images
    // before counting/sending (the job the real Anthropic backend does for us). Prove it quota-free
    // through count_tokens: a large image's estimate must land FAR below the raw base64 byte count, i.e.
    // the pixels were re-encoded smaller. The source is a NOISE image (randomised pixels) so its PNG
    // can't run-length compress — a realistic high-entropy screenshot, unlike a solid color that encodes
    // to a few KB and would actually grow when re-encoded. 1800px long edge (>1568) triggers the resize.
    {
      const { Jimp, JimpMime } = await import("jimp");
      const { randomFillSync } = await import("node:crypto");
      const noise = new Jimp({ width: 1800, height: 1200, color: 0 });
      randomFillSync(noise.bitmap.data);
      const bigBuf = await noise.getBuffer(JimpMime.png);
      const b64 = bigBuf.toString("base64");
      const rawTokens = Math.ceil((`data:image/png;base64,${b64}`).length / 4); // count_tokens with NO shrink
      const body = JSON.stringify({ model: "claude-opus-4-8[1m]", messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: b64 } }] }] });
      const imgCt = await jpost(wrkUrl("/anthropic/v1/messages/count_tokens"), body);
      const imgTokens = JSON.parse(imgCt.t).input_tokens;
      check("oversized image is downscaled before counting (tokens << raw base64)", imgTokens > 0 && imgTokens < rawTokens / 2, `shrunk=${imgTokens} raw=${rawTokens}`);

      // The REAL generate-readme-cover-images 502: the oversized image came back INSIDE a tool_result
      // (a Bash command that emitted a screenshot), which was being flattened to a text string and so
      // bypassed both the resize and honest token counting. Same noise image, now nested in a
      // tool_result — its count_tokens must ALSO land far below the raw base64 size.
      const trBody = JSON.stringify({
        model: "claude-opus-4-8[1m]",
        messages: [
          { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "shot", input: {} }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: [
            { type: "text", text: "screenshot:" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: b64 } },
          ] }] },
        ],
      });
      const trCt = await jpost(wrkUrl("/anthropic/v1/messages/count_tokens"), trBody);
      const trTokens = JSON.parse(trCt.t).input_tokens;
      check("oversized image INSIDE a tool_result is also downscaled (readme-cover 502 path)", trTokens > 0 && trTokens < rawTokens / 2, `shrunk=${trTokens} raw=${rawTokens}`);

      // The byte-gate gap (the "I read a normal-sized image and still 502'd" case): an image whose long
      // edge is already WITHIN the pixel cap but whose BYTES are huge. A pixel-only gate would pass it
      // through untouched. Build a 1568×1400 noise image (long edge == cap) and assert count_tokens
      // still lands far below its raw base64 — proving the worker gates on BYTES, not just dimensions.
      const heavy = new Jimp({ width: 1568, height: 1400, color: 0 });
      randomFillSync(heavy.bitmap.data);
      const hb64 = (await heavy.getBuffer(JimpMime.png)).toString("base64");
      const hRaw = Math.ceil((`data:image/png;base64,${hb64}`).length / 4);
      const hBody = JSON.stringify({ model: "claude-opus-4-8[1m]", messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: hb64 } }] }] });
      const hTokens = JSON.parse((await jpost(wrkUrl("/anthropic/v1/messages/count_tokens"), hBody)).t).input_tokens;
      check("within-edge but heavy image is still shrunk (byte gate, not pixel gate)", hTokens > 0 && hTokens < hRaw / 2, `shrunk=${hTokens} raw=${hRaw}`);

      // Context editing (clear old tool screenshots): a browser-harness loop emits one screenshot per
      // step and the stateless wire re-sends ALL of them every turn, so cumulative base64 eventually
      // trips Copilot's request entity limit (probed at exactly 5 MiB → 413 → relayed 502). The worker
      // now does what Anthropic's backend does server-side — keep the most recent few screenshots,
      // replace older ones with a placeholder — bounding the payload to the ~3.5MB image budget (under
      // the 5 MiB wall). Prove it quota-free through count_tokens: build MANY screenshots each already
      // under the per-image resize cap (so resize passes them through untouched) but collectively far
      // over the cumulative budget, and assert (a) the estimate lands far below the raw sum — i.e. old
      // images were CLEARED, not merely resized — and (b) the whole estimated payload now fits under the
      // 5 MiB gateway limit, the property that actually prevents the 413. Each image ~1MB base64
      // (430×430 noise), 12 turns ≈ 12MB raw.
      {
        const one = new Jimp({ width: 430, height: 430, color: 0 });
        randomFillSync(one.bitmap.data);
        const sb64 = (await one.getBuffer(JimpMime.png)).toString("base64");
        const shotLen = `data:image/png;base64,${sb64}`.length;
        const TURNS = 12;
        const msgs = [];
        for (let i = 0; i < TURNS; i++) {
          msgs.push({ role: "assistant", content: [{ type: "tool_use", id: `s${i}`, name: "screenshot", input: {} }] });
          msgs.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `s${i}`, content: [
            { type: "text", text: `step ${i}` },
            { type: "image", source: { type: "base64", media_type: "image/png", data: sb64 } },
          ] }] });
        }
        const rawAll = Math.ceil((shotLen * TURNS) / 4); // tokens if EVERY screenshot were kept
        const ceBody = JSON.stringify({ model: "claude-opus-4-8[1m]", messages: msgs });
        const ceTokens = JSON.parse((await jpost(wrkUrl("/anthropic/v1/messages/count_tokens"), ceBody)).t).input_tokens;
        check("old tool screenshots are context-edited out (tokens << all-screenshots raw)", ceTokens > 0 && ceTokens < rawAll * 0.6, `edited=${ceTokens} rawAll=${rawAll} perShot=${Math.ceil(shotLen / 4)}`);
        // The property that actually prevents the 413: the edited payload (≈ tokens×4 bytes, since
        // Copilot bills base64 at char/4) must fit under the probed 5 MiB gateway wall. The pre-fix 6MB
        // budget FAILED this — it left an over-limit body that still 413'd.
        const GATEWAY_LIMIT = 5 * 1024 * 1024;
        check("edited payload fits under the 5 MiB gateway limit (the actual 413 guard)", ceTokens * 4 < GATEWAY_LIMIT, `estBytes=${ceTokens * 4} limit=${GATEWAY_LIMIT}`);
        // Precondition guard: each screenshot really was under the per-image resize cap, so what shrank
        // the count was CLEARING (context editing), not per-image downscaling.
        check("context-edit precondition: each screenshot is under the per-image resize cap", shotLen < 1_500_000, `shotLen=${shotLen}`);
      }

      // Dynamic budget (issue #52 follow-up): the 413 is on the WHOLE body, not just images. A big
      // conversation (a ~700k-token transcript) plus a few kept screenshots can still exceed the 5 MiB
      // wall even though the images alone fit a fixed 3.5MB budget. The image allowance must therefore
      // shrink as non-image text grows. Drive it: 9 issue-52-sized screenshots PLUS ~700k tokens of text
      // carried as a leading user message, through count_tokens. The estimate (≈ whole-body bytes / 4)
      // must land under the 5 MiB wall — proving context editing cleared MORE images to make room for the
      // text. A fixed image-only budget would keep 3 images (~3.15MB) + 2.7MB text ≈ 5.9MB and still 413.
      {
        const sizes = [280077, 1022958, 1100790, 1188974, 923334, 1099958, 1062270, 1062270, 1174838];
        const bigText = "x".repeat(700_000 * 4); // ~700k tokens carried as conversation text
        const dmsgs = [{ role: "user", content: bigText }];
        for (let i = 0; i < sizes.length; i++) {
          dmsgs.push({ role: "assistant", content: [{ type: "tool_use", id: `d${i}`, name: "screenshot", input: {} }] });
          dmsgs.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `d${i}`, content: [
            { type: "text", text: `step ${i}` },
            // A base64 blob of the issue-52 byte size (content irrelevant to count_tokens — it sizes bytes).
            { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(sizes[i] - 23) } },
          ] }] });
        }
        const dBody = JSON.stringify({ model: "claude-opus-4-8[1m]", messages: dmsgs });
        const dTokens = JSON.parse((await jpost(wrkUrl("/anthropic/v1/messages/count_tokens"), dBody)).t).input_tokens;
        const GATEWAY_LIMIT2 = 5 * 1024 * 1024;
        check("dynamic budget: big text + screenshots still fits the 5 MiB wall (issue #52 follow-up)", dTokens * 4 < GATEWAY_LIMIT2, `estBytes=${dTokens * 4} limit=${GATEWAY_LIMIT2}`);
      }
    }

    // Reasoning effort (#33) is resolved and echoed in the x-copilot-reverse-effort response header
    // BEFORE any upstream call, so a dummy token still proves the resolution. Drives the REAL modern
    // Claude Code wire shape (top-level output_config.effort + thinking:{type:adaptive}, NOT
    // budget_tokens) — the regression that made switching effort silently no-op. Legacy budget_tokens
    // must still map too. The header is the deterministic, quota-free signal that effort took effect.
    const effHeader = async (body) => (await fetch(wrkUrl("/anthropic/v1/messages"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).headers.get("x-copilot-reverse-effort");
    for (const eff of ["low", "high", "xhigh", "max"]) {
      const got = await effHeader({ model: "gpt-4o", max_tokens: 16, output_config: { effort: eff }, thinking: { type: "adaptive" }, messages: [{ role: "user", content: "hi" }] });
      check(`effort '${eff}' resolved + echoed (modern output_config wire)`, got === eff, `header=${got}`);
    }
    check("legacy thinking.budget_tokens=16000 maps to effort high", (await effHeader({ model: "gpt-4o", max_tokens: 16, thinking: { type: "enabled", budget_tokens: 16000 }, messages: [{ role: "user", content: "hi" }] })) === "high");
    check("a plain turn sets NO effort header (reasoning off by default)", (await effHeader({ model: "gpt-4o", max_tokens: 16, messages: [{ role: "user", content: "hi" }] })) === null);

    log("\n[supervisor] control lifecycle");
    check("status workerState=ready", (await jget(supUrl("/api/status"))).j?.workerState === "ready");
    const dashHtml = await (await fetch(supUrl("/"))).text();
    check("dashboard HTML at /", (await fetch(supUrl("/"))).headers.get("content-type")?.includes("html"));
    // The dashboard must pull real totals from the SQL rollup (/api/metrics), NOT the capped
    // /api/requests fetch that made it stick at "total 100" and render a flat dump of identical 200s.
    check("dashboard wires to /api/metrics (not capped /api/requests)", dashHtml.includes("/api/metrics") && /renderMetrics|byModel/.test(dashHtml), dashHtml.includes("/api/requests") ? "still references /api/requests for totals" : "");
    check("doctor checks[]", Array.isArray((await jget(supUrl("/api/doctor"))).j?.checks));
    check("requests[]", Array.isArray((await jget(supUrl("/api/requests"))).j?.requests));

    // Richer /doctor self-check + the dashboard's new data endpoints. Light /doctor (no ?ping) must be
    // upstream-free and carry the web-search + models checks (named), so it's safe for the 2s poll. The
    // dashboard now also pulls /api/clients (per-scope config) and /api/models (advertised, proxied).
    log("\n[doctor+dashboard] richer self-check + parity data endpoints");
    const doc = (await jget(supUrl("/api/doctor"))).j?.checks ?? [];
    const named = (n) => doc.find((c) => c.name === n);
    check("doctor has web-search check", !!named("web-search"), JSON.stringify(doc.map((c) => c.name)));
    check("doctor has models check", !!named("models"));
    check("doctor light has NO per-model ping checks", !doc.some((c) => String(c.name).startsWith("model:")));
    const docPing = (await jget(supUrl("/api/doctor?ping=1"))).j?.checks ?? [];
    // No client is configured in-container, so ping mode reports the informational note (not a crash).
    check("doctor ?ping returns checks", Array.isArray(docPing) && docPing.length >= doc.length);
    const clients = (await jget(supUrl("/api/clients"))).j;
    check("/api/clients has claude+codex", clients && "claude" in clients && "codex" in clients, JSON.stringify(clients));
    const mods = (await jget(supUrl("/api/models"))).j?.models;
    check("/api/models advertises models", Array.isArray(mods) && mods.length > 0, JSON.stringify((mods || []).slice(0, 2)));

    // /logs hardening: a real upstream failure (the dummy token 401s at Copilot) stores a metric
    // error, which /logs renders one-per-line inside a bordered card. A multi-line body (a 502 returns
    // an HTML page) once shattered that border. Drive a real failing request, read the REAL stored
    // metric back from the supervisor, then run it through the REAL TUI formatter (dist oneLine) the
    // /logs command uses — the rendered line must contain no newline, whatever the upstream sent.
    log("\n[/logs] stored request error renders as a single contained line");
    await jpost(wrkUrl("/anthropic/v1/messages"), JSON.stringify({ model: "gpt-4o", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }));
    await sleep(400);
    const { oneLine } = await import("../../dist/shared/format.js");
    const logged = (await jget(supUrl("/api/requests"))).j?.requests ?? [];
    const failed = logged.find((r) => r.status >= 400 || r.error != null);
    check("a failing request was logged", !!failed, JSON.stringify(logged[0] ?? {}).slice(0, 120));
    if (failed) {
      const rendered = `${new Date(failed.ts).toISOString()} ${failed.status} ${failed.endpoint} ${failed.model} — ${oneLine(failed.error, 160) || "(no message)"}`;
      check("/logs line has no embedded newline", !/\r?\n/.test(rendered), JSON.stringify(rendered).slice(0, 160));
    }

    // /api/metrics must roll up the WHOLE request_log in SQL, not a 100-row fetch. Insert >100 rows
    // straight into the supervisor's own DB (same file, WAL so a 2nd connection sees committed writes),
    // then assert the reported total exceeds 100 and the 24h window is bounded — the old /metrics capped
    // at 100 and "100 reqs" was a meaningless ceiling once you crossed it.
    log("\n[/metrics] real lifetime rollup over the whole request_log (not a 100-row cap)");
    const { openDb, recordRequest } = await import("../../dist/supervisor/db.js");
    const { dbPath } = await import("../../dist/shared/paths.js");
    const seedDb = openDb(dbPath());
    const baseTotal = (await jget(supUrl("/api/metrics"))).j?.all?.total ?? 0;
    const now = Date.now();
    for (let i = 0; i < 150; i++) recordRequest(seedDb, { ts: now - i * 1000, endpoint: "/anthropic/v1/messages", model: "gpt-4o", status: 200, latencyMs: 10, tokensIn: 2, tokensOut: 1 });
    recordRequest(seedDb, { ts: now - 3 * 24 * 60 * 60 * 1000, endpoint: "/anthropic/v1/messages", model: "gpt-4o", status: 502, latencyMs: 5, error: "old failure 3 days ago" });
    seedDb.close();
    const met = (await jget(supUrl("/api/metrics"))).j;
    check("/api/metrics counts >100 rows (no display cap)", met?.all?.total >= baseTotal + 151, `total=${met?.all?.total} base=${baseTotal}`);
    check("/api/metrics day window <= all-time", met?.day?.total <= met?.all?.total && met?.day?.total >= 150, `day=${met?.day?.total} all=${met?.all?.total}`);
    check("/api/metrics surfaces the old (pre-100) failure in recentErrors", (met?.recentErrors ?? []).some((e) => e.error === "old failure 3 days ago"), JSON.stringify((met?.recentErrors ?? []).map((e) => e.error)).slice(0, 160));
    await jpost(supUrl("/api/restart"), "{}"); await sleep(1500);
    check("worker ready after restart", (await jget(supUrl("/api/status"))).j?.workerState === "ready");

    log("\n[crash-guard] dead SSE clients + broadcast churn — daemon stays up (smoke; deterministic guard is in unit tests)");
    const ctrls = Array.from({ length: 4 }, () => { const c = new AbortController(); fetch(supUrl("/api/events"), { signal: c.signal }).catch(() => {}); return c; });
    await sleep(500); ctrls[1].abort(); ctrls[2].abort();
    for (let i = 0; i < 6; i++) { await jpost(supUrl("/api/restart"), "{}"); await sleep(150); }
    await sleep(1500);
    check("daemon survives dead-socket broadcast churn", (await jget(supUrl("/api/status"))).s === 200);
    ctrls.forEach((c) => { try { c.abort(); } catch {} });

    // Deterministic regression for the PR #8 crash: a throwing subscriber (a dead-socket SSE write)
    // must not escape EventBus.emit. Exercises the REAL EventBus from dist/; this FAILS on the reverted
    // guard, which the black-box churn above cannot reliably trigger over TCP.
    log("\n[crash-guard] EventBus isolates a throwing subscriber (real dist module)");
    const { EventBus } = await import("../../dist/supervisor/events.js");
    const bus = new EventBus(); let live = 0;
    bus.subscribe(() => { throw new Error("ERR_STREAM_DESTROYED"); });
    bus.subscribe(() => { live++; });
    let escaped = false; try { bus.emit("metric", { a: 1 }); bus.emit("metric", { a: 2 }); } catch { escaped = true; }
    check("throwing listener does not escape emit", !escaped);
    check("live subscriber still served after a peer throws", live > 0);

    // EADDRINUSE regression (the daemon-unhealthy crash loop): TWO independent failure modes that both
    // ended in "listen EADDRINUSE :7891" → repeated worker-crash → daemon marked unhealthy.
    //
    //   (a) ORPHAN: a forked worker does NOT die when its supervisor dies abnormally. The orphan keeps
    //       holding the port, so the NEXT supervisor's worker can't bind it. Fixed by the worker's
    //       'disconnect' guard (src/worker/index.ts): when the IPC channel to the parent drops, the
    //       worker exits and releases the port. We reproduce a dead parent deterministically by forking
    //       the REAL worker with an IPC channel (exactly as the supervisor does) and then dropping that
    //       channel — child.disconnect() fires the same 'disconnect' event a crashed supervisor would.
    //
    //   (b) RESTART RACE: restartManually() used to kill+respawn synchronously, racing the dying worker
    //       for the port. Fixed by deferring the spawn to the old child's exit. The 6× rapid restart
    //       loop above exercises it; the steady-state assert below proves it didn't wedge the daemon.
    log("\n[crash-guard] EADDRINUSE regression: orphaned worker releases its port when the IPC parent drops");
    {
      const { fork } = await import("node:child_process");
      const ORPHAN_PORT = 7898;
      const home = join(DATA_DIR, "..", "cr-orphan");
      const data = join(home, ".copilot-reverse");
      mkdirSync(data, { recursive: true });
      writeFileSync(join(data, "creds.json"), JSON.stringify({ ghToken: "ghu_dummy0000000000000000000000000000000" }));
      // fork() gives the child a Node IPC channel — so process.connected is true and the disconnect
      // guard is armed, just like a supervisor-spawned worker (plain spawn() would not arm it).
      const worker = fork("dist/worker/index.js", [], {
        stdio: ["ignore", "ignore", "inherit", "ipc"],
        env: { ...process.env, HOME: home, USERPROFILE: home, WORKER_PORT: String(ORPHAN_PORT), BIND_HOST: "127.0.0.1" },
      });
      const up = await ready(`http://127.0.0.1:${ORPHAN_PORT}/healthz`);
      check("orphan-test worker came up on its port", up);
      check("port held while IPC parent is connected", (await tcpProbe("127.0.0.1", ORPHAN_PORT)) === "open");
      // Drop the IPC channel WITHOUT a {shutdown} message — the worker only sees 'disconnect', exactly
      // what an abnormally-dead supervisor leaves behind. With the guard it exits and frees the port.
      worker.disconnect();
      let freed = "open";
      for (let i = 0; i < 40; i++) { await sleep(250); if ((freed = await tcpProbe("127.0.0.1", ORPHAN_PORT)) !== "open") break; }
      check(`orphaned worker released :${ORPHAN_PORT} after its parent dropped (disconnect guard)`, freed !== "open", `probe=${freed}`);
      try { worker.kill("SIGKILL"); } catch {} // belt-and-suspenders if the guard ever regressed
    }

    // After everything above (incl. the 6× rapid restart loop), the daemon must still be ready and must
    // NOT have wedged into "unhealthy" — the end-state symptom the user reported. A restart that raced
    // the port would have logged worker-crash rows and, after maxCrashes, flipped workerState away from
    // ready. Assert the healthy steady state explicitly.
    log("\n[crash-guard] daemon is ready (not unhealthy) after restart churn");
    check("workerState ready (never wedged unhealthy)", (await jget(supUrl("/api/status"))).j?.workerState === "ready");

    // Access modes (#25): the worker auth gate reads network.json LAZILY per request, so we can flip
    // the posture on disk without a restart and assert the gate's behavior over real HTTP. These requests
    // all originate from 127.0.0.1 (this process), so they exercise the LOOPBACK side of the policy: a
    // local client is NEVER challenged for a key, in either mode. The genuinely-remote checks (where the
    // key IS required) are in the bind-boundary block below, driven over the container's LAN IP.
    log("\n[access-modes] loopback is never key-gated (localhost AND lan); only remote is");
    const NET = join(DATA_DIR, "network.json");
    const withKey = (k) => ({ authorization: `Bearer ${k}` });
    // localhost (default): open, no key needed.
    check("localhost: /openai/models open from loopback (no key)", (await fetch(wrkUrl("/openai/models"))).status === 200);
    // Flip to LAN. The LOCAL machine's own clients keep working with NO key — the behavior users expect
    // (their on-box Claude/Codex don't suddenly need the key when they share the proxy on the LAN).
    writeFileSync(NET, JSON.stringify({ mode: "lan", key: "e2e-secret" }));
    check("lan: loopback served WITHOUT a key (local client unaffected)", (await fetch(wrkUrl("/openai/models"))).status === 200);
    check("lan: loopback served even WITH a (wrong) key — local is exempt, key ignored", (await fetch(wrkUrl("/openai/models"), { headers: withKey("whatever") })).status === 200);
    check("lan: /healthz stays OPEN (supervisor probe)", (await fetch(wrkUrl("/healthz"))).status === 200);
    // Fail-closed only bites REMOTE callers (below); loopback stays open even with no key configured.
    writeFileSync(NET, JSON.stringify({ mode: "lan" }));
    check("lan + no key: loopback still served (fail-closed is for remote, not local)", (await fetch(wrkUrl("/openai/models"))).status === 200);
    // Restore the safe default for the golden round-trips.
    writeFileSync(NET, JSON.stringify({ mode: "localhost", key: "e2e-secret" }));
    check("back to localhost: open again from loopback (no key)", (await fetch(wrkUrl("/openai/models"))).status === 200);

    // The bind BOUNDARY — the kernel-level reason localhost mode is "you can't even connect", not 401.
    // A worker bound to 127.0.0.1 has no socket on any other interface, so a TCP connect to the host's
    // LAN IP is REFUSED (no listener) — the request never reaches the HTTP/auth layer at all. The same
    // worker bound to 0.0.0.0 (LAN mode's bind) IS reachable on that exact address. Same IP, same probe,
    // only the bind host changes: open↔refused proves the boundary, not just the config value.
    log("\n[access-modes] bind boundary: localhost is unreachable off-loopback; LAN binds all interfaces");
    const lanIp = nonLoopbackIPv4();
    if (!lanIp) {
      log("  ⊘ no non-loopback IPv4 in this container — skipping the reachability probe");
    } else {
      const PORT = 7899;
      // Sanity: loopback is reachable in BOTH binds (the worker is genuinely up either way).
      await withWorker({ bindHost: "127.0.0.1", port: PORT, mode: "localhost" }, async () => {
        check("localhost-bound: reachable on 127.0.0.1 (worker is up)", (await tcpProbe("127.0.0.1", PORT)) === "open");
        // The actual boundary: bound to 127.0.0.1 → NOT reachable on the LAN IP.
        const r = await tcpProbe(lanIp, PORT);
        check(`localhost-bound: UNREACHABLE on LAN ip ${lanIp} (connect refused, never hits HTTP)`, r !== "open", `probe=${r}`);
      });
      // LAN bind (0.0.0.0) → reachable on the very same LAN IP that was refused above.
      await withWorker({ bindHost: "0.0.0.0", port: PORT, mode: "lan", key: "e2e-secret" }, async () => {
        check(`lan-bound (0.0.0.0): reachable on LAN ip ${lanIp}`, (await tcpProbe(lanIp, PORT)) === "open");
        // REMOTE (over the LAN IP) is where the key is actually enforced. This is the true off-box path.
        const rem = (p, h) => fetch(`http://${lanIp}:${PORT}${p}`, h ? { headers: h } : undefined).then((r) => r.status).catch(() => 0);
        check("remote: no key → 401", (await rem("/openai/models")) === 401);
        check("remote: wrong key → 401", (await rem("/openai/models", withKey("nope"))) === 401);
        // Same length as "e2e-secret" (10 chars) → only the constant-time compare can reject it.
        check("remote: same-length wrong key → 401", (await rem("/openai/models", withKey("e2e-secres"))) === 401);
        check("remote: valid Bearer key → 200", (await rem("/openai/models", withKey("e2e-secret"))) === 200);
        check("remote: valid x-api-key → 200", (await rem("/openai/models", { "x-api-key": "e2e-secret" })) === 200);
        // Gate runs before the body parser: a keyless remote >20mb body → 401 (gate), not 413 (parser).
        const huge = JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "x".repeat(21 * 1024 * 1024) }] });
        const big = await fetch(`http://${lanIp}:${PORT}/openai/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: huge }).then((r) => r.status).catch(() => 0);
        check("remote: oversized keyless body → 401 (gate before body parser, not 413)", big === 401);
        // CONTRAST: the SAME exposed worker still serves LOOPBACK with no key — only the network is gated.
        check("lan-bound: loopback STILL served without a key (local exempt on the same worker)", (await fetch(wrkUrl2(PORT, "/openai/models"))).status === 200);
      });
      // Fail-closed is a REMOTE property: an exposed worker with NO key configured refuses the network
      // (503) but still serves loopback. Proven on a fresh worker booted keyless in lan mode.
      await withWorker({ bindHost: "0.0.0.0", port: PORT, mode: "lan" }, async () => {
        const rem503 = await fetch(`http://${lanIp}:${PORT}/openai/models`, { headers: withKey("anything") }).then((r) => r.status).catch(() => 0);
        check("remote + no key configured → 503 fail-closed (never an open proxy)", rem503 === 503);
        check("lan-bound keyless: loopback still served (fail-closed is for remote only)", (await fetch(wrkUrl2(PORT, "/openai/models"))).status === 200);
      });
    }

    if (token) {
      log("\n[golden] real round-trips");
      const a = await jpost(wrkUrl("/anthropic/v1/messages"), JSON.stringify({ model: "gpt-4o", max_tokens: 16, messages: [{ role: "user", content: "say OK" }] }));
      check("anthropic /messages 200", a.s === 200, a.t.slice(0, 120));
      // The canonical [1m] id the picker hands back must resolve to a real Copilot model and answer —
      // proves the round-trip (dashed+[1m] -> dotted Copilot id) works end-to-end, not just in units.
      const c = await jpost(wrkUrl("/anthropic/v1/messages"), JSON.stringify({ model: "claude-opus-4-8[1m]", max_tokens: 16, messages: [{ role: "user", content: "say OK" }] }));
      check("canonical opus [1m] id resolves + 200", c.s === 200, c.t.slice(0, 120));

      // #50 P1 (never-freeze): a typo'd / unknown model id hits an upstream 400 (model_not_supported).
      // The worker must fast-fail it as a TERMINAL client error — HTTP 400 with an invalid_request_error
      // type on the non-stream path — NOT mask it as a retriable 502 (which made Claude Code retry to its
      // 90s turn timeout and FREEZE). Costs ~nothing: upstream 400s in <1s. Assert both status + type.
      const badStart = Date.now();
      const bad = await jpost(wrkUrl("/anthropic/v1/messages"), JSON.stringify({ model: "not-a-real-model-xyz", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }));
      const badMs = Date.now() - badStart;
      const badBody = (() => { try { return JSON.parse(bad.t); } catch { return {}; } })();
      check("unknown model → terminal 400 (not a retriable 502)", bad.s === 400, `status=${bad.s} in ${badMs}ms`);
      check("unknown model → invalid_request_error type (client won't retry → no freeze)", badBody?.error?.type === "invalid_request_error", bad.t.slice(0, 140));
      check("unknown model fast-fails (well under the turn timeout)", badMs < 15000, `${badMs}ms`);

      // The STREAMING path is what Claude Code actually drives: after message_start (HTTP 200) it must
      // emit an `error` SSE frame typed invalid_request_error — the terminal signal — then close, so the
      // client fails fast instead of retrying an api_error to the deadline.
      const badStream = await jpost(wrkUrl("/anthropic/v1/messages"), JSON.stringify({ model: "not-a-real-model-xyz", max_tokens: 16, stream: true, messages: [{ role: "user", content: "hi" }] }));
      const badErrFrame = badStream.t.split("\n\n").map((b) => {
        const ev = b.split("\n").find((l) => l.startsWith("event: "))?.slice(7);
        const d = b.split("\n").find((l) => l.startsWith("data: "))?.slice(6);
        try { return ev && d ? { ev, d: JSON.parse(d) } : null; } catch { return null; }
      }).find((f) => f?.ev === "error");
      check("unknown model (stream) → terminal invalid_request_error error frame", badErrFrame?.d?.error?.type === "invalid_request_error", badStream.t.slice(0, 160));

      // Token metrics: after a real round-trip the supervisor should log non-null in/out token counts.
      // Pick the most-recent SUCCESSFUL request (a 200) — the unknown-model 400 asserts above log a
      // token-less failure metric, so reqs[0] isn't guaranteed to be a round-trip.
      await sleep(500);
      const reqs = (await jget(supUrl("/api/requests"))).j?.requests ?? [];
      const top = reqs.find((r) => r.status === 200) ?? reqs[0] ?? {};
      check("metric carries token counts", typeof top.tokensIn === "number" && typeof top.tokensOut === "number", JSON.stringify(top));

      // Extended thinking (#33): a `thinking`-enabled streaming request to a real Claude model must
      // carry a NATIVE Anthropic thinking block — content_block_start type:thinking + thinking_delta —
      // emitted before the answer text. Proves the reasoning round-trip end-to-end over real HTTP (effort
      // in -> upstream reasoning_text -> thinking block out). NOTE: the upstream decides PER TURN whether
      // to surface reasoning_text (it's non-deterministic — a trivial prompt may answer with none), so we
      // retry a few times and assert the path works on a turn that DOES reason; the answer must always
      // come through regardless. A run where no turn reasoned degrades to a logged note, never a failure.
      let sawThinking = false, sawAnswer = false, thinkSample = "";
      for (let attempt = 0; attempt < 4 && !sawThinking; attempt++) {
        const think = await jpost(wrkUrl("/anthropic/v1/messages"), JSON.stringify({
          model: "claude-opus-4-8[1m]", max_tokens: 600, stream: true,
          thinking: { type: "enabled", budget_tokens: 8000 },
          messages: [{ role: "user", content: "What is 17*23? Show your step-by-step reasoning, then state the answer." }],
        }));
        const tf = think.t.split("\n\n").map((b) => {
          const ev = b.split("\n").find((l) => l.startsWith("event: "))?.slice(7);
          const d = b.split("\n").find((l) => l.startsWith("data: "))?.slice(6);
          try { return ev && d ? { ev, d: JSON.parse(d) } : null; } catch { return null; }
        }).filter(Boolean);
        const ts = tf.find((f) => f.ev === "content_block_start" && f.d.content_block?.type === "thinking");
        const tt = tf.filter((f) => f.ev === "content_block_delta" && f.d.delta?.type === "thinking_delta").map((f) => f.d.delta.thinking).join("");
        const ans = tf.filter((f) => f.ev === "content_block_delta" && f.d.delta?.type === "text_delta").map((f) => f.d.delta.text).join("");
        if (ans.includes("391")) sawAnswer = true;
        if (ts && tt.length > 0) { sawThinking = true; thinkSample = tt.slice(0, 60); }
      }
      check("thinking: answer delivered through the proxy (391)", sawAnswer);
      if (sawThinking) check("thinking: native thinking block + thinking_delta streamed (#33)", true, `thinking="${thinkSample}"`);
      else log(`  ⊘ thinking: upstream returned no reasoning in 4 attempts (non-deterministic) — path untested this run, answer ok`);

      // Codex additional_tools (issue #4231): newer Codex (gpt-5.6 family) sends NO top-level `tools` —
      // the tools ride inside an `additional_tools` item in `input`. If the worker drops that item the
      // model reaches Copilot tool-less and can only narrate calls as text. Fire the EXACT wire shape a
      // live `codex exec` sends (proven by tapping the CLI) at /openai/responses and assert a real
      // function_call comes back — proof the tools survived translation and reached the model. The model
      // decides per-turn, so retry a few times; a run where it just answers in text degrades to a note.
      let sawFuncCall = false, fcName = "";
      for (let attempt = 0; attempt < 4 && !sawFuncCall; attempt++) {
        const rsp = await jpost(wrkUrl("/openai/responses"), JSON.stringify({
          model: "gpt-4o", stream: true, max_output_tokens: 128,
          instructions: "You have a shell tool. To answer, you MUST call the `run_shell` tool — do not answer in text.",
          input: [
            { type: "additional_tools", role: "developer", tools: [
              { type: "function", name: "run_shell", description: "Run a shell command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
            ] },
            { type: "message", role: "user", content: [{ type: "input_text", text: "Run `ls` to list the files here." }] },
          ],
        }));
        // Parse the Responses SSE: a function_call is announced by response.output_item.added.
        const fc = rsp.t.split("\n\n").map((b) => {
          const d = b.split("\n").find((l) => l.startsWith("data: "))?.slice(6);
          try { return d ? JSON.parse(d) : null; } catch { return null; }
        }).find((e) => e?.type === "response.output_item.added" && e.item?.type === "function_call" && e.item?.name);
        if (fc) { sawFuncCall = true; fcName = fc.item.name; }
      }
      if (sawFuncCall) check("codex additional_tools: tool reached the model → function_call emitted (#4231)", fcName === "run_shell", `name=${fcName}`);
      else log("  ⊘ codex additional_tools: model answered in text this run (non-deterministic) — extraction is asserted hermetically in unit tests");
    } else log("\n[golden] SKIPPED (no real token)");
  } finally { sup.kill(); }
  log(`\n${failures === 0 ? "ALL PASSED" : failures + " FAILED"} (${passes} passed)`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error("http-e2e crashed:", e); process.exit(2); });

// Real, in-container end-to-end test for the GitHub-token heartbeat.
//
// This is NOT a mock. It boots the real control API (`createControlApp`) wired to a real
// `GithubHeartbeat`, listens on a real TCP port, and drives it purely over HTTP (`GET /api/status`) —
// exactly what the TUI's poll does. The heartbeat makes real calls to GitHub's Copilot-token endpoint,
// so `expired` is proven against a genuine 401 and (when a token is mounted) `connected` against a real
// token exchange. Only the probe interval is shortened so state transitions are observable in seconds
// instead of a minute.
//
// Exit 0 = all asserted states observed; non-zero = a failure (printed).

import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createControlApp } from "../../dist/supervisor/api.js";
import { GithubHeartbeat } from "../../dist/supervisor/github-heartbeat.js";
import { openDb } from "../../dist/supervisor/db.js";
import { readGhToken } from "../../dist/shared/creds.js";

const PORT = 7990;
const HOST = "127.0.0.1";
const PROBE_MS = 1500;               // fast cadence for the test (prod is 60s)

// Use a writable working dir as the data dir, so the read-only mounted token is never written to and
// the signed-out / expired cases can freely rewrite creds.json. The real token (if mounted) is read
// once from TOKEN_FILE and cached in memory.
const WORK_DIR = "/tmp/cr-e2e";
const credsPath = join(WORK_DIR, "creds.json");
const TOKEN_FILE = process.env.TOKEN_FILE || "/run/secrets/creds.json";

function mountedRealToken() {
  try {
    if (!existsSync(TOKEN_FILE)) return null;
    const t = JSON.parse(readFileSync(TOKEN_FILE, "utf8"))?.ghToken;
    return typeof t === "string" && t ? t : null;
  } catch { return null; }
}

const log = (...a) => console.log(...a);
let failures = 0;
function check(name, cond, detail) {
  if (cond) log(`  ✓ ${name}`);
  else { failures++; log(`  ✗ ${name} — ${detail ?? ""}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getStatus = async () => (await fetch(`http://${HOST}:${PORT}/api/status`)).json();

// Poll /api/status until github.<field> matches predicate, or time out.
async function waitForGithub(pred, timeoutMs = 12_000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    last = (await getStatus()).github;
    if (last && pred(last)) return last;
    await sleep(300);
  }
  return last; // return last seen (may be undefined) for the assertion to report
}

function setCreds(token) {
  mkdirSync(WORK_DIR, { recursive: true });
  writeFileSync(credsPath, JSON.stringify({ ghToken: token }));
}
function removeCreds() { rmSync(credsPath, { force: true }); }

async function main() {
  const realToken = mountedRealToken();
  mkdirSync(WORK_DIR, { recursive: true });
  removeCreds(); // start from a clean slate regardless of prior runs
  log(`\nGitHub-token heartbeat — real container e2e`);
  log(`mounted real token: ${realToken ? "yes" : "no (connected case will be skipped)"}\n`);

  const db = openDb(":memory:");
  // Real heartbeat + real start()/stop(); only the cadence is shortened so transitions show in seconds.
  const heartbeat = new GithubHeartbeat(
    () => readGhToken(WORK_DIR),
    undefined, undefined,
    { intervalMs: PROBE_MS, initialDelayMs: 200 },
  );
  const app = createControlApp({
    db, getState: () => "ready", restart: () => {}, stop: () => {}, start: () => {},
    doctor: async () => [], github: () => heartbeat.current(),
    clients: () => ({ claude: { user: false, project: false }, codex: { user: false, project: false } }), models: async () => [],
    subscribe: () => () => {},
  });
  const server = app.listen(PORT, HOST);
  await new Promise((r) => server.once("listening", r));
  heartbeat.start();
  log(`supervisor control API listening on http://${HOST}:${PORT}\n`);

  try {
    // --- Case 1: connected (only if a real token is mounted) ---
    if (realToken) {
      log("[1] real token → connected (real Copilot token exchange)");
      setCreds(realToken);
      const g = await waitForGithub((x) => x.ok === true);
      check("github.ok === true", g?.ok === true, JSON.stringify(g));
      check("github.hasToken === true", g?.hasToken === true, JSON.stringify(g));
      check("detail is 'token valid'", g?.detail === "token valid", g?.detail);
      check("checkedAt is a real timestamp", typeof g?.checkedAt === "number" && g.checkedAt > 0);
    } else {
      log("[1] connected — SKIPPED (no token mounted)");
    }

    // --- Case 2: signed-out (no token on disk) ---
    log("\n[2] no token on disk → signed-out");
    removeCreds();
    const g2 = await waitForGithub((x) => x.hasToken === false);
    check("github.hasToken === false", g2?.hasToken === false, JSON.stringify(g2));
    check("github.ok === false", g2?.ok === false, JSON.stringify(g2));
    check("detail mentions /login", /\/login|not logged in/i.test(g2?.detail ?? ""), g2?.detail);

    // --- Case 3: expired (a real, bad token → a real GitHub 401) ---
    log("\n[3] invalid token → expired (real GitHub 401)");
    setCreds("ghu_invalid000000000000000000000000000000");
    const g3 = await waitForGithub((x) => x.hasToken === true && x.ok === false);
    check("github.hasToken === true", g3?.hasToken === true, JSON.stringify(g3));
    check("github.ok === false", g3?.ok === false, JSON.stringify(g3));
    check("detail mentions expired/login", /expired|login/i.test(g3?.detail ?? ""), g3?.detail);

    // --- Case 4: the field is delivered over real HTTP as JSON ---
    log("\n[4] /api/status delivers github over real HTTP");
    const raw = await (await fetch(`http://${HOST}:${PORT}/api/status`)).text();
    check("response is JSON with workerState + github", /"workerState"/.test(raw) && /"github"/.test(raw), raw.slice(0, 120));
  } finally {
    heartbeat.stop();
    server.close();
  }

  log(`\n${failures === 0 ? "ALL PASSED" : failures + " CHECK(S) FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("e2e driver crashed:", e); process.exit(2); });

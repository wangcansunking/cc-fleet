import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const home = "/tmp/m4-home", data = join(home, ".cc-fleet"), agents = "/tmp/m4-agents";
const fakeBin = "/tmp/m4-bin", fakeState = "/tmp/m4-tunnel.json";
rmSync(home, { recursive: true, force: true }); rmSync(agents, { recursive: true, force: true }); rmSync(fakeBin, { recursive: true, force: true });
mkdirSync(data, { recursive: true }); mkdirSync(fakeBin, { recursive: true });
writeFileSync(join(data, "runtime.json"), JSON.stringify({ hubEnabled: true }));
writeFileSync(join(data, "creds.json"), JSON.stringify({ ghToken: "ghu_dummy0000000000000000000000000000000" }));
const shim = join(fakeBin, "devtunnel");
writeFileSync(shim, '#!/bin/sh\nexec node /app/e2e/docker/fake-devtunnel.mjs "$@"\n'); chmodSync(shim, 0o755);

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => { if (cond) { pass++; console.log(`  PASS ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = "http://127.0.0.1:7990", gateway = "http://127.0.0.1:7992";
const ready = async (url, n = 100) => { for (let i = 0; i < n; i++) { try { if ((await fetch(url)).ok) return true; } catch {} await sleep(100); } return false; };
let csrf = "";
async function get(path) { const r = await fetch(base + path); return { status: r.status, body: await r.json().catch(() => null) }; }
async function post(path, body = {}) { const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", origin: base, "x-cc-fleet-csrf": csrf }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; }
async function put(path, body) { const r = await fetch(base + path, { method: "PUT", headers: { "content-type": "application/json", origin: base, "x-cc-fleet-csrf": csrf }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; }

const supervisor = spawn("node", ["dist/supervisor/index.js"], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_HOME: join(home, ".claude"), AGENTS_HOME: agents, PATH: `${fakeBin}:${process.env.PATH}`, FAKE_DEVTUNNEL_STATE: fakeState },
});
let logs = ""; supervisor.stdout.on("data", (x) => logs += x); supervisor.stderr.on("data", (x) => logs += x);
try {
  console.log("\n=== boot and public boundary ===");
  ok("supervisor ready on 7990", await ready(base + "/api/status"), logs);
  ok("gateway ready on 7992", await ready(gateway + "/healthz"));
  csrf = (await get("/api/bootstrap")).body.csrfToken;
  ok("old supervisor port is closed", !(await ready("http://127.0.0.1:7890/api/status", 2)));
  ok("public dashboard is absent", (await fetch(gateway + "/")).status === 404);
  ok("public admin API is absent", (await fetch(gateway + "/api/status")).status === 404);

  console.log("\n=== tunnel lifecycle through real child process ===");
  const enabled = await post("/api/fleet/tunnel/enable");
  ok("fake persistent tunnel starts", enabled.status === 200);
  for (let i = 0; i < 50 && (await get("/api/fleet/tunnel/status")).body.state !== "online"; i++) await sleep(100);
  const online = (await get("/api/fleet/tunnel/status")).body;
  ok("tunnel becomes online", online.state === "online", JSON.stringify(online));
  ok("persistent URL uses gateway port", online.publicUrl === "https://docker-fleet-7992.devtunnels.ms");
  ok("fake cloud state has one 7992 port", JSON.parse(readFileSync(fakeState, "utf8")).ports[0].portNumber === 7992);
  await post("/api/fleet/tunnel/interrupt", { confirm: true });
  for (let i = 0; i < 80 && (await get("/api/fleet/tunnel/status")).body.state !== "online"; i++) await sleep(100);
  ok("host interruption reconnects same tunnel", (await get("/api/fleet/tunnel/status")).body.tunnelId === "docker-fleet.test");
  const staleDelete = await post("/api/fleet/tunnel/delete", { tunnelId: "stale", confirm: "DELETE stale" });
  ok("stale tunnel delete confirmation rejected", staleDelete.status === 400);
  const disabled = await post("/api/fleet/tunnel/disable");
  ok("disable keeps persistent cloud identity", disabled.status === 200 && existsSync(fakeState));
  ok("disable reports disabled", (await get("/api/fleet/tunnel/status")).body.state === "disabled");
  await post("/api/fleet/tunnel/enable");
  for (let i = 0; i < 50 && (await get("/api/fleet/tunnel/status")).body.state !== "online"; i++) await sleep(100);
  ok("re-enable reuses persistent tunnel", (await get("/api/fleet/tunnel/status")).body.tunnelId === "docker-fleet.test");

  console.log("\n=== WAN-shaped enrolment and local approval ===");
  const codeRes = await fetch(gateway + "/control/device/code", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hostname: "docker-node", os: "linux", agentVersion: "e2e" }) });
  const code = await codeRes.json();
  ok("node requests code through gateway", codeRes.status === 200 && Boolean(code.deviceCode));
  const enrolments = (await get("/api/fleet/enrolments")).body.enrolments;
  ok("request appears only on local admin", enrolments[0]?.hostname === "docker-node");
  ok("approval succeeds with CSRF", (await post(`/api/fleet/enrolments/${enrolments[0].requestId}/approve`, { confirm: true })).status === 200);
  const tokenRes = await fetch(gateway + "/control/device/token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceCode: code.deviceCode }) });
  const token = await tokenRes.json();
  ok("approved device redeems unique credential", tokenRes.status === 201 && token.deviceId === "docker-node" && Boolean(token.deviceToken));
  const reused = await fetch(gateway + "/control/device/token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceCode: code.deviceCode }) });
  ok("device code cannot be redeemed twice", reused.status === 401);
  const badIdentity = await fetch(gateway + "/control/device/code", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hostname: "x".repeat(129), os: "linux", agentVersion: "e2e" }) });
  ok("overlong identity rejected", badIdentity.status === 400);
  let limited = 0;
  for (let i = 0; i < 6; i++) limited = (await fetch(gateway + "/control/device/code", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.8" }, body: JSON.stringify({ hostname: `flood-${i}`, os: "linux", agentVersion: "e2e" }) })).status;
  ok("code issuance is rate limited", limited === 429);

  console.log("\n=== public LLM gate ===");
  const noKey = await fetch(gateway + "/anthropic/v1/messages", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  ok("missing key rejected", noKey.status === 401);
  const net = JSON.parse(readFileSync(join(data, "network.json"), "utf8"));
  const badKey = await fetch(gateway + "/openai/responses", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer wrong" }, body: "{}" });
  ok("wrong key rejected", badKey.status === 401);
  const validKey = await fetch(gateway + "/openai/models", { headers: { authorization: `Bearer ${net.key}` } });
  ok("valid key reaches worker", validKey.status === 200);
  ok("key rotation requires confirmation", (await post("/api/fleet/tunnel/rotate-key")).status === 400);
  const rotated = await post("/api/fleet/tunnel/rotate-key", { confirm: true });
  const net2 = JSON.parse(readFileSync(join(data, "network.json"), "utf8"));
  ok("confirmed key rotation increments revision", rotated.status === 200 && net2.keyRevision === net.keyRevision + 1);
  ok("old LLM key fails immediately", (await fetch(gateway + "/openai/models", { headers: { authorization: `Bearer ${net.key}` } })).status === 401);
  ok("new LLM key works immediately", (await fetch(gateway + "/openai/models", { headers: { authorization: `Bearer ${net2.key}` } })).status === 200);

  console.log("\n=== draft, conflict, publish and rollback ===");
  const live = (await get("/api/fleet/profile/live")).body;
  const draft = structuredClone(live.profile); draft.clients.claude.model = "claude-sonnet-5[1m]";
  ok("draft saves without publishing", (await put("/api/fleet/profile/draft", { profile: draft, baseRevision: live.revision })).status === 200);
  ok("live model unchanged before publish", (await get("/api/fleet/profile/live")).body.profile.clients.claude.model === "claude-opus-5[1m]");
  const preview = (await get("/api/fleet/profile/preview")).body;
  ok("preview identifies model change", JSON.stringify(preview).includes("claude-sonnet-5[1m]"));
  ok("publish requires confirmation", (await post("/api/fleet/profile/publish", { revision: live.revision })).status === 400);
  const published = await post("/api/fleet/profile/publish", { revision: live.revision, confirm: true });
  ok("confirmed publish increments version", published.status === 200 && published.body.version === live.profile.version + 1);
  ok("stale second publish conflicts", (await post("/api/fleet/profile/publish", { revision: live.revision, confirm: true })).status === 409);
  const history = (await get("/api/fleet/profile/history")).body.history;
  ok("history snapshot retained", history.length === 1);
  const current = (await get("/api/fleet/profile/live")).body;
  const rolled = await post("/api/fleet/profile/rollback", { historyId: history[0].id, revision: current.revision, confirm: true });
  ok("rollback publishes forward", rolled.status === 200 && rolled.body.version === current.profile.version + 1);

  console.log("\n=== cleanup ===");
  const id = (await get("/api/fleet/tunnel/status")).body.tunnelId;
  ok("confirmed cloud delete succeeds", (await post("/api/fleet/tunnel/delete", { tunnelId: id, confirm: `DELETE ${id}` })).status === 200);
  ok("fake cloud tunnel removed", !existsSync(fakeState));
} finally {
  supervisor.kill(); await sleep(300);
}
console.log(`\n=== M4 DOCKER SUMMARY ===\nPASS ${pass} FAIL ${fail}`);
process.exit(fail ? 1 : 0);

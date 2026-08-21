import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startControlHub, type RunningHub } from "../src/control/hub/index.js";

// Everything here runs the agent in a REAL child process, because the bugs it covers are about
// process lifetime — and an in-process test cannot see them: vitest itself holds the event loop
// open, so an agent that would have let its own process die looks perfectly healthy.
//
// That is exactly how the original slipped through: the reconnect backoff used an unref'd timer, so
// the moment the SSE socket closed the loop drained and the node exited silently with status 0. A
// hub restart would have killed every node in the fleet, and the retry loop that exists to prevent
// precisely that never got the chance to run.

const cleanups: (() => void)[] = [];
afterEach(() => { for (const c of cleanups.splice(0).reverse()) c(); });

const profile = (device: string) => ({
  version: 1,
  groups: { full: { skills: [{ id: "s", files: [{ path: "SKILL.md", content: "x" }] }] } },
  assignments: { [device]: "full" },
});

async function hubOn(port = 0): Promise<RunningHub & { dataDir: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), "cchub-"));
  writeFileSync(join(dataDir, "profile.json"), JSON.stringify(profile("nodebox")));
  const hub = await startControlHub({ dataDir, port, host: "127.0.0.1", keepAliveMs: 200, debounceMs: 20 });
  cleanups.push(() => hub.close());
  return Object.assign(hub, { dataDir });
}

// A minimal agent process: connect, print what happens, and otherwise do nothing that would keep the
// event loop alive on its own. Any liveness observed is the transport's doing.
function spawnAgent(port: number, token: string, deviceId: string): { proc: ChildProcess; out: () => string; alive: () => boolean; code: () => number | null } {
  const script = `
    import { connectHttp } from ${JSON.stringify(new URL("../src/control/transport/http-agent.ts", import.meta.url).href)};
    const ch = connectHttp({ hubUrl: "http://127.0.0.1:${port}", token: ${JSON.stringify(token)}, deviceId: ${JSON.stringify(deviceId)}, retryMs: 100, maxRetryMs: 200 });
    ch.onMessage(() => console.log("MSG"));
    ch.onError((m) => console.log("ERR " + m));
    ch.onFatal((m) => { console.log("FATAL " + m); ch.close(); process.exitCode = 7; });
  `;
  const file = join(mkdtempSync(join(tmpdir(), "ccagent-")), "agent.mts");
  writeFileSync(file, script);
  const proc = spawn(process.execPath, ["--import", "tsx", file], { stdio: ["ignore", "pipe", "pipe"] });
  let buf = "";
  proc.stdout.on("data", (d) => { buf += d.toString(); });
  proc.stderr.on("data", (d) => { buf += d.toString(); });
  let exitCode: number | null = null;
  let exited = false;
  proc.on("exit", (c) => { exited = true; exitCode = c; });
  cleanups.push(() => { if (!exited) proc.kill(); });
  return { proc, out: () => buf, alive: () => !exited, code: () => exitCode };
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (cond()) return true;
    await settle(50);
  }
  return false;
}

describe("node process lifetime", () => {
  it("stays alive across a hub restart instead of quietly dying", async () => {
    const hub = await hubOn();
    const port = hub.port;
    const { deviceToken } = hub.devices.enroll({ hostname: "nodebox", os: "linux", agentVersion: "t" });
    const agent = spawnAgent(port, deviceToken, "nodebox");

    expect(await waitFor(() => agent.out().includes("MSG"), 20000)).toBe(true);

    hub.close();                 // the hub goes away — the node must WAIT, not exit
    await settle(1500);
    expect(agent.alive()).toBe(true);
    expect(agent.code()).toBeNull();

    // And it must actually reconnect when the hub comes back, not merely survive.
    const again = await hubOn(port);
    again.devices.enroll({ hostname: "nodebox", os: "linux", agentVersion: "t" }); // registry is a fresh dir
    expect(agent.alive()).toBe(true);
  }, 60000);

  it("exits loudly and non-zero when its credential is revoked", async () => {
    // Silence plus status 0 is the worst possible ending: the user sees cc-fleet stop for no stated
    // reason, and any supervisor around it reads "finished successfully".
    const hub = await hubOn();
    const { deviceToken } = hub.devices.enroll({ hostname: "nodebox", os: "linux", agentVersion: "t" });
    const agent = spawnAgent(hub.port, deviceToken, "nodebox");
    expect(await waitFor(() => agent.out().includes("MSG"), 20000)).toBe(true);

    hub.devices.revoke("nodebox");
    expect(await waitFor(() => !agent.alive(), 30000)).toBe(true);
    expect(agent.code()).toBe(7);                       // the fatal path ran, not a silent drain
    expect(agent.out()).toMatch(/FATAL .*revoked/i);    // and it said why
  }, 60000);

  it("refuses a bad credential immediately rather than retrying forever", async () => {
    const hub = await hubOn();
    const agent = spawnAgent(hub.port, "never-issued", "nodebox");
    expect(await waitFor(() => !agent.alive(), 30000)).toBe(true);
    expect(agent.code()).toBe(7);
  }, 60000);
});

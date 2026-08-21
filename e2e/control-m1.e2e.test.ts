import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startControlHub, type RunningHub } from "../src/control/hub/index.js";
import { connectHttp } from "../src/control/transport/http-agent.js";
import { startAgent, type RunningAgent } from "../src/control/agent/agent.js";
import { listBackups } from "../src/control/agent/backup.js";

// The M1 tracer bullet, end to end over real HTTP: a hub holding a hand-written profile, a node that
// enrolls with a pre-shared token, and a skill that travels from one to the other and lands on disk.
//
// Two processes' worth of machinery in one test process, but a genuine network hop and genuine file
// mutation — no Copilot, no tunnel, no GitHub login. That combination is exactly what docs/design.md
// §2 buys, and this file is the proof it holds.

const DEVICE = "laptop-home";
const cleanups: (() => void)[] = [];
afterEach(() => { for (const c of cleanups.splice(0).reverse()) c(); });

const profile = (version: number, content: string, device = DEVICE) => ({
  version,
  groups: { full: { skills: [{ id: "code-review", files: [{ path: "SKILL.md", content }] }] } },
  assignments: { [device]: "full" },
});

async function hubWith(initial: unknown): Promise<RunningHub & { dataDir: string; writeProfile: (p: unknown) => void }> {
  const dataDir = mkdtempSync(join(tmpdir(), "cchub-"));
  writeFileSync(join(dataDir, "profile.json"), JSON.stringify(initial, null, 2));
  const hub = await startControlHub({ dataDir, port: 0, host: "127.0.0.1", keepAliveMs: 200, debounceMs: 20 });
  cleanups.push(() => hub.close());
  return Object.assign(hub, {
    dataDir,
    writeProfile: (p: unknown) => writeFileSync(join(dataDir, "profile.json"), JSON.stringify(p, null, 2)),
  });
}

// One credential per (hub, device) for the whole test, because a device that re-enrols is a
// DIFFERENT device: the second enrolment would be issued `laptop-home-2`, which the profile does not
// assign, so a reconnect case would silently test "unassigned" instead of what it claims to test.
// The plaintext token is only ever returned once, so it has to be remembered here.
const tokens = new Map<string, string>();
afterEach(() => tokens.clear());

function nodeFor(hub: RunningHub, claudeHome: string, deviceId = DEVICE): RunningAgent {
  // Enrol through the registry rather than the HTTP handshake: these cases are about apply and
  // takeover semantics. The handshake itself is exercised in control-m1.5.e2e.test.ts.
  const key = `${hub.port}:${deviceId}`;
  let token = tokens.get(key);
  if (!token) {
    token = hub.devices.enroll({ hostname: deviceId, os: "linux", agentVersion: "0.1.0-e2e" }).deviceToken;
    tokens.set(key, token);
  }
  const channel = connectHttp({ hubUrl: `http://127.0.0.1:${hub.port}`, token, deviceId, retryMs: 20, maxRetryMs: 100 });
  const agent = startAgent({ claudeHome, channel, deviceId, agentVersion: "0.1.0-e2e" });
  cleanups.push(() => { agent.stop(); channel.close(); });
  return agent;
}

const home = () => mkdtempSync(join(tmpdir(), "cchome-"));
const skillFile = (h: string) => join(h, "skills", "code-review", "SKILL.md");

describe("control M1 — hub to node over real HTTP", () => {
  it("delivers a skill from the hub's profile onto the node's disk", async () => {
    const hub = await hubWith(profile(1, "review carefully"));
    const h = home();
    const agent = nodeFor(hub, h);
    await vi.waitFor(() => expect(existsSync(skillFile(h))).toBe(true), { timeout: 10000 });
    expect(readFileSync(skillFile(h), "utf8")).toBe("review carefully");
    expect(agent.status()).toMatchObject({ state: "applied", version: 1 });
  }, 20000);

  it("propagates an edit to the profile within 5 seconds", async () => {
    // The M1 exit criterion from docs/design.md §11: hub edits a skill, node has it seconds later.
    const hub = await hubWith(profile(1, "v1"));
    const h = home();
    nodeFor(hub, h);
    await vi.waitFor(() => expect(readFileSync(skillFile(h), "utf8")).toBe("v1"), { timeout: 10000 });

    const editedAt = Date.now();
    hub.writeProfile(profile(2, "v2"));
    await vi.waitFor(() => expect(readFileSync(skillFile(h), "utf8")).toBe("v2"), { timeout: 5000 });
    expect(Date.now() - editedAt).toBeLessThan(5000);
  }, 20000);

  it("reports the applied version back to the hub", async () => {
    const hub = await hubWith(profile(3, "x"));
    nodeFor(hub, home());
    await vi.waitFor(() => expect(hub.hub.lastApplied(DEVICE)).toMatchObject({ version: 3, ok: true }), { timeout: 10000 });
  }, 20000);

  it("takes over: deletes an unmanaged skill and keeps it in a backup", async () => {
    const hub = await hubWith(profile(1, "managed"));
    const h = home();
    mkdirSync(join(h, "skills", "local-experiment"), { recursive: true });
    writeFileSync(join(h, "skills", "local-experiment", "SKILL.md"), "not in the profile");

    nodeFor(hub, h);
    await vi.waitFor(() => expect(existsSync(join(h, "skills", "local-experiment"))).toBe(false), { timeout: 10000 });

    const backups = listBackups(h);
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(backups[0], "skills", "local-experiment", "SKILL.md"), "utf8")).toBe("not in the profile");
  }, 20000);

  it("leaves an unassigned machine completely alone", async () => {
    // The fail-safe that matters most: a machine nobody registered must not be wiped by a hub it
    // happens to be able to reach.
    const hub = await hubWith(profile(1, "x", "some-other-box"));
    const h = home();
    mkdirSync(join(h, "skills", "mine"), { recursive: true });
    writeFileSync(join(h, "skills", "mine", "SKILL.md"), "my own");
    writeFileSync(join(h, "CLAUDE.md"), "my rules");

    const agent = nodeFor(hub, h);
    await vi.waitFor(() => expect(agent.status().state).toBe("unassigned"), { timeout: 10000 });
    expect(readFileSync(join(h, "skills", "mine", "SKILL.md"), "utf8")).toBe("my own");
    expect(readFileSync(join(h, "CLAUDE.md"), "utf8")).toBe("my rules");
    expect(listBackups(h)).toEqual([]);
  }, 20000);

  it("never touches anything outside skills/", async () => {
    const hub = await hubWith(profile(1, "managed"));
    const h = home();
    mkdirSync(join(h, "commands"), { recursive: true });
    mkdirSync(join(h, "projects"), { recursive: true });
    writeFileSync(join(h, "commands", "mine.md"), "my command");
    writeFileSync(join(h, "projects", "session.json"), "history");
    writeFileSync(join(h, "CLAUDE.md"), "my rules");
    writeFileSync(join(h, ".claude.json"), "creds");

    nodeFor(hub, h);
    await vi.waitFor(() => expect(existsSync(skillFile(h))).toBe(true), { timeout: 10000 });
    expect(readFileSync(join(h, "commands", "mine.md"), "utf8")).toBe("my command");
    expect(readFileSync(join(h, "projects", "session.json"), "utf8")).toBe("history");
    expect(readFileSync(join(h, "CLAUDE.md"), "utf8")).toBe("my rules");
    expect(readFileSync(join(h, ".claude.json"), "utf8")).toBe("creds");
  }, 20000);

  it("refuses a node presenting the wrong token", async () => {
    const hub = await hubWith(profile(1, "x"));
    const res = await fetch(`http://127.0.0.1:${hub.port}/control/events?deviceId=${DEVICE}`, {
      headers: { authorization: "Bearer not-the-token" },
    });
    expect(res.status).toBe(401);
    await res.body?.cancel();
  }, 20000);

  it("serves nothing while the profile on disk is invalid, and recovers when it is fixed", async () => {
    // A half-saved profile must never reach a node: apply is full-takeover, so a malformed edit that
    // parsed as "no skills" would wipe the fleet.
    const hub = await hubWith(profile(1, "good"));
    const h = home();
    nodeFor(hub, h);
    await vi.waitFor(() => expect(readFileSync(skillFile(h), "utf8")).toBe("good"), { timeout: 10000 });

    writeFileSync(join(hub.dataDir, "profile.json"), "{ half-written");
    await new Promise((r) => setTimeout(r, 300));
    expect(readFileSync(skillFile(h), "utf8")).toBe("good"); // last good state still in force

    hub.writeProfile(profile(2, "fixed"));
    await vi.waitFor(() => expect(readFileSync(skillFile(h), "utf8")).toBe("fixed"), { timeout: 5000 });
  }, 20000);

  it("catches a node up when it was offline during the edit", async () => {
    // design §5 accepts that a node offline during a change misses the push; the promise is that it
    // converges on reconnect. This is that promise, tested.
    const hub = await hubWith(profile(1, "v1"));
    const h = home();
    const first = nodeFor(hub, h);
    await vi.waitFor(() => expect(readFileSync(skillFile(h), "utf8")).toBe("v1"), { timeout: 10000 });
    first.stop();
    await new Promise((r) => setTimeout(r, 100));

    hub.writeProfile(profile(2, "missed-it"));
    await new Promise((r) => setTimeout(r, 300));
    expect(readFileSync(skillFile(h), "utf8")).toBe("v1"); // genuinely missed

    nodeFor(hub, h); // comes back
    await vi.waitFor(() => expect(readFileSync(skillFile(h), "utf8")).toBe("missed-it"), { timeout: 10000 });
  }, 30000);

  it("empties skills/ when the assigned group becomes empty", async () => {
    const hub = await hubWith(profile(1, "x"));
    const h = home();
    nodeFor(hub, h);
    await vi.waitFor(() => expect(existsSync(skillFile(h))).toBe(true), { timeout: 10000 });
    hub.writeProfile({ version: 2, groups: { full: { skills: [] } }, assignments: { [DEVICE]: "full" } });
    await vi.waitFor(() => expect(readdirSync(join(h, "skills"))).toEqual([]), { timeout: 5000 });
  }, 20000);
});

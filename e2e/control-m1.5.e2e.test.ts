import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startControlHub, type RunningHub } from "../src/control/hub/index.js";
import { connectHttp } from "../src/control/transport/http-agent.js";
import { requestDeviceCode, pollForToken } from "../src/control/agent/enroll-client.js";
import { startAgent } from "../src/control/agent/agent.js";

// The enrolment handshake, end to end over real HTTP: a machine ASKS to join, a human on the hub
// approves it, and only then does a per-device credential exist. That credential (and only that
// credential) opens the config stream, and revoking it ejects the machine from a running hub
// without restarting anything.
//
// This is the piece that has to be right before a hub is ever reachable from the public internet:
// M1 shipped ONE token for the whole fleet, which is both un-revokable and catastrophic to leak.

const cleanups: (() => void)[] = [];
afterEach(() => { for (const c of cleanups.splice(0).reverse()) c(); });

const profile = (content: string, ...devices: string[]) => ({
  version: 1,
  groups: { full: { skills: [{ id: "code-review", files: [{ path: "SKILL.md", content }] }] } },
  assignments: Object.fromEntries(devices.map((d) => [d, "full"])),
});

async function hubWith(initial: unknown): Promise<RunningHub & { dataDir: string; url: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), "cchub-"));
  writeFileSync(join(dataDir, "profile.json"), JSON.stringify(initial, null, 2));
  const hub = await startControlHub({ dataDir, port: 0, host: "127.0.0.1", keepAliveMs: 200, debounceMs: 20 });
  cleanups.push(() => hub.close());
  return Object.assign(hub, { dataDir, url: `http://127.0.0.1:${hub.port}` });
}

const home = () => ({ agents: mkdtempSync(join(tmpdir(), "agents-")), claude: mkdtempSync(join(tmpdir(), "claude-")) });
const skillFile = (h: { claude: string }) => join(h.claude, "skills", "code-review", "SKILL.md");

const ask = (url: string, hostname: string) =>
  requestDeviceCode({ hubUrl: url, hostname, os: "linux", agentVersion: "0.1.0-e2e" });

// The full round trip a `cc-fleet join` performs, with the operator's approval scripted and the
// polling sleeps collapsed — what is under test is the protocol, not the waiting.
async function join_(
  hub: RunningHub & { url: string },
  hostname: string,
  decide: (userCode: string) => void = (c) => { hub.auth.approve(c); },
) {
  const started = await ask(hub.url, hostname);
  if (!started.ok) return { ok: false as const, error: started.error };
  decide(started.start.userCode);
  return pollForToken({ hubUrl: hub.url, start: started.start, sleep: async () => {} });
}

function runNode(hub: RunningHub, home: { agents: string; claude: string }, deviceId: string, token: string) {
  const channel = connectHttp({ hubUrl: `http://127.0.0.1:${hub.port}`, token, deviceId, retryMs: 20, maxRetryMs: 100 });
  const agent = startAgent({ agentsHome: home.agents, claudeHome: home.claude, channel, deviceId, agentVersion: "0.1.0-e2e" });
  cleanups.push(() => { agent.stop(); channel.close(); });
  return agent;
}

describe("control — enrolment handshake", () => {
  it("turns an approved request into a working node", async () => {
    const hub = await hubWith(profile("reviewed", "laptop-home"));
    const enrolled = await join_(hub, "laptop-home");
    expect(enrolled.ok).toBe(true);
    if (!enrolled.ok) return;

    const h = home();
    runNode(hub, h, enrolled.deviceId, enrolled.deviceToken);
    await vi.waitFor(() => expect(existsSync(skillFile(h))).toBe(true), { timeout: 10000 });
    expect(readFileSync(skillFile(h), "utf8")).toBe("reviewed");
  }, 20000);

  it("issues nothing to a machine nobody approved", async () => {
    // Reaching the hub over the network is not consent. Until a human acts, the asking machine gets
    // a "keep waiting" and the fleet has gained no member.
    const hub = await hubWith(profile("x", "stranger"));
    const started = await ask(hub.url, "stranger");
    if (!started.ok) throw new Error(started.error);
    const res = await fetch(`${hub.url}/control/device/token`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceCode: started.start.deviceCode }),
    });
    expect(res.status).toBe(428);
    expect(hub.devices.list()).toEqual([]);
  }, 20000);

  it("shows the operator what they are approving before they approve it", async () => {
    // A bare "approve Y/N" invites reflex approval; the hostname is the only thing separating the
    // machine you just set up from one you did not.
    const hub = await hubWith(profile("x", "vm-azure"));
    await ask(hub.url, "vm-azure");
    expect(hub.auth.listPending().map((r) => r.hostname)).toEqual(["vm-azure"]);
  }, 20000);

  it("lets the operator refuse, and the node stops instead of retrying", async () => {
    const hub = await hubWith(profile("x", "stranger"));
    const denied = await join_(hub, "stranger", (c) => { hub.auth.deny(c); });
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.error).toMatch(/denied/);
    expect(hub.devices.list()).toEqual([]);
  }, 20000);

  it("spends the device code — it cannot be redeemed twice", async () => {
    const hub = await hubWith(profile("x", "a"));
    const started = await ask(hub.url, "a");
    if (!started.ok) throw new Error(started.error);
    hub.auth.approve(started.start.userCode);
    expect((await pollForToken({ hubUrl: hub.url, start: started.start, sleep: async () => {} })).ok).toBe(true);

    const again = await fetch(`${hub.url}/control/device/token`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceCode: started.start.deviceCode }),
    });
    expect(again.status).toBe(401);
  }, 20000);

  it("tells an attacker nothing about which device codes exist", async () => {
    // Spent and never-issued must be indistinguishable, or a blind guess becomes a query.
    const hub = await hubWith(profile("x", "a"));
    const started = await ask(hub.url, "a");
    if (!started.ok) throw new Error(started.error);
    hub.auth.approve(started.start.userCode);
    await pollForToken({ hubUrl: hub.url, start: started.start, sleep: async () => {} });

    const post = (deviceCode: string) => fetch(`${hub.url}/control/device/token`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceCode }),
    });
    const spent = await post(started.start.deviceCode);
    const wrong = await post("never-issued-at-all");
    expect(spent.status).toBe(wrong.status);
    expect(await spent.json()).toEqual(await wrong.json());
  }, 20000);

  it("gives each machine a credential that works only for itself", async () => {
    const hub = await hubWith(profile("x", "alpha", "beta"));
    const a = await join_(hub, "alpha");
    const b = await join_(hub, "beta");
    if (!a.ok || !b.ok) throw new Error("enrolment failed");
    expect(a.deviceToken).not.toBe(b.deviceToken);

    const res = await fetch(`${hub.url}/control/events?deviceId=beta`, {
      headers: { authorization: `Bearer ${a.deviceToken}` },
    });
    expect(res.status).toBe(403); // a valid token is not a licence to be someone else
    await res.body?.cancel();
  }, 20000);

  it("never writes the token, or the device code, to disk on the hub", async () => {
    const hub = await hubWith(profile("x", "laptop-home"));
    const started = await ask(hub.url, "laptop-home");
    if (!started.ok) throw new Error(started.error);
    hub.auth.approve(started.start.userCode);
    const enrolled = await pollForToken({ hubUrl: hub.url, start: started.start, sleep: async () => {} });
    if (!enrolled.ok) throw new Error(enrolled.error);

    expect(readFileSync(join(hub.dataDir, "devices.json"), "utf8")).not.toContain(enrolled.deviceToken);
    expect(readFileSync(join(hub.dataDir, "device-auth.json"), "utf8")).not.toContain(started.start.deviceCode);
  }, 20000);

  it("enrols a second machine without restarting the hub", async () => {
    // The old flow minted codes at startup only, so adding a machine meant bouncing the hub — and a
    // control plane you must restart to grow is one people leave running with a shared secret.
    const hub = await hubWith(profile("x", "alpha", "beta"));
    expect((await join_(hub, "alpha")).ok).toBe(true);
    expect((await join_(hub, "beta")).ok).toBe(true);
    expect(hub.devices.list().map((d) => d.deviceId).sort()).toEqual(["alpha", "beta"]);
  }, 20000);
});

describe("control — revocation", () => {
  it("ejects a live node from a running hub, without a restart", async () => {
    // `cc-fleet revoke` is a different process from the hub. If revocation only took effect on
    // restart, the one moment you need it most — a machine you no longer trust, still connected —
    // would be the moment it does not work.
    const hub = await hubWith(profile("x", "laptop-home"));
    const enrolled = await join_(hub, "laptop-home");
    if (!enrolled.ok) throw new Error(enrolled.error);
    runNode(hub, home(), enrolled.deviceId, enrolled.deviceToken);
    await vi.waitFor(() => expect(hub.hub.deviceIds()).toContain("laptop-home"), { timeout: 10000 });

    hub.devices.revoke("laptop-home");
    await vi.waitFor(() => expect(hub.hub.deviceIds()).not.toContain("laptop-home"), { timeout: 15000 });

    const res = await fetch(`${hub.url}/control/events?deviceId=laptop-home`, {
      headers: { authorization: `Bearer ${enrolled.deviceToken}` },
    });
    expect(res.status).toBe(401); // and it cannot come back
    await res.body?.cancel();
  }, 40000);

  it("leaves the fleet's other machines alone", async () => {
    const hub = await hubWith(profile("x", "alpha", "beta"));
    const a = await join_(hub, "alpha");
    const b = await join_(hub, "beta");
    if (!a.ok || !b.ok) throw new Error("enrolment failed");
    runNode(hub, home(), a.deviceId, a.deviceToken);
    runNode(hub, home(), b.deviceId, b.deviceToken);
    await vi.waitFor(() => expect(hub.hub.deviceIds().sort()).toEqual(["alpha", "beta"]), { timeout: 10000 });

    hub.devices.revoke("alpha");
    await vi.waitFor(() => expect(hub.hub.deviceIds()).toEqual(["beta"]), { timeout: 15000 });
  }, 40000);

  it("keeps the revoked record, and lets the machine re-enrol as a new one", async () => {
    const hub = await hubWith(profile("x", "laptop-home"));
    const first = await join_(hub, "laptop-home");
    if (!first.ok) throw new Error(first.error);
    hub.devices.revoke(first.deviceId);

    const second = await join_(hub, "laptop-home");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.deviceToken).not.toBe(first.deviceToken);
    expect(hub.devices.list().filter((d) => d.revokedAt !== null)).toHaveLength(1); // audit trail kept
  }, 20000);
});

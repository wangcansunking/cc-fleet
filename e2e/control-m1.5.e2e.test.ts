import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startControlHub, type RunningHub } from "../src/control/hub/index.js";
import { connectHttp } from "../src/control/transport/http-agent.js";
import { enrollNode } from "../src/control/agent/enroll-client.js";
import { startAgent } from "../src/control/agent/agent.js";

// The M1.5 handshake, end to end over real HTTP: a one-time code becomes a per-device credential,
// that credential (and only that credential) opens the config stream, and revoking it ejects the
// machine from a running hub without restarting anything.
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

const home = () => mkdtempSync(join(tmpdir(), "cchome-"));
const skillFile = (h: string) => join(h, "skills", "code-review", "SKILL.md");

const join_ = (url: string, code: string, hostname: string) =>
  enrollNode({ hubUrl: url, code, hostname, os: "linux", agentVersion: "0.1.0-e2e" });

function runNode(hub: RunningHub, home: string, deviceId: string, token: string) {
  const channel = connectHttp({ hubUrl: `http://127.0.0.1:${hub.port}`, token, deviceId, retryMs: 20, maxRetryMs: 100 });
  const agent = startAgent({ claudeHome: home, channel, deviceId, agentVersion: "0.1.0-e2e" });
  cleanups.push(() => { agent.stop(); channel.close(); });
  return agent;
}

describe("control M1.5 — enrolment handshake", () => {
  it("turns a one-time code into a working node", async () => {
    const hub = await hubWith(profile("reviewed", "laptop-home"));
    const enrolled = await join_(hub.url, hub.mintCode(), "laptop-home");
    expect(enrolled.ok).toBe(true);
    if (!enrolled.ok) return;

    const h = home();
    runNode(hub, h, enrolled.deviceId, enrolled.deviceToken);
    await vi.waitFor(() => expect(existsSync(skillFile(h))).toBe(true), { timeout: 10000 });
    expect(readFileSync(skillFile(h), "utf8")).toBe("reviewed");
  }, 20000);

  it("spends the code — a second machine cannot reuse it", async () => {
    const hub = await hubWith(profile("x", "a", "b"));
    const code = hub.mintCode();
    expect((await join_(hub.url, code, "a")).ok).toBe(true);
    const second = await join_(hub.url, code, "b");
    expect(second.ok).toBe(false);
  }, 20000);

  it("tells an attacker nothing about which codes exist", async () => {
    // Wrong, expired and already-spent must be indistinguishable, or a blind guess becomes a query.
    const hub = await hubWith(profile("x", "a"));
    const code = hub.mintCode();
    await join_(hub.url, code, "a");
    const spent = await join_(hub.url, code, "b");
    const wrong = await join_(hub.url, "ZZZZ-ZZZZ", "b");
    expect(spent.ok).toBe(false);
    expect(wrong.ok).toBe(false);
    if (spent.ok || wrong.ok) return;
    expect(spent.error).toBe(wrong.error);
  }, 20000);

  it("gives each machine a credential that works only for itself", async () => {
    const hub = await hubWith(profile("x", "alpha", "beta"));
    const a = await join_(hub.url, hub.mintCode(), "alpha");
    const b = await join_(hub.url, hub.mintCode(), "beta");
    if (!a.ok || !b.ok) throw new Error("enrolment failed");
    expect(a.deviceToken).not.toBe(b.deviceToken);

    const res = await fetch(`${hub.url}/control/events?deviceId=beta`, {
      headers: { authorization: `Bearer ${a.deviceToken}` },
    });
    expect(res.status).toBe(403); // a valid token is not a licence to be someone else
    await res.body?.cancel();
  }, 20000);

  it("never writes the token to disk on the hub", async () => {
    const hub = await hubWith(profile("x", "laptop-home"));
    const enrolled = await join_(hub.url, hub.mintCode(), "laptop-home");
    if (!enrolled.ok) throw new Error(enrolled.error);
    const raw = readFileSync(join(hub.dataDir, "devices.json"), "utf8");
    expect(raw).not.toContain(enrolled.deviceToken);
  }, 20000);
});

describe("control M1.5 — revocation", () => {
  it("ejects a live node from a running hub, without a restart", async () => {
    // `cc-fleet revoke` is a different process from the hub. If revocation only took effect on
    // restart, the one moment you need it most — a machine you no longer trust, still connected —
    // would be the moment it does not work.
    const hub = await hubWith(profile("x", "laptop-home"));
    const enrolled = await join_(hub.url, hub.mintCode(), "laptop-home");
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
    const a = await join_(hub.url, hub.mintCode(), "alpha");
    const b = await join_(hub.url, hub.mintCode(), "beta");
    if (!a.ok || !b.ok) throw new Error("enrolment failed");
    runNode(hub, home(), a.deviceId, a.deviceToken);
    runNode(hub, home(), b.deviceId, b.deviceToken);
    await vi.waitFor(() => expect(hub.hub.deviceIds().sort()).toEqual(["alpha", "beta"]), { timeout: 10000 });

    hub.devices.revoke("alpha");
    await vi.waitFor(() => expect(hub.hub.deviceIds()).toEqual(["beta"]), { timeout: 15000 });
  }, 40000);

  it("keeps the revoked record, and lets the machine re-enrol as a new one", async () => {
    const hub = await hubWith(profile("x", "laptop-home"));
    const first = await join_(hub.url, hub.mintCode(), "laptop-home");
    if (!first.ok) throw new Error(first.error);
    hub.devices.revoke(first.deviceId);

    const second = await join_(hub.url, hub.mintCode(), "laptop-home");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.deviceToken).not.toBe(first.deviceToken);
    expect(hub.devices.list().filter((d) => d.revokedAt !== null)).toHaveLength(1); // audit trail kept
  }, 20000);
});

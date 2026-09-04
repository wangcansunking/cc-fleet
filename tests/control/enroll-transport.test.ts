import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../../src/control/hub/hub.js";
import { DeviceRegistry } from "../../src/control/hub/devices.js";
import { DeviceAuthRequests } from "../../src/control/hub/device-auth.js";
import { startHubServer } from "../../src/control/transport/http-hub.js";
import { connectHttp } from "../../src/control/transport/http-agent.js";
import { requestDeviceCode, pollForToken } from "../../src/control/agent/enroll-client.js";
import { parseProfile, type Profile } from "../../src/control/proto/index.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

function profile(): Profile {
  const r = parseProfile({
    version: 1,
    groups: { full: { skills: [{ id: "s", files: [{ path: "SKILL.md", content: "v1" }] }] } },
    assignments: { "laptop-home": "full" },
  });
  if (!r.ok) throw new Error(r.error);
  return r.profile;
}

async function serve() {
  const dataDir = mkdtempSync(join(tmpdir(), "ccdata-"));
  const devices = new DeviceRegistry(dataDir);
  const auth = new DeviceAuthRequests(dataDir);
  const hub = new Hub(() => profile());
  const server = await startHubServer({ dataDir, hub, devices, auth, port: 0, host: "127.0.0.1", keepAliveMs: 50 });
  cleanups.push(() => server.close());
  return { dataDir, devices, auth, hub, server, url: `http://127.0.0.1:${server.port}` };
}

// Drive the whole handshake the way a real node does — ask, get approved, poll — but with the sleeps
// collapsed, so the test measures the protocol rather than the wait.
async function enrol(
  url: string,
  auth: DeviceAuthRequests,
  hostname = "laptop-home",
  decide: (userCode: string) => void = (c) => { auth.approve(c); },
) {
  const started = await requestDeviceCode({ hubUrl: url, hostname, os: "linux", agentVersion: "0.1.0-test" });
  if (!started.ok) return { ok: false as const, error: started.error };
  decide(started.start.userCode);
  return pollForToken({ hubUrl: url, start: started.start, sleep: async () => {} });
}

describe("device authorization over HTTP", () => {
  it("turns an approved request into a device id and token", async () => {
    const { url, auth } = await serve();
    const r = await enrol(url, auth);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.deviceId).toBe("laptop-home");
    expect(r.deviceToken.length).toBeGreaterThan(20);
  });

  it("issues nothing at all until a human approves", async () => {
    // The whole point of the flow: reaching the hub over the network is not consent.
    const { url, auth, devices } = await serve();
    const started = await requestDeviceCode({ hubUrl: url, hostname: "laptop-home", os: "linux", agentVersion: "0.1.0-test" });
    if (!started.ok) throw new Error(started.error);
    const res = await fetch(`${url}/control/device/token`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceCode: started.start.deviceCode }),
    });
    expect(res.status).toBe(428);
    expect(await res.json()).toEqual({ error: "authorization_pending" });
    expect(devices.list()).toEqual([]);
    expect(auth.listPending()).toHaveLength(1);
  });

  it("stops rather than retries when the request is denied", async () => {
    const { url, auth, devices } = await serve();
    const r = await enrol(url, auth, "laptop-home", (c) => { auth.deny(c); });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/denied/);
    expect(devices.list()).toEqual([]);
  });

  it("refuses to spend the same device code twice", async () => {
    const { url, auth } = await serve();
    const started = await requestDeviceCode({ hubUrl: url, hostname: "laptop-home", os: "linux", agentVersion: "0.1.0-test" });
    if (!started.ok) throw new Error(started.error);
    auth.approve(started.start.userCode);
    const first = await pollForToken({ hubUrl: url, start: started.start, sleep: async () => {} });
    expect(first.ok).toBe(true);

    const again = await fetch(`${url}/control/device/token`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceCode: started.start.deviceCode }),
    });
    expect(again.status).toBe(401);
    expect(await again.json()).toEqual({ error: "invalid_grant" });
  });

  it("says the same thing for a spent device code as for one that never existed", async () => {
    // Anything that distinguishes them turns a blind guess into a query about which codes were real.
    const { url, auth } = await serve();
    const started = await requestDeviceCode({ hubUrl: url, hostname: "h", os: "linux", agentVersion: "1" });
    if (!started.ok) throw new Error(started.error);
    auth.approve(started.start.userCode);
    await pollForToken({ hubUrl: url, start: started.start, sleep: async () => {} });

    const post = (deviceCode: string) => fetch(`${url}/control/device/token`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceCode }),
    });
    const spent = await post(started.start.deviceCode);
    const bogus = await post("never-issued");
    expect(spent.status).toBe(bogus.status);
    expect(await spent.json()).toEqual(await bogus.json());
  });

  it("tells an impatient node to slow down instead of serving it", async () => {
    const { url } = await serve();
    const started = await requestDeviceCode({ hubUrl: url, hostname: "h", os: "linux", agentVersion: "1" });
    if (!started.ok) throw new Error(started.error);
    const post = () => fetch(`${url}/control/device/token`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceCode: started.start.deviceCode }),
    });
    expect((await post()).status).toBe(428);
    const hammered = await post();
    expect(hammered.status).toBe(429);
    expect(await hammered.json()).toEqual({ error: "slow_down" });
  });

  it("keeps waiting through a slow_down rather than giving up", async () => {
    // The hub is asking for patience, not rejecting the node; a client that treats it as failure
    // would abandon an enrolment the operator is about to approve. The 429 is injected rather than
    // provoked so the test measures the client's reaction, not the wall clock.
    const { url, auth } = await serve();
    const started = await requestDeviceCode({ hubUrl: url, hostname: "laptop-home", os: "linux", agentVersion: "1" });
    if (!started.ok) throw new Error(started.error);
    auth.approve(started.start.userCode);

    let firstCall = true;
    const throttleOnce: typeof fetch = (input, init) => {
      if (firstCall) {
        firstCall = false;
        return Promise.resolve(new Response(JSON.stringify({ error: "slow_down" }), {
          status: 429, headers: { "content-type": "application/json" },
        }));
      }
      return fetch(input, init);
    };

    let waits = 0;
    const slept: number[] = [];
    const r = await pollForToken({
      hubUrl: url, start: started.start, fetchImpl: throttleOnce,
      sleep: async (ms) => { slept.push(ms); },
      onWaiting: () => { waits += 1; },
    });
    expect(r.ok).toBe(true);
    expect(waits).toBe(1);
    // And it backs off rather than immediately hammering the same endpoint again.
    expect(slept[1]).toBeGreaterThan(slept[0]);
  }, 20000);

  it("rejects oversized or overlong public enrolment identity before persisting it", async () => {
    const { url, auth } = await serve();
    const overlong = await fetch(`${url}/control/device/code`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostname: "h".repeat(129), os: "linux", agentVersion: "1" }),
    });
    expect(overlong.status).toBe(400);
    const oversized = await fetch(`${url}/control/device/code`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostname: "h", os: "linux", agentVersion: "x".repeat(70_000) }),
    });
    expect(oversized.status).toBe(413);
    expect(auth.listPending()).toEqual([]);
  });

  it("rate limits public device-code issuance per source", async () => {
    const { url, auth } = await serve();
    const post = () => fetch(`${url}/control/device/code`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostname: "h", os: "linux", agentVersion: "1" }),
    });
    for (let i = 0; i < 5; i++) expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(429);
    expect(auth.listPending()).toHaveLength(5);
  });

  it("rejects a request body with no machine details, without recording anything", async () => {
    const { url, auth } = await serve();
    const res = await fetch(`${url}/control/device/code`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostname: "laptop-home" }), // no os/agentVersion
    });
    expect(res.status).toBe(400);
    expect(auth.listPending()).toEqual([]);
  });

  it("needs no bearer token — a machine that has not enrolled has nothing to authenticate with", async () => {
    const { url } = await serve();
    const res = await fetch(`${url}/control/device/code`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostname: "h", os: "linux", agentVersion: "1" }),
    });
    expect(res.status).toBe(200);
  });

  it("shows the operator which machine is asking, before they approve it", async () => {
    const { url, auth } = await serve();
    await requestDeviceCode({ hubUrl: url, hostname: "vm-azure", os: "linux", agentVersion: "9.9.9" });
    expect(auth.listPending()[0]).toMatchObject({ hostname: "vm-azure", os: "linux", agentVersion: "9.9.9" });
  });
});

describe("per-device auth replaces the shared token", () => {
  it("lets an enrolled device open the event stream", async () => {
    const { url, auth } = await serve();
    const r = await enrol(url, auth);
    if (!r.ok) throw new Error(r.error);
    const seen: unknown[] = [];
    const ch = connectHttp({ hubUrl: url, token: r.deviceToken, deviceId: r.deviceId });
    cleanups.push(() => ch.close());
    ch.onMessage((m) => seen.push(m));
    await vi.waitFor(() => expect(seen).toHaveLength(1), { timeout: 5000 });
  });

  it("refuses a token that was never issued", async () => {
    const { url } = await serve();
    const res = await fetch(`${url}/control/events?deviceId=laptop-home`, {
      headers: { authorization: "Bearer made-up" },
    });
    expect(res.status).toBe(401);
    await res.body?.cancel();
  });

  it("refuses one device's token used under another device's id", async () => {
    // Otherwise any enrolled machine could impersonate any other and pull down its desired state.
    const { url, auth } = await serve();
    const a = await enrol(url, auth, "alpha");
    await enrol(url, auth, "beta");
    if (!a.ok) throw new Error(a.error);
    const res = await fetch(`${url}/control/events?deviceId=beta`, {
      headers: { authorization: `Bearer ${a.deviceToken}` },
    });
    expect(res.status).toBe(403);
    await res.body?.cancel();
  });

  it("refuses everything when no device has ever enrolled", async () => {
    const { url } = await serve();
    const res = await fetch(`${url}/control/events?deviceId=whoever`, {
      headers: { authorization: "Bearer anything" },
    });
    expect(res.status).toBe(401);
    await res.body?.cancel();
  });

  it("records that the device was seen", async () => {
    const { url, auth, devices } = await serve();
    const r = await enrol(url, auth);
    if (!r.ok) throw new Error(r.error);
    const before = devices.list()[0].lastSeenAt;
    await new Promise((res) => setTimeout(res, 5));
    const ch = connectHttp({ hubUrl: url, token: r.deviceToken, deviceId: r.deviceId });
    cleanups.push(() => ch.close());
    await vi.waitFor(() => expect(devices.list()[0].lastSeenAt).toBeGreaterThanOrEqual(before), { timeout: 5000 });
  });
});

describe("revocation", () => {
  it("cuts off a live connection the moment the device is revoked", async () => {
    // A revoked machine that keeps its existing stream is still being managed. Revocation has to
    // reach the connection, not just future requests.
    const { url, auth, devices, hub } = await serve();
    const r = await enrol(url, auth);
    if (!r.ok) throw new Error(r.error);
    const ch = connectHttp({ hubUrl: url, token: r.deviceToken, deviceId: r.deviceId, retryMs: 10_000 });
    cleanups.push(() => ch.close());
    await vi.waitFor(() => expect(hub.deviceIds()).toContain("laptop-home"), { timeout: 5000 });

    devices.revoke("laptop-home");
    await vi.waitFor(() => expect(hub.deviceIds()).not.toContain("laptop-home"), { timeout: 10_000 });
  }, 20000);

  it("refuses the revoked token on reconnect", async () => {
    const { url, auth, devices } = await serve();
    const r = await enrol(url, auth);
    if (!r.ok) throw new Error(r.error);
    devices.revoke(r.deviceId);
    const res = await fetch(`${url}/control/events?deviceId=${r.deviceId}`, {
      headers: { authorization: `Bearer ${r.deviceToken}` },
    });
    expect(res.status).toBe(401);
    await res.body?.cancel();
  });

  it("leaves other devices connected", async () => {
    const { url, auth, devices, hub } = await serve();
    const a = await enrol(url, auth, "alpha");
    const b = await enrol(url, auth, "beta");
    if (!a.ok || !b.ok) throw new Error("enrol failed");
    const ca = connectHttp({ hubUrl: url, token: a.deviceToken, deviceId: a.deviceId, retryMs: 10_000 });
    const cb = connectHttp({ hubUrl: url, token: b.deviceToken, deviceId: b.deviceId, retryMs: 10_000 });
    cleanups.push(() => { ca.close(); cb.close(); });
    await vi.waitFor(() => expect(hub.deviceIds().sort()).toEqual(["alpha", "beta"]), { timeout: 5000 });

    devices.revoke("alpha");
    await vi.waitFor(() => expect(hub.deviceIds()).toEqual(["beta"]), { timeout: 10_000 });
  }, 20000);

  it("refuses a revoked device's posts too, not just its stream", async () => {
    const { url, auth, devices } = await serve();
    const r = await enrol(url, auth);
    if (!r.ok) throw new Error(r.error);
    devices.revoke(r.deviceId);
    const res = await fetch(`${url}/control/msg?deviceId=${r.deviceId}`, {
      method: "POST",
      headers: { authorization: `Bearer ${r.deviceToken}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });
});

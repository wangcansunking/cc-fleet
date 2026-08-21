import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../../src/control/hub/hub.js";
import { DeviceRegistry } from "../../src/control/hub/devices.js";
import { EnrollCodes } from "../../src/control/hub/enroll.js";
import { startHubServer } from "../../src/control/transport/http-hub.js";
import { connectHttp } from "../../src/control/transport/http-agent.js";
import { enrollNode } from "../../src/control/agent/enroll-client.js";
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
  const codes = new EnrollCodes();
  const hub = new Hub(() => profile());
  const server = await startHubServer({ dataDir, hub, devices, codes, port: 0, host: "127.0.0.1", keepAliveMs: 50 });
  cleanups.push(() => server.close());
  return { dataDir, devices, codes, hub, server, url: `http://127.0.0.1:${server.port}` };
}

const enroll = (url: string, code: string, hostname = "laptop-home") =>
  enrollNode({ hubUrl: url, code, hostname, os: "linux", agentVersion: "0.1.0-test" });

describe("enroll endpoint", () => {
  it("exchanges a valid code for a device id and token", async () => {
    const { url, codes } = await serve();
    const r = await enroll(url, codes.mint());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.deviceId).toBe("laptop-home");
    expect(r.deviceToken.length).toBeGreaterThan(20);
  });

  it("refuses to spend the same code twice", async () => {
    const { url, codes } = await serve();
    const code = codes.mint();
    expect((await enroll(url, code, "first")).ok).toBe(true);
    expect((await enroll(url, code, "second")).ok).toBe(false);
  });

  it("refuses an unknown code", async () => {
    const { url } = await serve();
    expect((await enroll(url, "ZZZZ-ZZZZ")).ok).toBe(false);
  });

  it("says the same thing for an unknown code as for a spent one", async () => {
    // Anything that distinguishes them turns a blind guess into a query about which codes existed.
    const { url, codes } = await serve();
    const code = codes.mint();
    await enroll(url, code);
    const spent = await enroll(url, code);
    const unknown = await enroll(url, "ZZZZ-ZZZZ");
    expect(spent.ok).toBe(false);
    expect(unknown.ok).toBe(false);
    if (spent.ok || unknown.ok) return;
    expect(spent.error).toBe(unknown.error);
  });

  it("rejects a malformed enrolment body without enrolling anything", async () => {
    const { url, devices, codes } = await serve();
    const res = await fetch(`${url}/control/enroll`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: codes.mint() }), // no hostname/os/agentVersion
    });
    expect(res.status).toBe(400);
    expect(devices.list()).toEqual([]);
  });

  it("needs no bearer token — the code IS the credential", async () => {
    const { url, codes } = await serve();
    const res = await fetch(`${url}/control/enroll`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: codes.mint(), hostname: "h", os: "linux", agentVersion: "1" }),
    });
    expect(res.status).toBe(201);
  });
});

describe("per-device auth replaces the shared token", () => {
  it("lets an enrolled device open the event stream", async () => {
    const { url, codes } = await serve();
    const r = await enroll(url, codes.mint());
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
    const { url, codes } = await serve();
    const a = await enroll(url, codes.mint(), "alpha");
    await enroll(url, codes.mint(), "beta");
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
    const { url, codes, devices } = await serve();
    const r = await enroll(url, codes.mint());
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
    const { url, codes, devices, hub } = await serve();
    const r = await enroll(url, codes.mint());
    if (!r.ok) throw new Error(r.error);
    const ch = connectHttp({ hubUrl: url, token: r.deviceToken, deviceId: r.deviceId, retryMs: 10_000 });
    cleanups.push(() => ch.close());
    await vi.waitFor(() => expect(hub.deviceIds()).toContain("laptop-home"), { timeout: 5000 });

    devices.revoke("laptop-home");
    await vi.waitFor(() => expect(hub.deviceIds()).not.toContain("laptop-home"), { timeout: 10_000 });
  }, 20000);

  it("refuses the revoked token on reconnect", async () => {
    const { url, codes, devices } = await serve();
    const r = await enroll(url, codes.mint());
    if (!r.ok) throw new Error(r.error);
    devices.revoke(r.deviceId);
    const res = await fetch(`${url}/control/events?deviceId=${r.deviceId}`, {
      headers: { authorization: `Bearer ${r.deviceToken}` },
    });
    expect(res.status).toBe(401);
    await res.body?.cancel();
  });

  it("leaves other devices connected", async () => {
    const { url, codes, devices, hub } = await serve();
    const a = await enroll(url, codes.mint(), "alpha");
    const b = await enroll(url, codes.mint(), "beta");
    if (!a.ok || !b.ok) throw new Error("enrol failed");
    const ca = connectHttp({ hubUrl: url, token: a.deviceToken, deviceId: a.deviceId, retryMs: 10_000 });
    const cb = connectHttp({ hubUrl: url, token: b.deviceToken, deviceId: b.deviceId, retryMs: 10_000 });
    cleanups.push(() => { ca.close(); cb.close(); });
    await vi.waitFor(() => expect(hub.deviceIds().sort()).toEqual(["alpha", "beta"]), { timeout: 5000 });

    devices.revoke("alpha");
    await vi.waitFor(() => expect(hub.deviceIds()).toEqual(["beta"]), { timeout: 10_000 });
  }, 20000);

  it("refuses a revoked device's posts too, not just its stream", async () => {
    const { url, codes, devices } = await serve();
    const r = await enroll(url, codes.mint());
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

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../../src/control/hub/hub.js";
import { ensureHubToken } from "../../src/control/hub/auth.js";
import { startHubServer } from "../../src/control/transport/http-hub.js";
import { connectHttp } from "../../src/control/transport/http-agent.js";
import { PROTO_VERSION, parseProfile, type Profile } from "../../src/control/proto/index.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

function profile(over: Record<string, unknown> = {}): Profile {
  const r = parseProfile({
    version: 1,
    groups: { full: { skills: [{ id: "s", files: [{ path: "SKILL.md", content: "v1" }] }] } },
    assignments: { "laptop-home": "full" },
    ...over,
  });
  if (!r.ok) throw new Error(r.error);
  return r.profile;
}

async function serve(getProfile: () => Profile | null = () => profile()) {
  const dataDir = mkdtempSync(join(tmpdir(), "ccdata-"));
  const token = ensureHubToken(dataDir);
  const hub = new Hub(getProfile);
  const server = await startHubServer({ dataDir, hub, port: 0, host: "127.0.0.1", keepAliveMs: 50 });
  cleanups.push(() => server.close());
  return { dataDir, token, hub, server, url: `http://127.0.0.1:${server.port}` };
}

describe("http transport — auth (fail-closed)", () => {
  it("rejects the event stream without a token", async () => {
    const { url } = await serve();
    const res = await fetch(`${url}/control/events?deviceId=laptop-home`);
    expect(res.status).toBe(401);
    await res.body?.cancel();
  });

  it("rejects the event stream with the wrong token", async () => {
    const { url } = await serve();
    const res = await fetch(`${url}/control/events?deviceId=laptop-home`, { headers: { authorization: "Bearer nope" } });
    expect(res.status).toBe(401);
    await res.body?.cancel();
  });

  it("rejects node→hub posts without a valid token", async () => {
    const { url, token } = await serve();
    const bad = await fetch(`${url}/control/msg?deviceId=laptop-home`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    expect(bad.status).toBe(401);
    const alsoBad = await fetch(`${url}/control/msg?deviceId=laptop-home`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}x` }, body: "{}",
    });
    expect(alsoBad.status).toBe(401);
  });

  it("refuses everything when the hub has no token configured at all", async () => {
    // An unconfigured control plane hands out executable instructions to whoever connects — it must
    // refuse, not default to open.
    const dataDir = mkdtempSync(join(tmpdir(), "ccdata-"));
    vi.stubEnv("FLEET_TOKEN", "");
    const server = await startHubServer({ dataDir, hub: new Hub(() => profile()), port: 0, host: "127.0.0.1" });
    cleanups.push(() => { server.close(); vi.unstubAllEnvs(); });
    const res = await fetch(`http://127.0.0.1:${server.port}/control/events?deviceId=laptop-home`, {
      headers: { authorization: "Bearer anything" },
    });
    expect(res.status).toBe(401);
    await res.body?.cancel();
  });

  it("requires a deviceId", async () => {
    const { url, token } = await serve();
    const res = await fetch(`${url}/control/events`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(400);
    await res.body?.cancel();
  });
});

describe("http transport — duplex", () => {
  it("delivers the hub's connect-time push to the node", async () => {
    const { url, token } = await serve();
    const seen: unknown[] = [];
    const ch = connectHttp({ hubUrl: url, token, deviceId: "laptop-home" });
    cleanups.push(() => ch.close());
    ch.onMessage((m) => seen.push(m));
    await vi.waitFor(() => expect(seen).toHaveLength(1), { timeout: 5000 });
    expect(seen[0]).toMatchObject({ t: "apply", proto: PROTO_VERSION, version: 1 });
  });

  it("delivers a later publish over the same stream", async () => {
    let current = profile();
    const { url, token, hub } = await serve(() => current);
    const seen: unknown[] = [];
    const ch = connectHttp({ hubUrl: url, token, deviceId: "laptop-home" });
    cleanups.push(() => ch.close());
    ch.onMessage((m) => seen.push(m));
    await vi.waitFor(() => expect(seen).toHaveLength(1), { timeout: 5000 });
    current = profile({ version: 2 });
    hub.publish();
    await vi.waitFor(() => expect(seen).toHaveLength(2), { timeout: 5000 });
    expect(seen[1]).toMatchObject({ version: 2 });
  });

  it("carries node→hub reports back to the hub", async () => {
    const { url, token, hub } = await serve();
    const ch = connectHttp({ hubUrl: url, token, deviceId: "laptop-home" });
    cleanups.push(() => ch.close());
    await vi.waitFor(() => expect(hub.deviceIds()).toContain("laptop-home"), { timeout: 5000 });
    ch.send({ t: "applied", proto: PROTO_VERSION, version: 1, ok: true, written: 1, deleted: 0, warnings: [] });
    await vi.waitFor(() => expect(hub.lastApplied("laptop-home")).toMatchObject({ version: 1, ok: true }), { timeout: 5000 });
  });

  it("survives keep-alive frames without corrupting message parsing", async () => {
    // Keep-alives are SSE comments. A parser that treated them as data would hand the agent garbage
    // and, worse, a garbage desired state.
    const { url, token, hub } = await serve();
    const seen: unknown[] = [];
    const ch = connectHttp({ hubUrl: url, token, deviceId: "laptop-home" });
    cleanups.push(() => ch.close());
    ch.onMessage((m) => seen.push(m));
    await vi.waitFor(() => expect(seen).toHaveLength(1), { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 220)); // several 50ms keep-alives
    hub.publish();
    await vi.waitFor(() => expect(seen).toHaveLength(2), { timeout: 5000 });
    expect(seen.every((m) => typeof m === "object" && m !== null)).toBe(true);
  });

  it("drops the device from the hub when the node disconnects", async () => {
    const { url, token, hub } = await serve();
    const ch = connectHttp({ hubUrl: url, token, deviceId: "laptop-home" });
    await vi.waitFor(() => expect(hub.deviceIds()).toContain("laptop-home"), { timeout: 5000 });
    ch.close();
    await vi.waitFor(() => expect(hub.deviceIds()).not.toContain("laptop-home"), { timeout: 5000 });
  });

  it("replaces a stale connection when the same device reconnects", async () => {
    // A half-dead socket the OS has not reaped yet must not leave a phantom device that shadows the
    // live one — otherwise the hub broadcasts into the void and the node looks stuck.
    const { url, token, hub } = await serve();
    const a = connectHttp({ hubUrl: url, token, deviceId: "laptop-home" });
    cleanups.push(() => a.close());
    await vi.waitFor(() => expect(hub.deviceIds()).toEqual(["laptop-home"]), { timeout: 5000 });
    const b = connectHttp({ hubUrl: url, token, deviceId: "laptop-home" });
    cleanups.push(() => b.close());
    await new Promise((r) => setTimeout(r, 300));
    expect(hub.deviceIds()).toEqual(["laptop-home"]); // exactly one, not two
  });

  it("reconnects by itself after the hub goes away and comes back", async () => {
    // The node's whole availability story is "keep trying" — design §5 accepts that a node offline
    // during an edit catches up on reconnect, which only holds if reconnect actually happens.
    const first = await serve();
    const seen: unknown[] = [];
    const ch = connectHttp({ hubUrl: first.url, token: first.token, deviceId: "laptop-home", retryMs: 20, maxRetryMs: 50 });
    cleanups.push(() => ch.close());
    ch.onMessage((m) => seen.push(m));
    await vi.waitFor(() => expect(seen).toHaveLength(1), { timeout: 5000 });

    const port = first.server.port;
    first.server.close();
    await new Promise((r) => setTimeout(r, 100));

    // Same port, same token file — as if the hub process restarted.
    const hub = new Hub(() => profile({ version: 7 }));
    const again = await startHubServer({ dataDir: first.dataDir, hub, port, host: "127.0.0.1", keepAliveMs: 50 });
    cleanups.push(() => again.close());
    await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(2), { timeout: 10000 });
    expect(seen[seen.length - 1]).toMatchObject({ version: 7 });
  }, 20000);

  it("stops reconnecting once closed", async () => {
    const { url, token } = await serve();
    const ch = connectHttp({ hubUrl: url, token, deviceId: "laptop-home", retryMs: 10, maxRetryMs: 20 });
    const seen: unknown[] = [];
    ch.onMessage((m) => seen.push(m));
    await vi.waitFor(() => expect(seen).toHaveLength(1), { timeout: 5000 });
    ch.close();
    const after = seen.length;
    await new Promise((r) => setTimeout(r, 200));
    expect(seen).toHaveLength(after);
  });

  it("does not retry a 401 — a bad token is not a transient fault", async () => {
    // Hammering a hub with a token that will never work is both useless and a way to lock yourself
    // out of the logs. Surface it once, loudly, and stop.
    const { url } = await serve();
    const errors: string[] = [];
    const ch = connectHttp({ hubUrl: url, token: "wrong", deviceId: "laptop-home", retryMs: 10, maxRetryMs: 20 });
    cleanups.push(() => ch.close());
    ch.onError((e) => errors.push(e));
    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0), { timeout: 5000 });
    expect(errors[0]).toMatch(/401|unauthor/i);
    const count = errors.length;
    await new Promise((r) => setTimeout(r, 200));
    expect(errors.length).toBe(count); // gave up rather than looping
  });
});

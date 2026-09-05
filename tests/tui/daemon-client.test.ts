import { describe, it, expect, vi } from "vitest";
import { DaemonClient } from "../../src/tui/daemon-client.js";
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

describe("DaemonClient", () => {
  it("reads status", async () => {
    const f = vi.fn(async () => json({ workerState: "ready", restarts: [] }));
    const c = new DaemonClient("http://x", f as unknown as typeof fetch);
    expect((await c.status()).workerState).toBe("ready");
  });
  it("posts restart with bootstrap CSRF and same-origin headers", async () => {
    const f = vi.fn(async (url: string | URL) => String(url).endsWith("/api/bootstrap") ? json({ csrfToken: "csrf" }) : json({ ok: true }));
    await new DaemonClient("http://x", f as unknown as typeof fetch).restart();
    expect(f.mock.calls[0][0]).toBe("http://x/api/bootstrap");
    expect(f.mock.calls[1][0]).toBe("http://x/api/restart");
    expect(f.mock.calls[1][1]).toMatchObject({ method: "POST", headers: expect.objectContaining({ origin: "http://x", "x-cc-fleet-csrf": "csrf" }) });
  });
  it("runs doctor", async () => {
    const f = vi.fn(async () => json({ checks: [{ name: "x", ok: true, detail: "d" }] }));
    expect((await new DaemonClient("http://x", f as unknown as typeof fetch).doctor())[0].ok).toBe(true);
  });
  it("doctor light hits /api/doctor; ping adds ?ping=1", async () => {
    const f = vi.fn(async () => json({ checks: [] }));
    const c = new DaemonClient("http://x", f as unknown as typeof fetch);
    await c.doctor();
    await c.doctor(true);
    expect(f.mock.calls[0][0]).toBe("http://x/api/doctor");
    expect(f.mock.calls[1][0]).toBe("http://x/api/doctor?ping=1");
  });
  it("posts stop and start to the right paths, reusing the bootstrap token", async () => {
    const f = vi.fn(async (url: string | URL) => String(url).endsWith("/api/bootstrap") ? json({ csrfToken: "csrf" }) : json({ ok: true }));
    const c = new DaemonClient("http://x", f as unknown as typeof fetch);
    await c.stop();
    await c.start();
    expect(f.mock.calls.map((x) => x[0])).toEqual(["http://x/api/bootstrap", "http://x/api/stop", "http://x/api/start"]);
  });
  it("unwraps the requests array", async () => {
    const f = vi.fn(async () => json({ requests: [{ ts: 1, endpoint: "/v1/messages", model: "m", status: 200, latencyMs: 4 }] }));
    const reqs = await new DaemonClient("http://x", f as unknown as typeof fetch).requests();
    expect(reqs[0].model).toBe("m");
  });
});

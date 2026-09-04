import { describe, it, expect } from "vitest";
import request from "supertest";
import { createControlApp } from "../../src/supervisor/api.js";
import { openDb, recordRestart, recordRequest } from "../../src/supervisor/db.js";
import { EventBus } from "../../src/supervisor/events.js";

// Default client/model deps the dashboard endpoints need; spread into the SSE/github fixtures that
// don't care about them.
const dash = { clients: () => ({ claude: { user: false, project: false }, codex: { user: false, project: false } }), models: async () => [] };

function fixture() {
  const db = openDb(":memory:");
  recordRestart(db, { ts: 1, reason: "crash", exitCode: 1, stderrTail: "boom", backoffMs: 500, markedUnhealthy: 0 });
  recordRequest(db, { ts: 2, endpoint: "/v1/chat/completions", model: "gpt-4o", status: 200, latencyMs: 9 });
  const calls: string[] = [];
  const app = createControlApp({
    db,
    getState: () => "ready",
    restart: () => calls.push("restart"),
    stop: () => calls.push("stop"),
    start: () => calls.push("start"),
    doctor: async () => [{ name: "copilot-auth", ok: true, detail: "token present" }],
    github: () => undefined,
    clients: () => ({ claude: { user: false, project: false }, codex: { user: false, project: false } }),
    models: async () => [{ id: "gpt-4o" }],
    subscribe: () => () => {},
  });
  return { app, calls };
}

describe("control api", () => {
  it("status", async () => {
    const res = await request(fixture().app).get("/api/status");
    expect(res.body.workerState).toBe("ready");
    expect(res.body.restarts[0].stderrTail).toBe("boom");
  });
  it("status includes the github heartbeat when it has a result", async () => {
    const db = openDb(":memory:");
    const app = createControlApp({
      db, getState: () => "ready", restart: () => {}, stop: () => {}, start: () => {},
      doctor: async () => [], github: () => ({ ok: false, hasToken: true, checkedAt: 5, detail: "GitHub login expired" }), ...dash, subscribe: () => () => {},
    });
    const res = await request(app).get("/api/status");
    expect(res.body.github).toEqual({ ok: false, hasToken: true, checkedAt: 5, detail: "GitHub login expired" });
  });
  it("status omits github before the first probe (undefined)", async () => {
    const res = await request(fixture().app).get("/api/status"); // fixture's github() returns undefined
    expect(res.body.github).toBeUndefined();
  });
  it("restart action", async () => {
    const fx = fixture();
    const token = (await request(fx.app).get("/api/bootstrap")).body.csrfToken;
    await request(fx.app).post("/api/restart")
      .set("origin", "http://127.0.0.1:7990").set("host", "127.0.0.1:7990")
      .set("x-cc-fleet-csrf", token).set("content-type", "application/json").send({});
    expect(fx.calls).toContain("restart");
  });
  it("doctor", async () => {
    const res = await request(fixture().app).get("/api/doctor");
    expect(res.body.checks[0].ok).toBe(true);
  });
  it("recent requests", async () => {
    const res = await request(fixture().app).get("/api/requests");
    expect(res.body.requests[0].model).toBe("gpt-4o");
  });
  it("/api/metrics rolls up the whole request_log (all-time + day) over a real count", async () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 150; i++) recordRequest(db, { ts: 1000 + i, endpoint: "/v1/messages", model: "gpt-4o", status: 200, latencyMs: 10, tokensIn: 2, tokensOut: 1 });
    recordRequest(db, { ts: 5, endpoint: "/v1/messages", model: "gpt-4o", status: 502, latencyMs: 3, error: "boom" }); // old failure
    const app = createControlApp({
      db, getState: () => "ready", restart: () => {}, stop: () => {}, start: () => {},
      doctor: async () => [], github: () => undefined, ...dash, now: () => 1100, // 24h window cuts at 1100-86400000 < 0, so day == all here
      subscribe: () => () => {},
    });
    const res = await request(app).get("/api/metrics");
    expect(res.body.all.total).toBe(151);            // real COUNT(*), beyond the 100-row cap
    expect(res.body.all.errors).toBe(1);
    expect(res.body.all.tokensIn).toBe(300);
    expect(res.body.recentErrors[0].error).toBe("boom"); // surfaced even though it's not in the last 100
    expect(res.body.day.total).toBe(151);
  });
  it("/api/metrics day window filters to the last 24h via injectable now()", async () => {
    const db = openDb(":memory:");
    const now = 1_000_000_000_000;
    recordRequest(db, { ts: now - 2 * 24 * 60 * 60 * 1000, endpoint: "/v1/messages", model: "gpt-4o", status: 200, latencyMs: 10 }); // 2 days ago
    recordRequest(db, { ts: now - 60 * 1000, endpoint: "/v1/messages", model: "gpt-4o", status: 200, latencyMs: 10 });               // a minute ago
    const app = createControlApp({
      db, getState: () => "ready", restart: () => {}, stop: () => {}, start: () => {},
      doctor: async () => [], github: () => undefined, ...dash, now: () => now, subscribe: () => () => {},
    });
    const res = await request(app).get("/api/metrics");
    expect(res.body.all.total).toBe(2);
    expect(res.body.day.total).toBe(1); // only the recent one falls inside 24h
  });
  it("serves client config at /api/clients", async () => {
    const res = await request(fixture().app).get("/api/clients");
    expect(res.body).toHaveProperty("claude");
    expect(res.body).toHaveProperty("codex");
  });
  it("serves the advertised models at /api/models", async () => {
    const res = await request(fixture().app).get("/api/models");
    expect(res.body.models).toEqual([{ id: "gpt-4o" }]);
  });
  it("/api/models degrades to an empty list if discovery throws (no 500)", async () => {
    const db = openDb(":memory:");
    const app = createControlApp({
      db, getState: () => "ready", restart: () => {}, stop: () => {}, start: () => {},
      doctor: async () => [], github: () => undefined,
      clients: () => ({ claude: { user: false, project: false }, codex: { user: false, project: false } }),
      models: async () => { throw new Error("worker down"); },
      subscribe: () => () => {},
    });
    const res = await request(app).get("/api/models");
    expect(res.status).toBe(200);
    expect(res.body.models).toEqual([]);
  });
  it("passes ?ping=1 through to doctor", async () => {
    const seen: (boolean | undefined)[] = [];
    const db = openDb(":memory:");
    const app = createControlApp({
      db, getState: () => "ready", restart: () => {}, stop: () => {}, start: () => {},
      doctor: async (ping) => { seen.push(ping); return []; }, github: () => undefined, ...dash, subscribe: () => () => {},
    });
    await request(app).get("/api/doctor");
    await request(app).get("/api/doctor?ping=1");
    expect(seen).toEqual([false, true]);
  });
  it("stop and start actions are wired", async () => {
    const fx = fixture();
    const token = (await request(fx.app).get("/api/bootstrap")).body.csrfToken;
    const post = (path: string) => request(fx.app).post(path)
      .set("origin", "http://127.0.0.1:7990").set("host", "127.0.0.1:7990")
      .set("x-cc-fleet-csrf", token).set("content-type", "application/json").send({});
    await post("/api/stop");
    await post("/api/start");
    expect(fx.calls).toEqual(["stop", "start"]);
  });
  it("serves the dashboard html at /", async () => {
    const res = await request(fixture().app).get("/");
    expect(res.headers["content-type"]).toMatch(/html/);
    expect(res.text).toMatch(/<!doctype html>/i);
  });
});

describe("control api /api/events (SSE)", () => {
  // Drive the app on a real port and read the SSE stream with fetch — supertest's buffering
  // doesn't play well with never-ending event-streams.
  async function withServer(deps: Parameters<typeof createControlApp>[0], fn: (base: string) => Promise<void>) {
    const app = createControlApp(deps);
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    try { await fn(`http://127.0.0.1:${port}`); }
    finally { server.close(); }
  }

  it("streams an initial hello then live bus events to a connected client", async () => {
    const bus = new EventBus();
    await withServer(
      { db: openDb(":memory:"), getState: () => "ready", restart: () => {}, stop: () => {}, start: () => {}, doctor: async () => [], github: () => undefined, ...dash, subscribe: (send) => bus.subscribe(send) },
      async (base) => {
        const ctrl = new AbortController();
        const res = await fetch(`${base}/api/events`, { signal: ctrl.signal });
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let body = "";
        setTimeout(() => bus.emit("metric", { ts: 1, model: "gpt-4o", status: 200 }), 30);
        while (!body.includes("event: metric")) {
          const { value, done } = await reader.read();
          if (done) break;
          body += decoder.decode(value, { stream: true });
        }
        ctrl.abort();
        expect(body).toContain("event: hello");
        expect(body).toContain('"state":"ready"');
        expect(body).toContain("event: metric");
        expect(body).toContain('"model":"gpt-4o"');
      },
    );
  });

  it("unsubscribes the listener when the client disconnects", async () => {
    const bus = new EventBus();
    await withServer(
      { db: openDb(":memory:"), getState: () => "ready", restart: () => {}, stop: () => {}, start: () => {}, doctor: async () => [], github: () => undefined, ...dash, subscribe: (send) => bus.subscribe(send) },
      async (base) => {
        const ctrl = new AbortController();
        const res = await fetch(`${base}/api/events`, { signal: ctrl.signal });
        const reader = res.body!.getReader();
        await reader.read();   // receive the hello frame (one subscriber now attached)
        ctrl.abort();          // disconnect
        await new Promise((r) => setTimeout(r, 50)); // let the server observe 'close'
        expect(() => bus.emit("metric", { x: 1 })).not.toThrow();
      },
    );
  });

  it("a write to a socket that died between broadcasts is swallowed and unsubscribes (no crash)", async () => {
    // Reproduces the concurrency crash: multiple clients each hold an SSE connection; one dies and the
    // next broadcast writes to its destroyed socket, which throws synchronously inside emit(). With the
    // guard, the write is caught and the dead client is dropped so it isn't written to again.
    const bus = new EventBus();
    await withServer(
      { db: openDb(":memory:"), getState: () => "ready", restart: () => {}, stop: () => {}, start: () => {}, doctor: async () => [], github: () => undefined, ...dash, subscribe: (send) => bus.subscribe(send) },
      async (base) => {
        // A live client keeps the stream working; a second client disconnects abruptly.
        const liveCtrl = new AbortController();
        const live = await fetch(`${base}/api/events`, { signal: liveCtrl.signal });
        const liveReader = live.body!.getReader();
        await liveReader.read();

        const deadCtrl = new AbortController();
        const dead = await fetch(`${base}/api/events`, { signal: deadCtrl.signal });
        await dead.body!.getReader().read();
        deadCtrl.abort();
        // Broadcast immediately — racing the server's 'close' handler so a write to the dead socket can
        // still fire. This must neither throw nor stop the live client from receiving the event.
        expect(() => { for (let i = 0; i < 5; i++) bus.emit("metric", { i }); }).not.toThrow();

        const decoder = new TextDecoder();
        let body = "";
        while (!body.includes("event: metric")) {
          const { value, done } = await liveReader.read();
          if (done) break;
          body += decoder.decode(value, { stream: true });
        }
        expect(body).toContain("event: metric"); // live client still served
        liveCtrl.abort();
      },
    );
  });
});

describe("EventBus", () => {
  it("delivers to all subscribers and stops after unsubscribe", () => {
    const bus = new EventBus();
    const a: string[] = [], b: string[] = [];
    const offA = bus.subscribe((e) => a.push(e));
    bus.subscribe((e) => b.push(e));
    bus.emit("one", {});
    offA();
    bus.emit("two", {});
    expect(a).toEqual(["one"]);       // A unsubscribed before "two"
    expect(b).toEqual(["one", "two"]); // B still receiving
  });
});

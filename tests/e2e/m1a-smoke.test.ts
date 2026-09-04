import { describe, it, expect } from "vitest";
import request from "supertest";
import { createControlApp } from "../../src/supervisor/api.js";
import { openDb, recordRestart } from "../../src/supervisor/db.js";
import { EventBus } from "../../src/supervisor/events.js";

describe("M1a control-plane e2e", () => {
  it("status, restart action, and SSE wiring", async () => {
    const db = openDb(":memory:");
    const bus = new EventBus();
    let state: "starting" | "ready" = "starting";
    const app = createControlApp({
      db, getState: () => state,
      restart: () => { state = "ready"; recordRestart(db, { ts: Date.now(), reason: "manual", exitCode: null, stderrTail: "", backoffMs: 0, markedUnhealthy: 0 }); bus.emit("state", { state }); },
      stop: () => {}, start: () => {}, doctor: async () => [{ name: "x", ok: true, detail: "ok" }],
      github: () => undefined,
      subscribe: (s) => bus.subscribe(s),
    });
    expect((await request(app).get("/api/status")).body.workerState).toBe("starting");
    const token = (await request(app).get("/api/bootstrap")).body.csrfToken;
    await request(app).post("/api/restart")
      .set("origin", "http://127.0.0.1:7990").set("host", "127.0.0.1:7990")
      .set("x-cc-fleet-csrf", token).set("content-type", "application/json").send({});
    const after = await request(app).get("/api/status");
    expect(after.body.workerState).toBe("ready");
    expect(after.body.restarts).toHaveLength(1);
  });
});

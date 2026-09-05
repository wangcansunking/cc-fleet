import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createControlApp, type ControlDeps } from "../../src/supervisor/api.js";
import { openDb } from "../../src/supervisor/db.js";

function fixture(over: Partial<ControlDeps> = {}) {
  const calls: string[] = [];
  const fleet = {
    summary: () => ({ hub: "ready", node: "disabled", tunnel: { state: "online", publicUrl: "https://fleet.devtunnels.ms" }, online: 1, enrolled: 1, pending: 1, profileVersion: 4 }),
    enrolments: () => [{ requestId: "r1", userCode: "ABCD-EFGH", hostname: "laptop", os: "linux", agentVersion: "1", expiresAt: 99 }],
    approve: (id: string) => { calls.push(`approve:${id}`); return { ok: true }; },
    deny: (id: string) => { calls.push(`deny:${id}`); return { ok: true }; },
    devices: () => [{ deviceId: "laptop", hostname: "laptop", online: true, lastSeenAt: 1 }],
    revoke: (id: string) => { calls.push(`revoke:${id}`); return { ok: true }; },
    pending: () => [],
    adopt: () => ({ ok: true }), reject: () => true,
    liveProfile: () => ({ ok: true, profile: { version: 4, groups: {}, assignments: {} }, revision: "rev" }),
    draftProfile: () => ({ exists: false }),
    saveDraft: () => ({ ok: true, revision: "draft" }),
    previewDraft: () => ({ ok: true, devices: [] }),
    publishDraft: () => ({ ok: true, version: 5 }),
    history: () => [], rollback: () => ({ ok: true, version: 6 }),
    tunnelStatus: () => ({ state: "online", tunnelId: "fleet-id", publicUrl: "https://fleet.devtunnels.ms" }),
    tunnelLogin: () => { calls.push("tunnel-login"); return { ok: true }; },
    tunnelEnable: () => { calls.push("tunnel-enable"); return { ok: true }; },
    tunnelDisable: () => { calls.push("tunnel-disable"); return { ok: true }; },
    tunnelDelete: () => { calls.push("tunnel-delete"); return { ok: true }; },
    tunnelInterrupt: () => { calls.push("tunnel-interrupt"); return { ok: true }; },
    rotateLlmKey: () => { calls.push("rotate-key"); return { ok: true, revision: 2 }; },
    reloadRoles: () => { calls.push("reload-roles"); return { ok: true }; },
    reloadNode: () => { calls.push("reload-node"); return { ok: true }; },
  };
  const deps: ControlDeps = {
    db: openDb(":memory:"), getState: () => "ready", restart: () => {}, stop: () => {}, start: () => {},
    doctor: async () => [], github: () => undefined,
    clients: () => ({ claude: { user: false, project: false }, codex: { user: false, project: false } }),
    models: async () => [], subscribe: () => () => {}, fleet,
    ...over,
  };
  return { app: createControlApp(deps), calls, fleet };
}

async function csrf(app: ReturnType<typeof fixture>["app"]) {
  const res = await request(app).get("/api/bootstrap");
  return res.body.csrfToken as string;
}
function post(app: ReturnType<typeof fixture>["app"], path: string, token: string, body: unknown = {}) {
  return request(app).post(path).set("origin", "http://127.0.0.1:7990").set("host", "127.0.0.1:7990")
    .set("x-cc-fleet-csrf", token).set("content-type", "application/json").send(body);
}

describe("local fleet dashboard API", () => {
  it("bootstraps a per-process CSRF token without secrets", async () => {
    const { app } = fixture();
    const res = await request(app).get("/api/bootstrap");
    expect(res.status).toBe(200);
    expect(res.body.csrfToken).toMatch(/^[A-Za-z0-9_-]{30,}$/);
    expect(JSON.stringify(res.body)).not.toMatch(/llmKey|tokenHash|deviceCodeHash/i);
  });

  it("serves sanitized fleet summary, enrolments and devices", async () => {
    const { app } = fixture();
    expect((await request(app).get("/api/fleet/summary")).body.tunnel.state).toBe("online");
    const enrolments = (await request(app).get("/api/fleet/enrolments")).body.enrolments;
    expect(enrolments[0].hostname).toBe("laptop");
    expect(JSON.stringify(enrolments)).not.toContain("deviceCodeHash");
    expect((await request(app).get("/api/fleet/devices")).body.devices[0].online).toBe(true);
  });

  it("rejects mutations with no CSRF, foreign origin, or non-JSON body", async () => {
    const { app, calls } = fixture();
    const token = await csrf(app);
    expect((await request(app).post("/api/fleet/enrolments/r1/approve").send({ confirm: true })).status).toBe(403);
    expect((await request(app).post("/api/fleet/enrolments/r1/approve").set("origin", "https://evil.example").set("host", "127.0.0.1:7990").set("x-cc-fleet-csrf", token).send({ confirm: true })).status).toBe(403);
    expect((await request(app).post("/api/fleet/enrolments/r1/approve").set("origin", "http://127.0.0.1:7990").set("host", "127.0.0.1:7990").set("x-cc-fleet-csrf", token).set("content-type", "text/plain").send("x")).status).toBe(415);
    expect(calls).toEqual([]);
  });

  it("requires explicit confirmation before approval, revoke, publish, key rotation and tunnel deletion", async () => {
    const { app, calls } = fixture();
    const token = await csrf(app);
    expect((await post(app, "/api/fleet/enrolments/r1/approve", token)).status).toBe(400);
    expect((await post(app, "/api/fleet/devices/laptop/revoke", token)).status).toBe(400);
    expect((await post(app, "/api/fleet/profile/publish", token, { revision: "rev" })).status).toBe(400);
    expect((await post(app, "/api/fleet/tunnel/rotate-key", token)).status).toBe(400);
    expect((await post(app, "/api/fleet/tunnel/delete", token, { confirm: "DELETE wrong" })).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("executes confirmed actions and decodes path identifiers", async () => {
    const { app, calls } = fixture();
    const token = await csrf(app);
    expect((await post(app, "/api/fleet/enrolments/r1/approve", token, { confirm: true })).status).toBe(200);
    expect((await post(app, "/api/fleet/devices/laptop/revoke", token, { confirm: "laptop" })).status).toBe(200);
    expect((await post(app, "/api/fleet/profile/publish", token, { revision: "rev", confirm: true })).status).toBe(200);
    expect((await post(app, "/api/fleet/tunnel/rotate-key", token, { confirm: true })).status).toBe(200);
    expect((await post(app, "/api/fleet/tunnel/delete", token, { tunnelId: "fleet-id", confirm: "DELETE fleet-id" })).status).toBe(200);
    expect(calls).toEqual(["approve:r1", "revoke:laptop", "rotate-key", "tunnel-delete"]);
  });

  it("binds tunnel deletion confirmation to the actual current tunnel id", async () => {
    const { app, calls } = fixture();
    const token = await csrf(app);
    const res = await post(app, "/api/fleet/tunnel/delete", token, { tunnelId: "stale-id", confirm: "DELETE stale-id" });
    expect(res.status).toBe(400);
    expect(calls).not.toContain("tunnel-delete");
  });

  it("protects legacy supervisor start/stop/restart mutations with the same CSRF guard", async () => {
    const { app } = fixture();
    expect((await request(app).post("/api/restart")).status).toBeGreaterThanOrEqual(400);
    expect((await request(app).post("/api/stop")).status).toBeGreaterThanOrEqual(400);
    expect((await request(app).post("/api/start")).status).toBeGreaterThanOrEqual(400);
  });

  it("passes revision conflicts through as 409", async () => {
    const { app } = fixture({ fleet: { ...fixture().fleet, saveDraft: () => ({ ok: false, code: "revision_conflict", error: "live changed" }) } as any });
    const token = await csrf(app);
    const res = await request(app).put("/api/fleet/profile/draft")
      .set("origin", "http://127.0.0.1:7990").set("host", "127.0.0.1:7990")
      .set("x-cc-fleet-csrf", token).set("content-type", "application/json")
      .send({ profile: { version: 1, groups: {}, assignments: {} }, baseRevision: "old" });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "revision_conflict" });
  });
});

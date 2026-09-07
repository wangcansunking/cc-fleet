import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createControlApp, type ControlDeps } from "../../src/supervisor/api.js";
import { openDb } from "../../src/supervisor/db.js";

const baseState = {
  enabled: true,
  entries: [
    { alias: "claude-opus-5", backend: "gpt-5.6-sol", source: "builtin", status: "available", hasOverride: false },
    { alias: "claude-fable-6-1", backend: "gemini-not-live", source: "user", status: "unavailable", hasOverride: true },
    { alias: "claude-haiku-4-5", source: "user", status: "disabled", hasOverride: true },
  ],
  userEntries: [
    { alias: "claude-fable-6-1", backend: "gemini-not-live" },
    { alias: "claude-haiku-4-5", disabled: true },
  ],
  builtins: [
    { alias: "claude-haiku-4-5", backend: "gpt-5.4" },
    { alias: "claude-sonnet-4-6", backend: "gpt-5.5" },
    { alias: "claude-opus-4-8", backend: "gpt-5.6-luna" },
    { alias: "claude-opus-5", backend: "gpt-5.6-sol" },
    { alias: "claude-sonnet-5", backend: "gpt-5.6-terra" },
  ],
  liveBackendIds: ["gpt-5.6-sol", "gpt-4o"],
  warning: null,
};

function fixture(over: Record<string, unknown> = {}) {
  const restart = vi.fn();
  const claudeMap = {
    status: vi.fn(async () => baseState),
    replace: vi.fn(async () => baseState),
    reset: vi.fn(async () => ({ ...baseState, userEntries: [], entries: baseState.entries.slice(0, 1) })),
  };
  const deps: ControlDeps = {
    db: openDb(":memory:"), getState: () => "ready", restart, stop: () => {}, start: () => {},
    doctor: async () => [], github: () => undefined,
    clients: () => ({ claude: { user: false, project: false }, codex: { user: false, project: false } }),
    models: async () => [], subscribe: () => () => {}, claudeMap,
    ...over,
  };
  return { app: createControlApp(deps), restart, claudeMap };
}

async function csrf(app: ReturnType<typeof fixture>["app"]) {
  return (await request(app).get("/api/bootstrap")).body.csrfToken as string;
}
function mutation(app: ReturnType<typeof fixture>["app"], method: "put" | "post", path: string, token: string, body: unknown) {
  return request(app)[method](path)
    .set("origin", "http://127.0.0.1:7990").set("host", "127.0.0.1:7990")
    .set("x-cc-fleet-csrf", token).set("content-type", "application/json").send(body);
}

describe("Claude map dashboard API", () => {
  it("returns effective, user, and live status without credentials", async () => {
    const { app } = fixture();
    const res = await request(app).get("/api/claude-map");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(baseState);
    expect(JSON.stringify(res.body)).not.toMatch(/token|apiKey|credential/i);
  });

  it("replaces the whole user config and restarts only after a successful write", async () => {
    const { app, claudeMap, restart } = fixture();
    const token = await csrf(app);
    const body = { enabled: true, entries: [{ alias: "claude-fable-6-1[1m]", backend: "gemini-not-live" }] };
    const res = await mutation(app, "put", "/api/claude-map", token, body);
    expect(res.status).toBe(200);
    expect(claudeMap.replace).toHaveBeenCalledWith({
      enabled: true,
      entries: [{ alias: "claude-fable-6-1", backend: "gemini-not-live" }],
    });
    expect(restart).toHaveBeenCalledTimes(1);
    expect(res.body).toEqual(baseState);
  });

  it("resets user entries, preserves enabled state in the adapter, and restarts", async () => {
    const { app, claudeMap, restart } = fixture();
    const token = await csrf(app);
    const res = await mutation(app, "post", "/api/claude-map/reset", token, {});
    expect(res.status).toBe(200);
    expect(claudeMap.reset).toHaveBeenCalledTimes(1);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(res.body.userEntries).toEqual([]);
  });

  it("applies the existing CSRF, same-origin, and JSON guards", async () => {
    const { app, claudeMap, restart } = fixture();
    const token = await csrf(app);
    expect((await request(app).put("/api/claude-map").send({ enabled: true, entries: [] })).status).toBe(403);
    expect((await request(app).put("/api/claude-map").set("origin", "https://evil.example").set("host", "127.0.0.1:7990").set("x-cc-fleet-csrf", token).send({ enabled: true, entries: [] })).status).toBe(403);
    expect((await request(app).put("/api/claude-map").set("origin", "http://127.0.0.1:7990").set("host", "127.0.0.1:7990").set("x-cc-fleet-csrf", token).set("content-type", "text/plain").send("x")).status).toBe(415);
    expect(claudeMap.replace).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  });

  it.each([
    [{ enabled: "yes", entries: [] }, /boolean/i],
    [{ enabled: true, entries: [{ alias: "gpt-opus-6", backend: "gpt-5" }] }, /claude-/i],
    [{ enabled: true, entries: [{ alias: "claude-opus-6", backend: "" }] }, /backend/i],
    [{ enabled: true, entries: [{ alias: "claude-opus-6", backend: "gpt-5" }, { alias: "claude-opus-6[1m]", disabled: true }] }, /duplicate/i],
  ])("rejects invalid replacement %j without write or restart", async (body, pattern) => {
    const { app, claudeMap, restart } = fixture();
    const token = await csrf(app);
    const res = await mutation(app, "put", "/api/claude-map", token, body);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "invalid_request" });
    expect(res.body.error).toMatch(pattern);
    expect(claudeMap.replace).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  });

  it("returns write failures and does not restart", async () => {
    const replace = vi.fn(async () => { throw new Error("disk full"); });
    const { app, restart } = fixture({ claudeMap: { status: async () => baseState, replace, reset: async () => baseState } });
    const token = await csrf(app);
    const res = await mutation(app, "put", "/api/claude-map", token, { enabled: true, entries: [] });
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ code: "write_failed", error: "disk full" });
    expect(restart).not.toHaveBeenCalled();
  });
});

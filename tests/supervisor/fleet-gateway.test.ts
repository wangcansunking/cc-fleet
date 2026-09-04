import { describe, it, expect, vi, afterEach } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import request from "supertest";
import { createFleetGateway } from "../../src/supervisor/fleet-gateway.js";

const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

async function upstream() {
  const app = express();
  app.use(express.json());
  app.post("/anthropic/v1/messages", (req, res) => res.json({ path: req.path, body: req.body }));
  app.post("/openai/responses", (req, res) => res.json({ path: req.path, body: req.body }));
  app.get("/anthropic/stream", (_req, res) => {
    res.setHeader("content-type", "text/event-stream");
    res.write("data: one\n\n");
    setTimeout(() => res.end("data: two\n\n"), 5);
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const addr = server.address();
  return `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
}

async function fixture(key: string | null = "fleet-key") {
  const seen = { control: 0 };
  const control = express.Router();
  control.post("/control/device/code", (_req, res) => { seen.control += 1; res.json({ ok: true }); });
  const app = createFleetGateway({ control, workerBaseUrl: await upstream(), llmKey: () => key });
  return { app, seen };
}

const body = { model: "x", messages: [{ role: "user", content: "hi" }] };

describe("fleet public gateway", () => {
  it("exposes control routes but not dashboard or supervisor APIs", async () => {
    const { app, seen } = await fixture();
    expect((await request(app).post("/control/device/code").send({})).status).toBe(200);
    expect(seen.control).toBe(1);
    expect((await request(app).get("/")).status).toBe(404);
    expect((await request(app).get("/api/status")).status).toBe(404);
    expect((await request(app).post("/api/fleet/devices/a/revoke")).status).toBe(404);
  });

  it("exposes only a content-free health probe", async () => {
    const { app } = await fixture();
    expect((await request(app).get("/healthz")).body).toEqual({ ok: true });
  });

  it("rejects missing, wrong and same-length-wrong LLM keys before proxying", async () => {
    const { app } = await fixture("secret");
    expect((await request(app).post("/anthropic/v1/messages").send(body)).status).toBe(401);
    expect((await request(app).post("/anthropic/v1/messages").set("x-api-key", "wrong").send(body)).status).toBe(401);
    expect((await request(app).post("/openai/responses").set("authorization", "Bearer sekret").send(body)).status).toBe(401);
  });

  it("fails closed with 503 if the gateway has no LLM key", async () => {
    const { app } = await fixture(null);
    expect((await request(app).post("/anthropic/v1/messages").set("x-api-key", "anything").send(body)).status).toBe(503);
  });

  it("accepts Anthropic x-api-key and OpenAI Bearer, preserving path and body", async () => {
    const { app } = await fixture();
    const a = await request(app).post("/anthropic/v1/messages").set("x-api-key", "fleet-key").send(body);
    expect(a.status).toBe(200);
    expect(a.body).toEqual({ path: "/anthropic/v1/messages", body });
    const o = await request(app).post("/openai/responses").set("authorization", "Bearer fleet-key").send(body);
    expect(o.status).toBe(200);
    expect(o.body).toEqual({ path: "/openai/responses", body });
  });

  it("reads the key lazily, so rotation applies without restarting the gateway", async () => {
    let key: string | null = "old";
    const control = express.Router();
    const app = createFleetGateway({ control, workerBaseUrl: await upstream(), llmKey: () => key });
    expect((await request(app).post("/openai/responses").set("authorization", "Bearer old").send(body)).status).toBe(200);
    key = "new";
    expect((await request(app).post("/openai/responses").set("authorization", "Bearer old").send(body)).status).toBe(401);
    expect((await request(app).post("/openai/responses").set("authorization", "Bearer new").send(body)).status).toBe(200);
  });

  it("streams SSE without buffering the complete response", async () => {
    const base = await upstream();
    const app = createFleetGateway({ control: express.Router(), workerBaseUrl: base, llmKey: () => "fleet-key" });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const addr = server.address();
    const res = await fetch(`http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/anthropic/stream`, { headers: { "x-api-key": "fleet-key" } });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain("data: one");
    await reader.cancel();
  });

  it("never invokes proxy target resolution for rejected traffic", async () => {
    const workerBaseUrl = vi.fn(() => "http://127.0.0.1:1");
    const app = createFleetGateway({ control: express.Router(), workerBaseUrl, llmKey: () => "secret" });
    await request(app).post("/openai/responses").send(body);
    expect(workerBaseUrl).not.toHaveBeenCalled();
  });
});

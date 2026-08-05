import { describe, it, expect } from "vitest";
import request from "supertest";
import { createWorkerApp } from "../../src/worker/server.js";
import { Router } from "../../src/worker/router.js";
import type { ProviderAdapter } from "../../src/providers/types.js";

const provider: ProviderAdapter = {
  name: "copilot",
  complete: async () => ({ id: "c1", model: "gpt-4o", content: [{ type: "text", text: "hello" }], finishReason: "stop", usage: { promptTokens: 2, completionTokens: 1 } }),
  async *stream() { yield { kind: "text", delta: "he", done: false } as const; yield { kind: "text", delta: "llo", done: false } as const; yield { kind: "done", done: true, finishReason: "stop" } as const; },
};
const app = () => createWorkerApp(new Router([provider], { "*": "gpt-4o" }), () => {});

describe("worker OpenAI endpoint", () => {
  it("non-stream completion", async () => {
    const res = await request(app()).post("/openai/chat/completions").send({ model: "x", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toBe("hello");
  });
  it("SSE stream", async () => {
    const res = await request(app()).post("/openai/chat/completions").send({ model: "x", stream: true, messages: [{ role: "user", content: "hi" }] });
    expect(res.text).toContain('"content":"he"');
    expect(res.text).toContain("data: [DONE]");
  });
  it("each streamed response gets a unique id (clients dedupe by id)", async () => {
    const send = () => request(app()).post("/openai/chat/completions").send({ model: "x", stream: true, messages: [{ role: "user", content: "hi" }] });
    const idOf = (text: string) => JSON.parse(text.split("\n\n").find((b) => b.startsWith("data: ") && b.includes('"id"'))!.slice(6)).id as string;
    const [a, b] = await Promise.all([send(), send()]);
    expect(idOf(a.text)).toMatch(/^chatcmpl-/);
    expect(idOf(a.text)).not.toBe(idOf(b.text));
  });
  it("returns 502 with the upstream message when the provider fails", async () => {
    const fail: ProviderAdapter = { name: "copilot", complete: async () => { throw new Error("boom: bad request"); }, async *stream() { throw new Error("x"); } };
    const res = await request(createWorkerApp(new Router([fail], { "*": "gpt-4o" }), () => {})).post("/openai/chat/completions").send({ model: "x", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(502);
    expect(res.body.error.message).toMatch(/boom: bad request/);
  });
  it("GET /openai/models returns the model list in OpenAI list shape (fixes the connection-test 404)", async () => {
    const res = await request(app()).get("/openai/models");
    expect(res.status).toBe(200);
    expect(res.body.object).toBe("list");
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data[0]).toMatchObject({ object: "model" });
    expect(typeof res.body.data[0].id).toBe("string");
  });

  it("never adds synthesized Claude aliases to OpenAI discovery", async () => {
    const router = new Router([provider], {}, { claudeMapEnabled: true });
    router.setAvailableModels(["gpt-5.6-sol", "gpt-4o"]);
    router.setModelLimits({ "gpt-5.6-sol": 1_100_000 });
    const res = await request(createWorkerApp(router, () => {})).get("/openai/models");
    expect(res.body.data.map((m: { id: string }) => m.id)).toEqual(["gpt-5.6-sol", "gpt-4o"]);
  });
});

describe("worker OpenAI Responses endpoint (/openai/responses — Codex)", () => {
  it("non-stream: returns an output_text message item", async () => {
    const res = await request(app()).post("/openai/responses").send({ model: "gpt-5", input: "hi" });
    expect(res.status).toBe(200);
    expect(res.body.object).toBe("response");
    expect(res.body.status).toBe("completed");
    const msg = res.body.output.find((o: any) => o.type === "message");
    expect(msg.content[0]).toMatchObject({ type: "output_text", text: "hello" });
  });

  it("stream: begins with response.created and ends with response.completed", async () => {
    const res = await request(app()).post("/openai/responses").send({ model: "gpt-5", stream: true, input: "hi" });
    const events = res.text.split("\n\n").filter(Boolean).map((b) => JSON.parse(b.replace(/^data: /, "")));
    expect(events[0].type).toBe("response.created");
    expect(events.some((e) => e.type === "response.output_text.delta" && e.delta === "he")).toBe(true);
    expect(events.at(-1).type).toBe("response.completed");
  });

  it("surfaces a function tool call as a function_call output item", async () => {
    const toolProvider: ProviderAdapter = {
      name: "copilot",
      complete: async () => ({ id: "c", model: "gpt-5", content: [{ type: "tool_use", id: "fc1", name: "search", input: { q: "x" } }], finishReason: "tool_use", usage: { promptTokens: 1, completionTokens: 1 } }),
      async *stream() { yield { kind: "done", done: true, finishReason: "stop" } as const; },
    };
    const res = await request(createWorkerApp(new Router([toolProvider], { "*": "gpt-5" }), () => {}))
      .post("/openai/responses").send({ model: "gpt-5", input: "go", tools: [{ type: "function", name: "search", parameters: { type: "object", properties: {} } }] });
    const fc = res.body.output.find((o: any) => o.type === "function_call");
    expect(fc).toMatchObject({ type: "function_call", call_id: "fc1", name: "search" });
  });

  it("returns 502 with the upstream message when the provider fails", async () => {
    const fail: ProviderAdapter = { name: "copilot", complete: async () => { throw new Error("boom: responses bad"); }, async *stream() { throw new Error("x"); } };
    const res = await request(createWorkerApp(new Router([fail], { "*": "gpt-5" }), () => {}))
      .post("/openai/responses").send({ model: "gpt-5", input: "hi" });
    expect(res.status).toBe(502);
    expect(res.body.error.message).toMatch(/boom: responses bad/);
  });
});

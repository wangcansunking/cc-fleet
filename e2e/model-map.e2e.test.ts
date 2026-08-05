import { describe, expect, it } from "vitest";
import request from "supertest";
import { createWorkerApp } from "../src/worker/server.js";
import { Router } from "../src/worker/router.js";
import type { ProviderAdapter } from "../src/providers/types.js";

function fixture(enabled: boolean) {
  const seen: string[] = [];
  const metrics: string[] = [];
  const provider: ProviderAdapter = {
    name: "copilot",
    complete: async (req) => {
      seen.push(req.model);
      return { id: "c1", model: req.model, content: [{ type: "text", text: "ok" }], finishReason: "stop", usage: { promptTokens: 3, completionTokens: 1 } };
    },
    async *stream() { yield { kind: "done", done: true, finishReason: "stop" } as const; },
  };
  const router = new Router([provider], {}, { claudeMapEnabled: enabled });
  router.setAvailableModels(["gpt-5.6-sol", "gpt-4o"]);
  router.setModelLimits({ "gpt-5.6-sol": 1_100_000, "gpt-4o": 128_000 });
  const worker = createWorkerApp(router, (m) => metrics.push(m.model));
  return { worker, seen, metrics };
}

describe("E2E: Claude model compatibility map", () => {
  it("EP-44 leaves both discovery endpoints unchanged while disabled", async () => {
    const { worker } = fixture(false);
    const anthropic = await request(worker).get("/anthropic/v1/models");
    const openai = await request(worker).get("/openai/models");
    expect(anthropic.body.data.map((m: { id: string }) => m.id)).toEqual(["gpt-5.6-sol", "gpt-4o"]);
    expect(openai.body.data.map((m: { id: string }) => m.id)).toEqual(["gpt-5.6-sol", "gpt-4o"]);
  });

  it("EP-45 adds only live aliases to Anthropic discovery and none to OpenAI", async () => {
    const { worker } = fixture(true);
    const anthropic = await request(worker).get("/anthropic/v1/models");
    const openai = await request(worker).get("/openai/models");
    expect(anthropic.body.data).toEqual([
      { type: "model", id: "gpt-5.6-sol", display_name: "gpt-5.6-sol" },
      { type: "model", id: "gpt-4o", display_name: "gpt-4o" },
      { type: "model", id: "claude-opus-5[1m]", display_name: "Opus 5" },
    ]);
    expect(openai.body.data.map((m: { id: string }) => m.id)).toEqual(["gpt-5.6-sol", "gpt-4o"]);
  });

  it("EP-46 resolves a published Claude alias to the GPT provider and metrics id", async () => {
    const { worker, seen, metrics } = fixture(true);
    const res = await request(worker).post("/anthropic/v1/messages")
      .send({ model: "claude-opus-5[1m]", max_tokens: 16, messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
    expect(seen).toEqual(["gpt-5.6-sol"]);
    expect(metrics).toEqual(["gpt-5.6-sol"]);
  });

  it("EP-47 derives the alias 1M badge and limit from its mapped backend", async () => {
    const { worker } = fixture(true);
    const models = (await request(worker).get("/anthropic/v1/models")).body.data;
    expect(models.find((m: { id: string }) => m.id.startsWith("claude-opus-5"))).toEqual({
      type: "model", id: "claude-opus-5[1m]", display_name: "Opus 5",
    });
  });
});

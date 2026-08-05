import { describe, it, expect } from "vitest";
import request from "supertest";
import { createWorkerApp } from "../../src/worker/server.js";
import { Router } from "../../src/worker/router.js";
import type { ProviderAdapter } from "../../src/providers/types.js";
import type { CanonicalChunk } from "../../src/core/canonical.js";
import { UpstreamError } from "../../src/providers/copilot/adapter.js";

const textProvider: ProviderAdapter = {
  name: "copilot",
  complete: async () => ({ id: "c1", model: "m", content: [{ type: "text", text: "hello" }], finishReason: "stop", usage: { promptTokens: 2, completionTokens: 1 } }),
  async *stream() { yield { kind: "text", delta: "he", done: false } as const; yield { kind: "done", done: true, finishReason: "stop" } as const; },
};
const app = (p: ProviderAdapter = textProvider) => createWorkerApp(new Router([p], { "*": "gpt-4o" }), () => {});

// Splits an SSE body into ordered { event, data } frames.
function parseFrames(body: string): { event: string; data: any }[] {
  return body
    .split("\n\n")
    .map((blk) => blk.trim())
    .filter(Boolean)
    .map((blk) => {
      const event = blk.split("\n").find((l) => l.startsWith("event: "))?.slice(7) ?? "";
      const dataLine = blk.split("\n").find((l) => l.startsWith("data: "))?.slice(6) ?? "{}";
      return { event, data: JSON.parse(dataLine) };
    });
}

describe("worker Anthropic endpoint", () => {
  it("non-stream message", async () => {
    const res = await request(app()).post("/anthropic/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 100, messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
    expect(res.body.type).toBe("message");
    expect(res.body.content[0].text).toBe("hello");
  });

  it("reports real usage tokens in message_delta when the provider returns them", async () => {
    const usageProvider: ProviderAdapter = {
      name: "copilot",
      complete: async () => ({ id: "c1", model: "m", content: [{ type: "text", text: "hi" }], finishReason: "stop", usage: { promptTokens: 100, completionTokens: 5 } }),
      async *stream(): AsyncIterable<CanonicalChunk> {
        yield { kind: "text", delta: "hi", done: false };
        yield { kind: "done", done: true, finishReason: "stop", usage: { promptTokens: 100, completionTokens: 5, cachedTokens: 20 } };
      },
    };
    const res = await request(app(usageProvider)).post("/anthropic/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 50, stream: true, messages: [{ role: "user", content: "hi" }] });
    const delta = parseFrames(res.text).find((f) => f.event === "message_delta");
    // input = prompt - cached (80), output = 5, cached split out (agent-maestro shape)
    expect(delta!.data.usage.input_tokens).toBe(80);
    expect(delta!.data.usage.output_tokens).toBe(5);
    expect(delta!.data.usage.cache_read_input_tokens).toBe(20);
  });

  it("gives each streamed response a unique message id (clients dedupe by id)", async () => {
    const send = () => request(app()).post("/anthropic/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 50, stream: true, messages: [{ role: "user", content: "hi" }] });
    const idOf = (text: string) => JSON.parse(text.split("\n\n")[0].split("\n").find((l) => l.startsWith("data: "))!.slice(6)).message.id as string;
    const [a, b] = await Promise.all([send(), send()]);
    const idA = idOf(a.text), idB = idOf(b.text);
    expect(idA).toMatch(/^msg_/);
    expect(idA).not.toBe(idB); // must NOT be a constant like msg_<model>
  });

  it("seeds message_start with an estimated input_tokens so the context bar isn't stuck at 0", async () => {
    const res = await request(app()).post("/anthropic/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 50, stream: true, messages: [{ role: "user", content: "a reasonably long prompt about many things" }] });
    const start = parseFrames(res.text).find((f) => f.event === "message_start");
    expect(start!.data.message.usage.input_tokens).toBeGreaterThan(0);
  });

  it("SSE message stream begins with message_start", async () => {
    const res = await request(app()).post("/anthropic/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 100, stream: true, messages: [{ role: "user", content: "hi" }] });
    expect(res.text).toContain("message_start");
    expect(res.text).toContain('"text":"he"');
    expect(res.text).toContain("message_stop");
  });

  it("text stream opens index-0 text block lazily and closes it before message_stop", async () => {
    const res = await request(app()).post("/anthropic/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 100, stream: true, messages: [{ role: "user", content: "hi" }] });
    const frames = parseFrames(res.text);
    const events = frames.map((f) => f.event);
    // exactly one content_block_start at index 0 of type text
    const starts = frames.filter((f) => f.event === "content_block_start");
    expect(starts).toHaveLength(1);
    expect(starts[0].data.index).toBe(0);
    expect(starts[0].data.content_block.type).toBe("text");
    // a matching content_block_stop, before message_delta/message_stop
    expect(events.filter((e) => e === "content_block_stop")).toHaveLength(1);
    expect(events.indexOf("content_block_stop")).toBeLessThan(events.indexOf("message_delta"));
    expect(events.indexOf("message_delta")).toBeLessThan(events.indexOf("message_stop"));
    expect(events[events.length - 1]).toBe("message_stop");
  });

  it("pure tool-call stream: no phantom text block at index 0, tool opens+closes at its own index", async () => {
    const toolProvider: ProviderAdapter = {
      name: "copilot",
      complete: async () => ({ id: "c1", model: "m", content: [], finishReason: "tool_use", usage: { promptTokens: 1, completionTokens: 1 } }),
      async *stream(): AsyncIterable<CanonicalChunk> {
        yield { kind: "tool_use_start", index: 0, id: "tu1", name: "now", done: false };
        yield { kind: "tool_use_delta", index: 0, argsDelta: '{"x":1}', done: false };
        yield { kind: "done", done: true, finishReason: "tool_use" };
      },
    };
    const res = await request(app(toolProvider)).post("/anthropic/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 100, stream: true, messages: [{ role: "user", content: "go" }] });
    const frames = parseFrames(res.text);
    const events = frames.map((f) => f.event);

    // (a) no phantom empty TEXT content_block_start at index 0
    const textStarts = frames.filter((f) => f.event === "content_block_start" && f.data.content_block?.type === "text");
    expect(textStarts).toHaveLength(0);

    // (b) exactly one tool_use content_block_start, at its own index (0 here), with matching stop
    const toolStarts = frames.filter((f) => f.event === "content_block_start" && f.data.content_block?.type === "tool_use");
    expect(toolStarts).toHaveLength(1);
    expect(toolStarts[0].data.index).toBe(0);
    expect(toolStarts[0].data.content_block.name).toBe("now");
    expect(events.filter((e) => e === "content_block_stop")).toHaveLength(1);

    // the input_json_delta arrives between start and stop
    const startIdx = events.indexOf("content_block_start");
    const stopIdx = events.indexOf("content_block_stop");
    const deltaIdx = events.indexOf("content_block_delta");
    expect(startIdx).toBeLessThan(deltaIdx);
    expect(deltaIdx).toBeLessThan(stopIdx);
    expect(res.text).toContain("input_json_delta");

    // (c) correct ordering: starts with message_start, ends with message_stop, stop before message_delta
    expect(events[0]).toBe("message_start");
    expect(events[events.length - 1]).toBe("message_stop");
    expect(stopIdx).toBeLessThan(events.indexOf("message_delta"));
    // stop_reason propagated as tool_use
    const delta = frames.find((f) => f.event === "message_delta");
    expect(delta?.data.delta.stop_reason).toBe("tool_use");
  });

  it("mixed text+tool stream: leading text claims index 0, tool claims index 1, both stop, stop_reason=tool_use", async () => {
    const mixedProvider: ProviderAdapter = {
      name: "copilot",
      complete: async () => ({ id: "c1", model: "m", content: [{ type: "text", text: "let me check" }, { type: "tool_use", id: "tu1", name: "now", input: { x: 1 } }], finishReason: "tool_use", usage: { promptTokens: 2, completionTokens: 2 } }),
      async *stream(): AsyncIterable<CanonicalChunk> {
        yield { kind: "text", delta: "let me ", done: false };
        yield { kind: "text", delta: "check", done: false };
        yield { kind: "tool_use_start", index: 0, id: "tu1", name: "now", done: false };
        yield { kind: "tool_use_delta", index: 0, argsDelta: '{"x":1}', done: false };
        yield { kind: "done", done: true, finishReason: "tool_use" };
      },
    };
    const res = await request(app(mixedProvider)).post("/anthropic/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 100, stream: true, messages: [{ role: "user", content: "go" }] });
    const frames = parseFrames(res.text);
    const events = frames.map((f) => f.event);

    // text block opens at Anthropic index 0
    const textStart = frames.find((f) => f.event === "content_block_start" && f.data.content_block?.type === "text");
    expect(textStart).toBeDefined();
    expect(textStart!.data.index).toBe(0);

    // tool block opens at Anthropic index 1 (NOT colliding with text@0, NOT a static +1 either — sequential alloc)
    const toolStart = frames.find((f) => f.event === "content_block_start" && f.data.content_block?.type === "tool_use");
    expect(toolStart).toBeDefined();
    expect(toolStart!.data.index).toBe(1);
    expect(toolStart!.data.content_block.name).toBe("now");

    // exactly two block starts and two matching stops (one per allocated index)
    expect(frames.filter((f) => f.event === "content_block_start")).toHaveLength(2);
    const stops = frames.filter((f) => f.event === "content_block_stop");
    expect(stops).toHaveLength(2);
    expect(stops.map((f) => f.data.index).sort((a: number, b: number) => a - b)).toEqual([0, 1]);

    // text_delta routes to index 0, input_json_delta routes to index 1
    const textDelta = frames.find((f) => f.event === "content_block_delta" && f.data.delta?.type === "text_delta");
    expect(textDelta!.data.index).toBe(0);
    const jsonDelta = frames.find((f) => f.event === "content_block_delta" && f.data.delta?.type === "input_json_delta");
    expect(jsonDelta!.data.index).toBe(1);

    // ordering: message_start first, all content_block_stop before message_delta, message_stop last
    expect(events[0]).toBe("message_start");
    expect(events[events.length - 1]).toBe("message_stop");
    const lastStop = events.lastIndexOf("content_block_stop");
    expect(lastStop).toBeLessThan(events.indexOf("message_delta"));
    expect(frames.find((f) => f.event === "message_delta")?.data.delta.stop_reason).toBe("tool_use");
  });

  it("count_tokens returns a positive input_tokens estimate", async () => {
    const res = await request(app()).post("/anthropic/v1/messages/count_tokens").send({ model: "claude-opus-4-8", messages: [{ role: "user", content: "hello world this is a longer prompt" }] });
    expect(res.status).toBe(200);
    expect(typeof res.body.input_tokens).toBe("number");
    expect(res.body.input_tokens).toBeGreaterThan(0);
  });

  it("emits an Anthropic error SSE frame (not a silent close) when the provider stream throws mid-stream", async () => {
    const failing: ProviderAdapter = {
      name: "copilot",
      complete: async () => ({ id: "c1", model: "m", content: [], finishReason: "error", usage: { promptTokens: 0, completionTokens: 0 } }),
      async *stream(): AsyncIterable<CanonicalChunk> {
        yield { kind: "text", delta: "partial ", done: false };
        throw new Error("context_length_exceeded: prompt is too long");
      },
    };
    const res = await request(app(failing)).post("/anthropic/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 100, stream: true, messages: [{ role: "user", content: "hi" }] });
    const frames = parseFrames(res.text);
    const events = frames.map((f) => f.event);
    // the stream must surface the failure as an Anthropic `error` event, not just stop
    expect(events).toContain("error");
    const err = frames.find((f) => f.event === "error");
    expect(err!.data.type).toBe("error");
    expect(err!.data.error.message).toMatch(/context_length_exceeded/);
  });

  // #50 P1: an unknown/typo'd model id hits an upstream 400 (model_not_supported). Before the fix the
  // worker masked EVERY error as a retriable api_error / 502, so a client (Claude Code) retried it to
  // its 90s turn timeout and FROZE. A permanent 4xx must surface as a TERMINAL invalid_request_error so
  // the client fails fast — this is the never-freeze north-star.
  it("surfaces an upstream 4xx as a terminal invalid_request_error SSE frame (no retry → no freeze)", async () => {
    const badModel: ProviderAdapter = {
      name: "copilot",
      complete: async () => { throw new UpstreamError(400, "copilot completion failed: 400 — model_not_supported"); },
      async *stream(): AsyncIterable<CanonicalChunk> {
        throw new UpstreamError(400, "copilot stream failed: 400 — model_not_supported");
        // eslint-disable-next-line no-unreachable
        yield { kind: "done", done: true, finishReason: "stop" };
      },
    };
    const res = await request(app(badModel)).post("/anthropic/v1/messages").send({ model: "not-a-real-model", max_tokens: 100, stream: true, messages: [{ role: "user", content: "hi" }] });
    const err = parseFrames(res.text).find((f) => f.event === "error");
    expect(err).toBeDefined();
    // The type is the retry signal: invalid_request_error is terminal (client won't retry); api_error is not.
    expect(err!.data.error.type).toBe("invalid_request_error");
    expect(err!.data.error.message).toMatch(/model.*not supported|model_not_supported/i);
  });

  it("returns HTTP 400 (not 502) for an upstream 4xx on a NON-stream request", async () => {
    const badModel: ProviderAdapter = {
      name: "copilot",
      complete: async () => { throw new UpstreamError(400, "copilot completion failed: 400 — model_not_supported"); },
      async *stream(): AsyncIterable<CanonicalChunk> { yield { kind: "done", done: true, finishReason: "stop" }; },
    };
    const res = await request(app(badModel)).post("/anthropic/v1/messages").send({ model: "not-a-real-model", max_tokens: 100, messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(400);
    expect(res.body.error.type).toBe("invalid_request_error");
  });

  it("keeps a retriable upstream 5xx as a 502 api_error (only 4xx is terminal)", async () => {
    const flaky: ProviderAdapter = {
      name: "copilot",
      complete: async () => { throw new UpstreamError(503, "copilot completion failed: 503 — upstream busy"); },
      async *stream(): AsyncIterable<CanonicalChunk> { yield { kind: "done", done: true, finishReason: "stop" }; },
    };
    const res = await request(app(flaky)).post("/anthropic/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 100, messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(502);
    expect(res.body.error.type).toBe("api_error");
  });

  it("cuts a degenerate repeating stream cleanly (stop_reason max_tokens, ends, never tool_use)", async () => {
    let emitted = 0;
    const runaway: ProviderAdapter = {
      name: "copilot",
      complete: async () => ({ id: "c1", model: "m", content: [], finishReason: "stop", usage: { promptTokens: 0, completionTokens: 0 } }),
      // Mimics model degeneration: the same short token forever, never a `done`. Hard cap at 5000
      // so a regressed guard fails fast instead of hanging the test runner.
      async *stream(): AsyncIterable<CanonicalChunk> {
        for (let i = 0; i < 5000; i++) { emitted++; yield { kind: "text", delta: "code\n", done: false }; }
        yield { kind: "done", done: true, finishReason: "stop" };
      },
    };
    const res = await request(app(runaway)).post("/anthropic/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 100, stream: true, messages: [{ role: "user", content: "hi" }] });
    const frames = parseFrames(res.text);
    const events = frames.map((f) => f.event);
    expect(events).toContain("message_stop");                       // terminated, not hung
    expect(emitted).toBeLessThan(5000);                             // guard cut it well before the cap
    const delta = frames.find((f) => f.event === "message_delta");
    expect(delta!.data.delta.stop_reason).toBe("max_tokens");       // clean truncation, native-feel
  });

  it("records a runaway turn as a reportable metric (200 with a runaway reason)", async () => {
    const runaway: ProviderAdapter = {
      name: "copilot",
      complete: async () => ({ id: "c1", model: "m", content: [], finishReason: "stop", usage: { promptTokens: 0, completionTokens: 0 } }),
      async *stream(): AsyncIterable<CanonicalChunk> {
        for (let i = 0; i < 5000; i++) yield { kind: "text", delta: "code\n", done: false };
        yield { kind: "done", done: true, finishReason: "stop" };
      },
    };
    const metrics: { status: number; error?: string }[] = [];
    const a = createWorkerApp(new Router([runaway], { "*": "gpt-4o" }), (m) => { metrics.push(m); });
    await request(a).post("/anthropic/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 100, stream: true, messages: [{ role: "user", content: "hi" }] });
    expect(metrics.at(-1)?.status).toBe(200);                        // still a 200 — answer was delivered, just truncated
    expect(metrics.at(-1)?.error).toMatch(/runaway.*repetition/);    // tagged so /report + /logs surface it
  });

  it("records the failure message in the metric when a streaming request throws", async () => {
    const failing: ProviderAdapter = {
      name: "copilot",
      complete: async () => ({ id: "c1", model: "m", content: [], finishReason: "error", usage: { promptTokens: 0, completionTokens: 0 } }),
      async *stream(): AsyncIterable<CanonicalChunk> {
        yield { kind: "text", delta: "x", done: false };
        throw new Error("context_length_exceeded");
      },
    };
    const metrics: { status: number; error?: string }[] = [];
    const sink = (m: { status: number; error?: string }) => { metrics.push(m); };
    const a = createWorkerApp(new Router([failing], { "*": "gpt-4o" }), sink);
    await request(a).post("/anthropic/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 100, stream: true, messages: [{ role: "user", content: "hi" }] });
    expect(metrics.at(-1)?.status).toBe(502);
    expect(metrics.at(-1)?.error).toMatch(/context_length_exceeded/);
  });

  it("text + two tools: contiguous indices [0,1,2], deltas routed to mapped indices, three stops", async () => {
    const multiProvider: ProviderAdapter = {
      name: "copilot",
      complete: async () => ({ id: "c1", model: "m", content: [], finishReason: "tool_use", usage: { promptTokens: 1, completionTokens: 1 } }),
      async *stream(): AsyncIterable<CanonicalChunk> {
        yield { kind: "text", delta: "checking both", done: false };
        yield { kind: "tool_use_start", index: 0, id: "tuA", name: "alpha", done: false };
        yield { kind: "tool_use_delta", index: 0, argsDelta: '{"a":1}', done: false };
        yield { kind: "tool_use_start", index: 1, id: "tuB", name: "beta", done: false };
        yield { kind: "tool_use_delta", index: 1, argsDelta: '{"b":2}', done: false };
        yield { kind: "done", done: true, finishReason: "tool_use" };
      },
    };
    const res = await request(app(multiProvider)).post("/anthropic/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 100, stream: true, messages: [{ role: "user", content: "go" }] });
    const frames = parseFrames(res.text);

    const starts = frames.filter((f) => f.event === "content_block_start");
    expect(starts.map((f) => f.data.index)).toEqual([0, 1, 2]);
    expect(starts[0].data.content_block.type).toBe("text");
    expect(starts[1].data.content_block).toMatchObject({ type: "tool_use", name: "alpha" });
    expect(starts[2].data.content_block).toMatchObject({ type: "tool_use", name: "beta" });

    // text_delta -> 0, alpha's input_json_delta -> 1, beta's -> 2
    expect(frames.find((f) => f.event === "content_block_delta" && f.data.delta?.type === "text_delta")!.data.index).toBe(0);
    const jsonDeltas = frames.filter((f) => f.event === "content_block_delta" && f.data.delta?.type === "input_json_delta");
    expect(jsonDeltas.map((f) => f.data.index)).toEqual([1, 2]);
    expect(jsonDeltas[0].data.delta.partial_json).toBe('{"a":1}');
    expect(jsonDeltas[1].data.delta.partial_json).toBe('{"b":2}');

    // three stops, ascending, all before message_delta
    const stops = frames.filter((f) => f.event === "content_block_stop");
    expect(stops.map((f) => f.data.index)).toEqual([0, 1, 2]);
    const events = frames.map((f) => f.event);
    expect(events.lastIndexOf("content_block_stop")).toBeLessThan(events.indexOf("message_delta"));
    expect(events[events.length - 1]).toBe("message_stop");
  });

  it("GET /anthropic/v1/models returns the model list in Anthropic list shape (fixes the connection-test 404)", async () => {
    const res = await request(app()).get("/anthropic/v1/models");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data[0]).toMatchObject({ type: "model" });
    expect(typeof res.body.data[0].id).toBe("string");
    expect(res.body.has_more).toBe(false);
  });

  it("publishes native Claude aliases only for live mapped GPT targets", async () => {
    const router = new Router([textProvider], {}, { claudeMapEnabled: true });
    router.setAvailableModels(["gpt-5.6-sol", "gpt-4o"]);
    router.setModelLimits({ "gpt-5.6-sol": 1_100_000 });
    const res = await request(createWorkerApp(router, () => {})).get("/anthropic/v1/models");
    expect(res.body.data).toEqual([
      { type: "model", id: "gpt-5.6-sol", display_name: "gpt-5.6-sol" },
      { type: "model", id: "gpt-4o", display_name: "gpt-4o" },
      { type: "model", id: "claude-opus-5[1m]", display_name: "Opus 5" },
    ]);
  });

  it("resolves a mapped Claude alias before the provider and records the GPT backend metric", async () => {
    let seen = "";
    const metrics: Array<{ model: string }> = [];
    const capture: ProviderAdapter = {
      name: "copilot",
      complete: async (req) => { seen = req.model; return { id: "c1", model: req.model, content: [{ type: "text", text: "ok" }], finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 } }; },
      async *stream() { yield { kind: "done", done: true, finishReason: "stop" } as const; },
    };
    const router = new Router([capture], {}, { claudeMapEnabled: true });
    router.setAvailableModels(["gpt-5.6-sol"]);
    const res = await request(createWorkerApp(router, (m) => metrics.push(m))).post("/anthropic/v1/messages")
      .send({ model: "claude-opus-5[1m]", max_tokens: 16, messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
    expect(seen).toBe("gpt-5.6-sol");
    expect(metrics.at(-1)?.model).toBe("gpt-5.6-sol");
  });
});

describe("worker Anthropic endpoint — extended thinking (#33)", () => {
  // Provider that streams reasoning (thinking) deltas before the answer text, plus a non-stream
  // complete() that returns a leading thinking block — mirroring Copilot's reasoning_text shape.
  const thinkingProvider: ProviderAdapter = {
    name: "copilot",
    complete: async () => ({ id: "c1", model: "m", content: [{ type: "thinking", text: "let me reason", opaque: "SIG" }, { type: "text", text: "the answer" }], finishReason: "stop", usage: { promptTokens: 2, completionTokens: 2 } }),
    async *stream(): AsyncIterable<CanonicalChunk> {
      yield { kind: "thinking", delta: "let me ", opaque: "SIG", done: false };
      yield { kind: "thinking", delta: "reason", done: false };
      yield { kind: "text", delta: "the answer", done: false };
      yield { kind: "done", done: true, finishReason: "stop" };
    },
  };

  it("streams a thinking block at index 0 (thinking_delta) before the text block at index 1", async () => {
    const res = await request(app(thinkingProvider)).post("/anthropic/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 100, stream: true, thinking: { type: "enabled", budget_tokens: 8000 }, messages: [{ role: "user", content: "hard" }] });
    const frames = parseFrames(res.text);
    const starts = frames.filter((f) => f.event === "content_block_start");
    // thinking opens at index 0, text at index 1
    expect(starts[0].data.index).toBe(0);
    expect(starts[0].data.content_block.type).toBe("thinking");
    // native shape: the thinking block opens with empty thinking + signature strings (Anthropic parity)
    expect(starts[0].data.content_block).toEqual({ type: "thinking", thinking: "", signature: "" });
    expect(starts[1].data.content_block.type).toBe("text");
    expect(starts[1].data.index).toBe(1);
    // thinking content arrives as thinking_delta on index 0
    const thinkingDeltas = frames.filter((f) => f.event === "content_block_delta" && f.data.delta?.type === "thinking_delta");
    expect(thinkingDeltas.map((f) => f.data.delta.thinking).join("")).toBe("let me reason");
    expect(thinkingDeltas.every((f) => f.data.index === 0)).toBe(true);
    // and the answer text routes to index 1
    const textDelta = frames.find((f) => f.event === "content_block_delta" && f.data.delta?.type === "text_delta");
    expect(textDelta!.data.index).toBe(1);
  });

  it("non-stream: a leading thinking block maps to an Anthropic thinking content block", async () => {
    const res = await request(app(thinkingProvider)).post("/anthropic/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 100, thinking: { type: "enabled", budget_tokens: 8000 }, messages: [{ role: "user", content: "hard" }] });
    expect(res.status).toBe(200);
    expect(res.body.content[0]).toMatchObject({ type: "thinking", thinking: "let me reason" });
    expect(res.body.content[1]).toMatchObject({ type: "text", text: "the answer" });
  });

  it("echoes the resolved effort in the x-copilot-reverse-effort response header (observability + e2e signal)", async () => {
    // The header reflects the effort the proxy actually applied — what a `curl -i` (or the CLI e2e)
    // can read back. Driven by the REAL wire shape: output_config.effort.
    for (const eff of ["low", "high", "max", "xhigh"]) {
      const res = await request(app(thinkingProvider)).post("/anthropic/v1/messages")
        .send({ model: "claude-opus-4-8", max_tokens: 50, output_config: { effort: eff }, thinking: { type: "adaptive" }, messages: [{ role: "user", content: "hi" }] });
      expect(res.headers["x-copilot-reverse-effort"]).toBe(eff);
    }
  });

  it("omits the effort header when no reasoning is requested (plain turn unaffected)", async () => {
    const res = await request(app(thinkingProvider)).post("/anthropic/v1/messages")
      .send({ model: "claude-opus-4-8", max_tokens: 50, messages: [{ role: "user", content: "hi" }] });
    expect(res.headers["x-copilot-reverse-effort"]).toBeUndefined();
  });
});

describe("worker Anthropic endpoint — gateway tool loop (web_search/web_fetch)", () => {
  // A provider that calls web_search on turn 1, then answers with text on turn 2. Tracks how many
  // times stream() ran so we can assert the gateway looped (ran the tool) rather than forwarding it.
  function twoTurnProvider(): { adapter: ProviderAdapter; turns: () => number } {
    let turn = 0;
    const adapter: ProviderAdapter = {
      name: "copilot",
      complete: async () => ({ id: "c", model: "m", content: [{ type: "text", text: "final" }], finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 } }),
      async *stream(): AsyncIterable<CanonicalChunk> {
        turn++;
        if (turn === 1) {
          yield { kind: "tool_use_start", index: 0, id: "tu1", name: "web_search", done: false };
          yield { kind: "tool_use_delta", index: 0, argsDelta: '{"query":"node lts"}', done: false };
          yield { kind: "done", done: true, finishReason: "tool_use" };
        } else {
          yield { kind: "text", delta: "Node 24 is LTS", done: false };
          yield { kind: "done", done: true, finishReason: "stop" };
        }
      },
    };
    return { adapter, turns: () => turn };
  }

  const appWithRunner = (p: ProviderAdapter, runner: (name: string, input: unknown) => Promise<string>) =>
    createWorkerApp(new Router([p], { "*": "gpt-4o" }), () => {}, runner);

  it("runs web_search internally and streams only the final text (transparent to the client)", async () => {
    const { adapter, turns } = twoTurnProvider();
    const calls: { name: string; input: any }[] = [];
    const runner = async (name: string, input: unknown) => { calls.push({ name, input }); return "RESULT: Node 24.x is the current LTS"; };
    const res = await request(appWithRunner(adapter, runner))
      .post("/anthropic/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 100, stream: true, messages: [{ role: "user", content: "what is node lts" }] });
    const frames = parseFrames(res.text);

    // gateway ran the tool once, with the model's args, and looped (2 provider turns)
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("web_search");
    expect(calls[0].input).toMatchObject({ query: "node lts" });
    expect(turns()).toBe(2);

    // client never sees the web_search tool_use block — only the final text
    const toolStarts = frames.filter((f) => f.event === "content_block_start" && f.data.content_block?.type === "tool_use");
    expect(toolStarts).toHaveLength(0);
    expect(res.text).toContain("Node 24 is LTS");
    // finishes as a normal end_turn, not tool_use (the tool was consumed internally)
    expect(frames.find((f) => f.event === "message_delta")?.data.delta.stop_reason).toBe("end_turn");
    expect(frames.at(-1)?.event).toBe("message_stop");
  });

  it("still forwards CLIENT tools (Read/Bash) to the client unchanged", async () => {
    const clientToolProvider: ProviderAdapter = {
      name: "copilot",
      complete: async () => ({ id: "c", model: "m", content: [], finishReason: "tool_use", usage: { promptTokens: 1, completionTokens: 1 } }),
      async *stream(): AsyncIterable<CanonicalChunk> {
        yield { kind: "tool_use_start", index: 0, id: "tu1", name: "Read", done: false };
        yield { kind: "tool_use_delta", index: 0, argsDelta: '{"path":"a.ts"}', done: false };
        yield { kind: "done", done: true, finishReason: "tool_use" };
      },
    };
    const runner = async () => "should not be called";
    const res = await request(appWithRunner(clientToolProvider, runner))
      .post("/anthropic/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 100, stream: true, messages: [{ role: "user", content: "read a.ts" }] });
    const frames = parseFrames(res.text);
    const toolStarts = frames.filter((f) => f.event === "content_block_start" && f.data.content_block?.type === "tool_use");
    expect(toolStarts).toHaveLength(1);
    expect(toolStarts[0].data.content_block.name).toBe("Read");
    expect(frames.find((f) => f.event === "message_delta")?.data.delta.stop_reason).toBe("tool_use");
  });

  it("caps the loop so a tool-call-forever provider can't run unbounded", async () => {
    const loopForever: ProviderAdapter = {
      name: "copilot",
      complete: async () => ({ id: "c", model: "m", content: [], finishReason: "tool_use", usage: { promptTokens: 1, completionTokens: 1 } }),
      async *stream(): AsyncIterable<CanonicalChunk> {
        yield { kind: "tool_use_start", index: 0, id: "tu1", name: "web_search", done: false };
        yield { kind: "tool_use_delta", index: 0, argsDelta: '{"query":"x"}', done: false };
        yield { kind: "done", done: true, finishReason: "tool_use" };
      },
    };
    let n = 0;
    const runner = async () => { n++; return "more"; };
    const res = await request(appWithRunner(loopForever, runner))
      .post("/anthropic/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 100, stream: true, messages: [{ role: "user", content: "go" }] });
    // bounded: the runner is invoked a small, finite number of times, and the stream still terminates
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(5);
    expect(parseFrames(res.text).at(-1)?.event).toBe("message_stop");
  });

  it("a web_search that hits the loop cap must NOT leak a tool_use block to the client (stream)", async () => {
    const loopForever: ProviderAdapter = {
      name: "copilot",
      complete: async () => ({ id: "c", model: "m", content: [], finishReason: "tool_use", usage: { promptTokens: 1, completionTokens: 1 } }),
      async *stream(): AsyncIterable<CanonicalChunk> {
        yield { kind: "tool_use_start", index: 0, id: "tu1", name: "web_search", done: false };
        yield { kind: "tool_use_delta", index: 0, argsDelta: '{"query":"x"}', done: false };
        yield { kind: "done", done: true, finishReason: "tool_use" };
      },
    };
    const res = await request(appWithRunner(loopForever, async () => "more"))
      .post("/anthropic/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 100, stream: true, messages: [{ role: "user", content: "go" }] });
    // even when the cap is hit, a gateway tool is never forwarded to the client
    expect(res.text).not.toContain('"name":"web_search"');
    expect(parseFrames(res.text).at(-1)?.event).toBe("message_stop");
  });

  it("mixed gateway + client tools in one turn: runs the gateway tool, forwards ONLY the client tool", async () => {
    let turn = 0;
    const mixed: ProviderAdapter = {
      name: "copilot",
      complete: async () => ({ id: "c", model: "m", content: [], finishReason: "tool_use", usage: { promptTokens: 1, completionTokens: 1 } }),
      async *stream(): AsyncIterable<CanonicalChunk> {
        turn++;
        if (turn === 1) {
          yield { kind: "tool_use_start", index: 0, id: "g1", name: "web_search", done: false };
          yield { kind: "tool_use_delta", index: 0, argsDelta: '{"query":"q"}', done: false };
          yield { kind: "tool_use_start", index: 1, id: "c1", name: "Read", done: false };
          yield { kind: "tool_use_delta", index: 1, argsDelta: '{"path":"a.ts"}', done: false };
          yield { kind: "done", done: true, finishReason: "tool_use" };
        } else {
          // after the gateway result is fed back, the model re-issues just the client tool
          yield { kind: "tool_use_start", index: 0, id: "c2", name: "Read", done: false };
          yield { kind: "tool_use_delta", index: 0, argsDelta: '{"path":"a.ts"}', done: false };
          yield { kind: "done", done: true, finishReason: "tool_use" };
        }
      },
    };
    const calls: string[] = [];
    const res = await request(appWithRunner(mixed, async (name) => { calls.push(name); return "RESULT"; }))
      .post("/anthropic/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 100, stream: true, messages: [{ role: "user", content: "go" }] });
    const frames = parseFrames(res.text);
    // the gateway tool ran and was NOT forwarded; the client tool WAS forwarded
    expect(calls).toContain("web_search");
    expect(res.text).not.toContain('"name":"web_search"');
    const toolStarts = frames.filter((f) => f.event === "content_block_start" && f.data.content_block?.type === "tool_use");
    expect(toolStarts.every((f) => f.data.content_block.name === "Read")).toBe(true);
    expect(toolStarts.length).toBeGreaterThan(0);
  });

  it("non-stream: runs web_search internally and returns the final text (no tool_use leaked)", async () => {
    let turn = 0;
    const twoTurn: ProviderAdapter = {
      name: "copilot",
      async complete() {
        turn++;
        return turn === 1
          ? { id: "c", model: "m", content: [{ type: "tool_use", id: "g1", name: "web_search", input: { query: "q" } }], finishReason: "tool_use", usage: { promptTokens: 1, completionTokens: 1 } }
          : { id: "c", model: "m", content: [{ type: "text", text: "grounded answer" }], finishReason: "stop", usage: { promptTokens: 2, completionTokens: 1 } };
      },
      async *stream(): AsyncIterable<CanonicalChunk> { yield { kind: "done", done: true, finishReason: "stop" }; },
    };
    const calls: string[] = [];
    const res = await request(appWithRunner(twoTurn, async (n) => { calls.push(n); return "RESULT"; }))
      .post("/anthropic/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 100, messages: [{ role: "user", content: "go" }] });
    expect(res.status).toBe(200);
    expect(calls).toEqual(["web_search"]);
    expect(res.body.content.some((b: any) => b.type === "tool_use")).toBe(false);
    expect(res.body.content[0].text).toBe("grounded answer");
    expect(res.body.stop_reason).toBe("end_turn");
  });

  it("non-stream: a web_search that hits the cap must NOT leak a tool_use block to the client", async () => {
    const loopForever: ProviderAdapter = {
      name: "copilot",
      async complete() { return { id: "c", model: "m", content: [{ type: "tool_use", id: "g1", name: "web_search", input: { query: "x" } }], finishReason: "tool_use", usage: { promptTokens: 1, completionTokens: 1 } }; },
      async *stream(): AsyncIterable<CanonicalChunk> { yield { kind: "done", done: true, finishReason: "stop" }; },
    };
    const res = await request(appWithRunner(loopForever, async () => "more"))
      .post("/anthropic/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 100, messages: [{ role: "user", content: "go" }] });
    expect(res.status).toBe(200);
    expect(res.body.content.some((b: any) => b.type === "tool_use")).toBe(false);
  });

  // Reactive 413 fallback: a body that still 413s upstream (despite the proactive budget) must be
  // retried ONCE after force-clearing screenshots, not surfaced as a 502. The provider throws 413 on the
  // first call, then succeeds — and the retried request must have had its tool screenshots cleared.
  it("non-stream: an upstream 413 force-clears screenshots and retries once (not a 502)", async () => {
    let calls = 0;
    let secondCallImageCount = -1;
    const flaky413: ProviderAdapter = {
      name: "copilot",
      async complete(req) {
        calls++;
        if (calls === 1) throw new Error("copilot completion failed: 413 — Request Entity Too Large");
        // On the retry, count how many tool_result images survived — the fallback should have cleared them.
        secondCallImageCount = req.messages.flatMap((m) => m.content).filter((b) => b.type === "tool_result").flatMap((b: any) => b.images ?? []).length;
        return { id: "c1", model: "m", content: [{ type: "text", text: "recovered" }], finishReason: "stop", usage: { promptTokens: 2, completionTokens: 1 } };
      },
      async *stream(): AsyncIterable<CanonicalChunk> { yield { kind: "done", done: true, finishReason: "stop" }; },
    };
    const img = { type: "base64", media_type: "image/png", data: "A".repeat(1000) };
    const res = await request(app(flaky413)).post("/anthropic/v1/messages").send({
      model: "claude-opus-4-8", max_tokens: 100, messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "s0", name: "shot", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "s0", content: [{ type: "text", text: "shot" }, { type: "image", source: img }] }] },
        { role: "user", content: "what colour?" },
      ],
    });
    expect(calls).toBe(2);                    // retried exactly once
    expect(secondCallImageCount).toBe(0);     // the retry body had its screenshots force-cleared
    expect(res.status).toBe(200);             // recovered, not a 502
    expect(res.body.content[0].text).toBe("recovered");
  });

  it("stream: an upstream 413 on first pull force-clears screenshots and retries once", async () => {
    let calls = 0;
    let secondCallImageCount = -1;
    const flaky413: ProviderAdapter = {
      name: "copilot",
      async complete() { return { id: "c", model: "m", content: [], finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 } }; },
      async *stream(req): AsyncIterable<CanonicalChunk> {
        calls++;
        if (calls === 1) throw new Error("copilot stream failed: 413 — Request Entity Too Large");
        secondCallImageCount = req.messages.flatMap((m) => m.content).filter((b) => b.type === "tool_result").flatMap((b: any) => b.images ?? []).length;
        yield { kind: "text", delta: "ok", done: false };
        yield { kind: "done", done: true, finishReason: "stop" };
      },
    };
    const img = { type: "base64", media_type: "image/png", data: "A".repeat(1000) };
    const res = await request(app(flaky413)).post("/anthropic/v1/messages").send({
      model: "claude-opus-4-8", max_tokens: 100, stream: true, messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "s0", name: "shot", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "s0", content: [{ type: "text", text: "shot" }, { type: "image", source: img }] }] },
        { role: "user", content: "what colour?" },
      ],
    });
    expect(calls).toBe(2);                    // retried once
    expect(secondCallImageCount).toBe(0);     // screenshots force-cleared on the retry
    expect(res.status).toBe(200);
    const frames = parseFrames(res.text);
    expect(frames.some((f) => f.event === "content_block_delta" && f.data.delta?.text === "ok")).toBe(true);
  });
});

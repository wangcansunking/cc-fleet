import { describe, it, expect, vi } from "vitest";
import { CopilotAdapter, isTerminalUpstream } from "../../../src/providers/copilot/adapter.js";
import type { CanonicalRequest } from "../../../src/core/canonical.js";

const tokenStore = { get: async () => "cop" };
const base: CanonicalRequest = { model: "gpt-4o", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], stream: false };

describe("CopilotAdapter", () => {
  it("completes non-stream", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({
      id: "c1", choices: [{ message: { content: "hello" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const a = new CopilotAdapter(tokenStore, f as unknown as typeof fetch);
    const r = await a.complete(base);
    expect(r.content).toEqual([{ type: "text", text: "hello" }]);
    const init = f.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer cop");
  });

  // Copilot occasionally returns 200 with an EMPTY choices array (content-filtered turn, or a
  // 1-token ping that produced nothing). The old code did data.choices[0].message blindly →
  // "Cannot read properties of undefined (reading 'message')" → surfaced as a 502. A choice-less
  // 200 is a valid empty completion: return empty content + a stop finish, never throw.
  it("treats a 200 with empty choices as an empty completion (no throw)", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ id: "c1", choices: [], usage: { prompt_tokens: 3 } }),
      { status: 200, headers: { "content-type": "application/json" } }));
    const a = new CopilotAdapter(tokenStore, f as unknown as typeof fetch);
    const r = await a.complete(base);
    expect(r.content).toEqual([]);
    expect(r.finishReason).toBe("stop");
    expect(r.usage).toEqual({ promptTokens: 3, completionTokens: 0 });
  });
  it("sends a canonical image block as an OpenAI image_url part on the wire", async () => {
    let body: any;
    const f = vi.fn(async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ id: "c1", choices: [{ message: { content: "a cat" }, finish_reason: "stop" }], usage: {} }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const a = new CopilotAdapter(tokenStore, f as unknown as typeof fetch);
    await a.complete({
      model: "gpt-4o", stream: false, maxTokens: 10,
      messages: [{ role: "user", content: [{ type: "text", text: "what is this?" }, { type: "image", dataUrl: "data:image/png;base64,XYZ" }] }],
    });
    expect(body.messages[0].content).toEqual([
      { type: "text", text: "what is this?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,XYZ" } },
    ]);
  });

  it("expands parallel tool_results into one OpenAI tool message each (matched tool_call_ids)", async () => {
    let body: any;
    const f = vi.fn(async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ id: "c1", choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: {} }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const a = new CopilotAdapter(tokenStore, f as unknown as typeof fetch);
    await a.complete({
      model: "gpt-4o", stream: false, maxTokens: 10,
      messages: [
        { role: "user", content: [{ type: "text", text: "go" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "A", name: "f", input: {} }, { type: "tool_use", id: "B", name: "g", input: {} }] },
        { role: "tool", content: [{ type: "tool_result", toolUseId: "A", content: "ra" }, { type: "tool_result", toolUseId: "B", content: "rb" }] },
      ],
    });
    const toolMsgs = body.messages.filter((m: any) => m.role === "tool");
    // both tool_use ids must have a matching tool_result message — not just the first
    expect(toolMsgs.map((m: any) => m.tool_call_id)).toEqual(["A", "B"]);
    expect(toolMsgs.map((m: any) => m.content)).toEqual(["ra", "rb"]);
  });

  it("sends a tool_result's images inline as a multipart tool message (Copilot accepts tool-msg images)", async () => {
    let body: any;
    const f = vi.fn(async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ id: "c1", choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: {} }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const a = new CopilotAdapter(tokenStore, f as unknown as typeof fetch);
    await a.complete({
      model: "gpt-4o", stream: false, maxTokens: 10,
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "A", name: "shot", input: {} }] },
        { role: "tool", content: [{ type: "tool_result", toolUseId: "A", content: "screenshot:", images: ["data:image/png;base64,IMG"] }] },
      ],
    });
    const toolMsg = body.messages.find((m: any) => m.role === "tool");
    expect(toolMsg.content).toEqual([
      { type: "text", text: "screenshot:" },
      { type: "image_url", image_url: { url: "data:image/png;base64,IMG" } },
    ]);
  });

  it("streams text deltas", async () => {
    const sse = 'data: {"choices":[{"delta":{"content":"he"}}]}\n\n' + 'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n' + "data: [DONE]\n\n";
    const f = vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const a = new CopilotAdapter(tokenStore, f as unknown as typeof fetch);
    let out = "";
    for await (const c of a.stream({ ...base, stream: true })) if (c.kind === "text") out += c.delta;
    expect(out).toBe("hello");
  });

  it("captures usage + finish_reason from the final stream frame", async () => {
    const sse =
      'data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n' +
      'data: {"choices":[{"finish_reason":"length","index":0,"delta":{}}],"usage":{"prompt_tokens":40,"completion_tokens":8,"prompt_tokens_details":{"cached_tokens":5}}}\n\n' +
      "data: [DONE]\n\n";
    const f = vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const a = new CopilotAdapter(tokenStore, f as unknown as typeof fetch);
    let done: any;
    for await (const c of a.stream({ ...base, stream: true })) if (c.done) done = c;
    expect(done.finishReason).toBe("length");
    expect(done.usage).toEqual({ promptTokens: 40, completionTokens: 8, cachedTokens: 5 });
  });

  it("requests stream_options.include_usage on streaming calls", async () => {
    let body: any;
    const f = vi.fn(async (_u: string, init: RequestInit) => { body = JSON.parse(init.body as string); return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }); });
    const a = new CopilotAdapter(tokenStore, f as unknown as typeof fetch);
    for await (const _ of a.stream({ ...base, stream: true })) { /* drain */ }
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  // --- Reasoning passthrough (#33): the canonical reasoning.effort becomes a top-level
  // reasoning_effort on the /chat body, and upstream reasoning_text/reasoning_opaque deltas are
  // surfaced as canonical `thinking` chunks (parallel to text).
  it("sends reasoning.effort as a top-level reasoning_effort on the /chat body", async () => {
    let body: any;
    const f = vi.fn(async (_u: string, init: RequestInit) => { body = JSON.parse(init.body as string); return new Response(JSON.stringify({ id: "c1", choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: {} }), { status: 200, headers: { "content-type": "application/json" } }); });
    const a = new CopilotAdapter(tokenStore, f as unknown as typeof fetch);
    await a.complete({ ...base, reasoning: { effort: "high" } });
    expect(body.reasoning_effort).toBe("high");
  });

  it("omits reasoning_effort when no reasoning is requested", async () => {
    let body: any;
    const f = vi.fn(async (_u: string, init: RequestInit) => { body = JSON.parse(init.body as string); return new Response(JSON.stringify({ id: "c1", choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: {} }), { status: 200, headers: { "content-type": "application/json" } }); });
    const a = new CopilotAdapter(tokenStore, f as unknown as typeof fetch);
    await a.complete(base);
    expect("reasoning_effort" in body).toBe(false);
  });

  // Sending reasoning_effort to a model that doesn't advertise it (e.g. gpt-4o) is a hard 400
  // (`invalid_reasoning_effort`). The adapter gates the field on the supportsReasoning fn (from /models
  // capabilities). Regression #45: claude -p defaults to gpt-4o and sends effort=high → every turn 400'd.
  it("omits reasoning_effort for a model that does not advertise it (gpt-4o)", async () => {
    let body: any;
    const f = vi.fn(async (_u: string, init: RequestInit) => { body = JSON.parse(init.body as string); return new Response(JSON.stringify({ id: "c1", choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: {} }), { status: 200, headers: { "content-type": "application/json" } }); });
    const a = new CopilotAdapter(tokenStore, f as unknown as typeof fetch, () => [], (m) => m !== "gpt-4o");
    await a.complete({ ...base, reasoning: { effort: "high" } }); // base is gpt-4o
    expect("reasoning_effort" in body).toBe(false);
  });
  it("still sends reasoning_effort for a model that DOES advertise it", async () => {
    let body: any;
    const f = vi.fn(async (_u: string, init: RequestInit) => { body = JSON.parse(init.body as string); return new Response(JSON.stringify({ id: "c1", choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: {} }), { status: 200, headers: { "content-type": "application/json" } }); });
    const a = new CopilotAdapter(tokenStore, f as unknown as typeof fetch, () => ["/v1/messages", "/chat/completions"], (m) => m === "claude-opus-4.8");
    await a.complete({ model: "claude-opus-4.8", stream: false, messages: base.messages, reasoning: { effort: "high" } });
    expect(body.reasoning_effort).toBe("high");
  });
  it("clamps Claude's max effort to the mapped backend's advertised ceiling", async () => {
    let body: any;
    const f = vi.fn(async (_u: string, init: RequestInit) => { body = JSON.parse(init.body as string); return new Response(JSON.stringify({ id: "c1", choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: {} }), { status: 200, headers: { "content-type": "application/json" } }); });
    const a = new CopilotAdapter(tokenStore, f as unknown as typeof fetch, () => ["/chat/completions"], () => true, () => ["none", "low", "medium", "high", "xhigh"]);
    await a.complete({ model: "gpt-5.4", stream: false, messages: base.messages, reasoning: { effort: "max" } });
    expect(body.reasoning_effort).toBe("xhigh");
  });
  it("defaults to sending reasoning_effort when support is unknown (no fn / pre-discovery)", async () => {
    let body: any;
    const f = vi.fn(async (_u: string, init: RequestInit) => { body = JSON.parse(init.body as string); return new Response(JSON.stringify({ id: "c1", choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: {} }), { status: 200, headers: { "content-type": "application/json" } }); });
    const a = new CopilotAdapter(tokenStore, f as unknown as typeof fetch); // no supportsReasoning fn
    await a.complete({ ...base, reasoning: { effort: "high" } });
    expect(body.reasoning_effort).toBe("high"); // don't silently drop a reasoning turn before discovery
  });

  it("surfaces streamed reasoning_text as canonical thinking chunks (before the answer text)", async () => {
    const sse =
      'data: {"choices":[{"delta":{"reasoning_text":"let me "}}]}\n\n' +
      'data: {"choices":[{"delta":{"reasoning_text":"think"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n' +
      "data: [DONE]\n\n";
    const f = vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const a = new CopilotAdapter(tokenStore, f as unknown as typeof fetch);
    const chunks: any[] = [];
    for await (const c of a.stream({ ...base, stream: true })) chunks.push(c);
    const thinking = chunks.filter((c) => c.kind === "thinking").map((c) => c.delta).join("");
    const text = chunks.filter((c) => c.kind === "text").map((c) => c.delta).join("");
    expect(thinking).toBe("let me think");
    expect(text).toBe("answer");
  });

  it("carries reasoning_opaque on the thinking chunk that bears it", async () => {
    const sse =
      'data: {"choices":[{"delta":{"reasoning_text":"hmm","reasoning_opaque":"SIG123"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' +
      "data: [DONE]\n\n";
    const f = vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const a = new CopilotAdapter(tokenStore, f as unknown as typeof fetch);
    const chunks: any[] = [];
    for await (const c of a.stream({ ...base, stream: true })) chunks.push(c);
    const think = chunks.find((c) => c.kind === "thinking");
    expect(think).toMatchObject({ delta: "hmm", opaque: "SIG123" });
  });

  it("echoes a prior assistant thinking block back upstream as reasoning_text + reasoning_opaque", async () => {
    let body: any;
    const f = vi.fn(async (_u: string, init: RequestInit) => { body = JSON.parse(init.body as string); return new Response(JSON.stringify({ id: "c1", choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: {} }), { status: 200, headers: { "content-type": "application/json" } }); });
    const a = new CopilotAdapter(tokenStore, f as unknown as typeof fetch);
    await a.complete({
      model: "gpt-4o", stream: false, maxTokens: 10,
      messages: [
        { role: "user", content: [{ type: "text", text: "go" }] },
        { role: "assistant", content: [{ type: "thinking", text: "earlier reasoning", opaque: "OPAQUE99" }, { type: "text", text: "answer" }] },
        { role: "user", content: [{ type: "text", text: "continue" }] },
      ],
    });
    const asst = body.messages.find((m: any) => m.role === "assistant");
    expect(asst.reasoning_text).toBe("earlier reasoning");
    expect(asst.reasoning_opaque).toBe("OPAQUE99");
    expect(asst.content).toBe("answer");
  });

  it("with several thinking blocks, echoes the LAST opaque-bearing one (Copilot reasoning is singular)", async () => {
    let body: any;
    const f = vi.fn(async (_u: string, init: RequestInit) => { body = JSON.parse(init.body as string); return new Response(JSON.stringify({ id: "c1", choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: {} }), { status: 200, headers: { "content-type": "application/json" } }); });
    const a = new CopilotAdapter(tokenStore, f as unknown as typeof fetch);
    await a.complete({
      model: "gpt-4o", stream: false, maxTokens: 10,
      messages: [
        // a redacted_thinking (empty text) precedes the real reasoning — must NOT echo the empty one
        { role: "assistant", content: [
          { type: "thinking", text: "", opaque: "REDACTED_FIRST" },
          { type: "thinking", text: "real reasoning", opaque: "REAL_LAST" },
          { type: "text", text: "answer" },
        ] },
        { role: "user", content: [{ type: "text", text: "continue" }] },
      ],
    });
    const asst = body.messages.find((m: any) => m.role === "assistant" && m.content === "answer");
    expect(asst.reasoning_text).toBe("real reasoning");
    expect(asst.reasoning_opaque).toBe("REAL_LAST"); // the continuation token closest to the answer
  });

  // --- Inline tool-call recovery: some models emit a tool call as TEXT XML instead of native
  // tool_calls. The adapter must recover it into structured tool chunks when the request has tools.
  // Tags are built via concatenation so no literal close-tag appears in this source file.
  const O = (t: string, a = "") => `<${t}${a}>`;
  const C = (t: string) => `</${t}>`;
  const degraded = O("function_calls") + O("invoke", ' name="Bash"') + O("parameter", ' name="command"') + "ls -la" + C("parameter") + C("invoke") + C("function_calls");
  const sseOf = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n` + "data: [DONE]\n\n";
  const withTools: CanonicalRequest = { ...base, stream: true, tools: [{ name: "Bash", description: "run a shell command", parameters: { type: "object", properties: { command: { type: "string" } } } }] };

  it("recovers an inline tool call emitted as text into structured tool chunks (request has tools)", async () => {
    const f = vi.fn(async () => new Response(sseOf("let me check. " + degraded + " done"), { status: 200, headers: { "content-type": "text/event-stream" } }));
    const a = new CopilotAdapter(tokenStore, f as unknown as typeof fetch);
    const chunks: any[] = [];
    for await (const c of a.stream(withTools)) chunks.push(c);
    const start = chunks.find((c) => c.kind === "tool_use_start");
    const delta = chunks.find((c) => c.kind === "tool_use_delta");
    expect(start).toMatchObject({ name: "Bash" });
    expect(JSON.parse(delta.argsDelta)).toEqual({ command: "ls -la" });
    // surrounding prose still flows as text, tool call no longer leaks as text
    const text = chunks.filter((c) => c.kind === "text").map((c) => c.delta).join("");
    expect(text).toBe("let me check.  done");
    expect(text).not.toContain("invoke");
    // a text-emitted tool call must still report tool_use as the finish reason
    expect(chunks.find((c) => c.done)?.finishReason).toBe("tool_use");
  });

  it("recovers a tool call split across multiple SSE content deltas", async () => {
    const mid = Math.floor(degraded.length / 2);
    const sse =
      `data: ${JSON.stringify({ choices: [{ delta: { content: degraded.slice(0, mid) } }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ delta: { content: degraded.slice(mid) } }] })}\n\n` +
      "data: [DONE]\n\n";
    const f = vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const a = new CopilotAdapter(tokenStore, f as unknown as typeof fetch);
    const chunks: any[] = [];
    for await (const c of a.stream(withTools)) chunks.push(c);
    expect(chunks.find((c) => c.kind === "tool_use_start")).toMatchObject({ name: "Bash" });
    expect(JSON.parse(chunks.find((c) => c.kind === "tool_use_delta").argsDelta)).toEqual({ command: "ls -la" });
  });

  it("recovers an inline tool call even when the request declared NO tools (always-on extraction)", async () => {
    const f = vi.fn(async () => new Response(sseOf("here is the format: " + degraded), { status: 200, headers: { "content-type": "text/event-stream" } }));
    const a = new CopilotAdapter(tokenStore, f as unknown as typeof fetch);
    const chunks: any[] = [];
    for await (const c of a.stream({ ...base, stream: true })) chunks.push(c); // base has no tools
    // A follow-up turn (or a model ignoring the tools field) can still emit XML — recover it anyway.
    expect(chunks.some((c) => c.kind === "tool_use_start" && c.name === "Bash")).toBe(true);
    const text = chunks.filter((c) => c.kind === "text").map((c) => c.delta).join("");
    expect(text).not.toContain("invoke"); // XML consumed, not leaked as literal text
  });

  // --- Endpoint routing: models whose supported_endpoints omit /chat/completions (e.g. gpt-5.5)
  // must be sent to /responses instead. endpointsFor(model) supplies the list; unknown -> chat.
  const responsesObj = (text: string) => JSON.stringify({
    id: "resp_1", model: "gpt-5.5", status: "completed",
    output: [{ type: "message", id: "m", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }],
    usage: { input_tokens: 5, output_tokens: 2 },
  });
  const r55: CanonicalRequest = { model: "gpt-5.5", stream: false, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] };

  it("routes a responses-only model to /responses on complete()", async () => {
    const f = vi.fn(async (url: string) => new Response(responsesObj("from responses"), { status: 200, headers: { "content-type": "application/json" } }));
    const a = new CopilotAdapter(tokenStore, f as unknown as typeof fetch, () => ["/responses"]);
    const r = await a.complete(r55);
    expect((f.mock.calls[0][0] as string)).toBe("https://api.githubcopilot.com/responses");
    expect(r.content).toEqual([{ type: "text", text: "from responses" }]);
    expect(r.usage).toEqual({ promptTokens: 5, completionTokens: 2 });
  });

  it("routes a responses-only model to /responses on stream()", async () => {
    const sse =
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"m","role":"assistant","content":[]}}\n\n' +
      'data: {"type":"response.output_text.delta","output_index":0,"item_id":"m","delta":"hel"}\n\n' +
      'data: {"type":"response.output_text.delta","output_index":0,"item_id":"m","delta":"lo"}\n\n' +
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n';
    const f = vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const a = new CopilotAdapter(tokenStore, f as unknown as typeof fetch, () => ["/responses"]);
    let out = "";
    for await (const c of a.stream({ ...r55, stream: true })) if (c.kind === "text") out += c.delta;
    expect((f.mock.calls[0][0] as string)).toBe("https://api.githubcopilot.com/responses");
    expect(out).toBe("hello");
  });

  it("keeps using /chat/completions when the model supports it (or is unknown)", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ id: "c1", choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: {} }), { status: 200, headers: { "content-type": "application/json" } }));
    const a = new CopilotAdapter(tokenStore, f as unknown as typeof fetch, (m) => m === "gpt-4o" ? ["/chat/completions", "/responses"] : []);
    await a.complete(base); // gpt-4o
    expect((f.mock.calls[0][0] as string)).toBe("https://api.githubcopilot.com/chat/completions");
  });

  it("falls back to /responses once when /chat returns 400 unsupported_api_for_model", async () => {
    const f = vi.fn(async (url: string) => {
      if (url === "https://api.githubcopilot.com/chat/completions") {
        return new Response(JSON.stringify({ error: { code: "unsupported_api_for_model", message: "use responses" } }), { status: 400 });
      }
      return new Response(responsesObj("recovered"), { status: 200, headers: { "content-type": "application/json" } });
    });
    // r55 (gpt-5.5) advertises /responses AND /chat, so the 400 safety net may retry on /responses.
    const a = new CopilotAdapter(tokenStore, f as unknown as typeof fetch, () => ["/responses", "/chat/completions"]);
    const r = await a.complete(r55);
    expect(f.mock.calls.map((c) => c[0])).toEqual([
      "https://api.githubcopilot.com/chat/completions",
      "https://api.githubcopilot.com/responses",
    ]);
    expect(r.content).toEqual([{ type: "text", text: "recovered" }]);
  });

  it("does NOT retry on an unrelated chat 400 (surfaces the error)", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ error: { message: "bad request: oversized" } }), { status: 400 }));
    const a = new CopilotAdapter(tokenStore, f as unknown as typeof fetch, () => ["/responses", "/chat/completions"]);
    await expect(a.complete(r55)).rejects.toThrow();
    expect(f).toHaveBeenCalledTimes(1); // no responses retry (hint regex didn't match)
  });

  // The /responses safety net must fire ONLY for a model that positively advertises /responses (gpt-5.x /
  // mai-code). Probing /models shows every claude, gpt-4o and gemini id is /chat-only — gpt-4o isn't even
  // in the endpoint map. So a /chat 400 whose body happens to match RESPONSES_HINT_RE (a rate-limit body,
  // a big-turn validation error saying "does not support …") must NOT trigger a /responses retry for
  // those models: /responses would reject them ("model X does not support/is not supported via Responses
  // API") and MASK the real /chat error. Regression: a large Claude+image turn AND a default gpt-4o turn
  // both misfired this way.
  const claudeReq: CanonicalRequest = { model: "claude-opus-4.8", stream: false, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] };
  const gpt4oReq: CanonicalRequest = { model: "gpt-4o", stream: false, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] };
  // Real Copilot endpoint shapes: claude carries /v1/messages+/chat, gpt-4o has no entry (undefined).
  const claudeEps = () => ["/v1/messages", "/chat/completions"];
  const gpt4oEps = () => undefined as unknown as string[];
  it("never retries a Claude model on /responses (surfaces the real /chat error)", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ error: { message: "invalid_request_body: does not support this content" } }), { status: 400 }));
    const a = new CopilotAdapter(tokenStore, f as unknown as typeof fetch, claudeEps);
    await expect(a.complete(claudeReq)).rejects.toThrow(/copilot completion failed: 400/); // the real /chat error, not a Responses 400
    expect(f).toHaveBeenCalledTimes(1); // no /responses retry
    expect(f.mock.calls.every((c) => c[0] !== "https://api.githubcopilot.com/responses")).toBe(true);
  });
  it("never retries a Claude model on /responses in stream() either", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ error: { message: "model does not support ..." } }), { status: 400 }));
    const a = new CopilotAdapter(tokenStore, f as unknown as typeof fetch, claudeEps);
    let msg = "";
    try { for await (const _ of a.stream({ ...claudeReq, stream: true })) { /* drain */ } }
    catch (e) { msg = e instanceof Error ? e.message : String(e); }
    expect(msg).toMatch(/copilot stream failed: 400/); // the real /chat error, not a Responses 400
    expect(f).toHaveBeenCalledTimes(1); // no /responses retry
  });
  it("never retries gpt-4o on /responses — surfaces its real /chat 400 (regression #45)", async () => {
    // gpt-4o /chat rate-limited/rejected with a body matching the hint regex must NOT hop to /responses
    // ("gpt-4o is not supported via Responses API"); the true error surfaces instead.
    const f = vi.fn(async () => new Response(JSON.stringify({ error: { code: "unsupported_api_for_model", message: "rate limited" } }), { status: 400 }));
    const a = new CopilotAdapter(tokenStore, f as unknown as typeof fetch, gpt4oEps);
    await expect(a.complete(gpt4oReq)).rejects.toThrow(/copilot completion failed: 400/);
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls.every((c) => c[0] !== "https://api.githubcopilot.com/responses")).toBe(true);
  });
  it("routes a Claude model to /chat (real endpoints carry /chat/completions)", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ id: "c1", choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: {} }), { status: 200, headers: { "content-type": "application/json" } }));
    const a = new CopilotAdapter(tokenStore, f as unknown as typeof fetch, claudeEps);
    await a.complete(claudeReq);
    expect((f.mock.calls[0][0] as string)).toBe("https://api.githubcopilot.com/chat/completions");
  });

  it("flattens a multi-line HTML 502 body to a single-line error message", async () => {
    const html = '<!DOCTYPE html>\n<html>\n  <head><style>body { margin: 0 }</style></head>\n  <body>\n    <h1>502 Bad Gateway</h1>\n  </body>\n</html>';
    const f = vi.fn(async () => new Response(html, { status: 502, headers: { "content-type": "text/html" } }));
    const a = new CopilotAdapter(tokenStore, f as unknown as typeof fetch, () => []);
    let msg = "";
    try { for await (const _ of a.stream({ ...base, stream: true })) { /* drain */ } }
    catch (e) { msg = e instanceof Error ? e.message : String(e); }
    expect(msg).toMatch(/copilot stream failed: 502/);
    expect(msg).not.toMatch(/\n/); // no embedded newlines — won't shatter the /logs card
  });

  // #50 P1: an upstream error must carry its HTTP status so the request handlers can fast-fail a
  // permanent 4xx instead of masking it as a retriable 502 (which freezes the client to its timeout).
  it("throws an UpstreamError carrying the status on a non-stream 4xx (bad model)", async () => {
    const body = JSON.stringify({ error: { message: "The requested model is not supported.", code: "model_not_supported" } });
    const f = vi.fn(async () => new Response(body, { status: 400, headers: { "content-type": "application/json" } }));
    const a = new CopilotAdapter(tokenStore, f as unknown as typeof fetch, () => []);
    await expect(a.complete(base)).rejects.toMatchObject({ name: "UpstreamError", status: 400 });
    expect(isTerminalUpstream(await a.complete(base).catch((e) => e))).toBe(true);
  });
  it("throws an UpstreamError carrying the status on a stream 4xx (bad model)", async () => {
    const body = JSON.stringify({ error: { message: "The requested model is not supported.", code: "model_not_supported" } });
    const f = vi.fn(async () => new Response(body, { status: 400, headers: { "content-type": "application/json" } }));
    const a = new CopilotAdapter(tokenStore, f as unknown as typeof fetch, () => []);
    const err = await (async () => { try { for await (const _ of a.stream({ ...base, stream: true })) { /* drain */ } } catch (e) { return e; } })();
    expect(err).toMatchObject({ name: "UpstreamError", status: 400 });
    expect(isTerminalUpstream(err)).toBe(true);
  });
  // A 429 rate-limit and a 5xx are transient — they must NOT be classified terminal (keep retrying).
  it("classifies a 429 rate-limit and a 502 as non-terminal (retriable)", async () => {
    for (const status of [429, 502, 503]) {
      const f = vi.fn(async () => new Response("busy", { status }));
      const a = new CopilotAdapter(tokenStore, f as unknown as typeof fetch, () => []);
      const err = await a.complete(base).catch((e) => e);
      expect(err).toMatchObject({ name: "UpstreamError", status });
      expect(isTerminalUpstream(err)).toBe(false);
    }
  });
});

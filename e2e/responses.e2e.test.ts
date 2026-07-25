// E2E: Codex speaks the OpenAI Responses API (/openai/responses). These drive the endpoint end-to-end
// through a booted worker — non-stream object shape, the full streaming event sequence, tool calls,
// inbound item round-trip, image input, instructions->system, hosted web_search passthrough, and
// errors — none of which the chat-completions cases cover.
// Case catalog: cases.md. Shared harness: helpers.ts.
import { describe, it, expect } from "vitest";
import request from "supertest";
import { wired, ok, responsesEvents, toolStreamProvider, authFailProvider } from "./helpers.js";
import { recentRequests } from "../src/supervisor/db.js";
import type { ProviderAdapter } from "../src/providers/types.js";

describe("E2E: Codex /responses", () => {
  it("EP-27 non-stream returns a completed response object with output_text + usage", async () => {
    const { worker } = wired(ok);
    const res = await request(worker).post("/openai/responses").send({ model: "gpt-5.5", input: "hi", max_output_tokens: 40 });
    expect(res.status).toBe(200);
    expect(res.body.object).toBe("response");
    expect(res.body.status).toBe("completed");
    const msg = res.body.output.find((o: any) => o.type === "message");
    expect(msg.content[0]).toMatchObject({ type: "output_text", text: "ok" });
    expect(res.body.usage).toMatchObject({ input_tokens: 3, output_tokens: 1, total_tokens: 4 });
  });

  it("EP-28 streaming emits the ordered Responses event sequence with monotonic sequence_number", async () => {
    const withUsage: ProviderAdapter = { name: "copilot", complete: ok.complete, async *stream() { yield { kind: "text", delta: "ok", done: false } as const; yield { kind: "done", done: true, finishReason: "stop", usage: { promptTokens: 5, completionTokens: 2 } } as const; } };
    const { worker } = wired(withUsage);
    const res = await request(worker).post("/openai/responses").send({ model: "gpt-5.5", input: "hi", stream: true, max_output_tokens: 40 });
    const evs = responsesEvents(res.text);
    const types = evs.map((e) => e.type);
    expect(types[0]).toBe("response.created");
    expect(types).toContain("response.output_item.added");
    expect(types).toContain("response.content_part.added");
    expect(types).toContain("response.output_text.delta");
    expect(types).toContain("response.output_text.done");
    expect(types.at(-1)).toBe("response.completed");
    const seqs = evs.map((e) => e.sequence_number);
    expect(seqs.every((n, i) => i === 0 || n > seqs[i - 1])).toBe(true); // strictly increasing
    const completed = evs.find((e) => e.type === "response.completed");
    expect(completed.response.usage).toMatchObject({ input_tokens: 5, output_tokens: 2 });
  });

  it("EP-29 streaming a tool call emits function_call argument events, finish tool_use", async () => {
    const { worker } = wired(toolStreamProvider("get_weather", '{"city":"SF"}', "call_X"));
    const res = await request(worker).post("/openai/responses").send({ model: "gpt-5.5", input: "weather?", stream: true });
    const evs = responsesEvents(res.text);
    const added = evs.find((e) => e.type === "response.output_item.added" && e.item?.type === "function_call");
    expect(added.item).toMatchObject({ call_id: "call_X", name: "get_weather" });
    expect(evs.some((e) => e.type === "response.function_call_arguments.delta")).toBe(true);
    expect(evs.some((e) => e.type === "response.function_call_arguments.done")).toBe(true);
    const argsDone = evs.find((e) => e.type === "response.function_call_arguments.done");
    expect(JSON.parse(argsDone.arguments)).toEqual({ city: "SF" });
  });

  it("EP-30 non-stream tool call maps to a function_call output item", async () => {
    const { worker } = wired(toolStreamProvider("search", '{"q":"x"}', "fc1"));
    const res = await request(worker).post("/openai/responses").send({ model: "gpt-5.5", input: "search x" });
    const fc = res.body.output.find((o: any) => o.type === "function_call");
    expect(fc).toMatchObject({ call_id: "fc1", name: "search" });
    expect(JSON.parse(fc.arguments)).toEqual({ q: "x" });
  });

  it("EP-31 a prior function_call + function_call_output in input round-trips to the provider", async () => {
    let seen: any;
    const spy: ProviderAdapter = { name: "copilot", async complete(req) { seen = req; return { id: "c1", model: req.model, content: [{ type: "text", text: "done" }], finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 } }; }, async *stream() { yield { kind: "done", done: true, finishReason: "stop" } as const; } };
    const { worker } = wired(spy);
    await request(worker).post("/openai/responses").send({
      model: "gpt-5.5",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] },
        { type: "function_call", call_id: "fc1", name: "now", arguments: '{"tz":"utc"}' },
        { type: "function_call_output", call_id: "fc1", output: "12:00" },
      ],
    });
    expect(seen.messages.find((m: any) => m.content.some((b: any) => b.type === "tool_use" && b.id === "fc1"))).toBeTruthy();
    expect(seen.messages.find((m: any) => m.content.some((b: any) => b.type === "tool_result" && b.toolUseId === "fc1"))).toBeTruthy();
  });

  it("EP-32 an input_image content part round-trips to the provider as an image block", async () => {
    let seen: any;
    const spy: ProviderAdapter = { name: "copilot", async complete(req) { seen = req; return { id: "c1", model: req.model, content: [{ type: "text", text: "a cat" }], finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 } }; }, async *stream() { yield { kind: "done", done: true, finishReason: "stop" } as const; } };
    const { worker } = wired(spy);
    await request(worker).post("/openai/responses").send({
      model: "gpt-5.5",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "what?" }, { type: "input_image", image_url: "data:image/png;base64,XYZ" }] }],
    });
    const img = seen.messages.flatMap((m: any) => m.content).find((b: any) => b.type === "image");
    expect(img).toEqual({ type: "image", dataUrl: "data:image/png;base64,XYZ" });
  });

  it("EP-33 instructions become a system message", async () => {
    let seen: any;
    const spy: ProviderAdapter = { name: "copilot", async complete(req) { seen = req; return { id: "c1", model: req.model, content: [{ type: "text", text: "ok" }], finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 } }; }, async *stream() { yield { kind: "done", done: true, finishReason: "stop" } as const; } };
    const { worker } = wired(spy);
    await request(worker).post("/openai/responses").send({ model: "gpt-5.5", instructions: "be terse", input: "hello" });
    expect(seen.messages[0]).toEqual({ role: "system", content: [{ type: "text", text: "be terse" }] });
  });

  it("EP-34 a hosted web_search tool is passed through to the provider as a hostedTool", async () => {
    let seen: any;
    const spy: ProviderAdapter = { name: "copilot", async complete(req) { seen = req; return { id: "c1", model: req.model, content: [{ type: "text", text: "ok" }], finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 } }; }, async *stream() { yield { kind: "done", done: true, finishReason: "stop" } as const; } };
    const { worker } = wired(spy);
    await request(worker).post("/openai/responses").send({ model: "gpt-5.5", input: "news?", tools: [{ type: "web_search" }, { type: "function", name: "f", parameters: {} }] });
    expect(seen.hostedTools).toEqual(["web_search"]);
    expect(seen.tools?.some((t: any) => t.name === "f")).toBe(true); // function tool still present
  });

  it("EP-35 an expired token surfaces a 401 error object on /responses", async () => {
    const { worker } = wired(authFailProvider());
    const res = await request(worker).post("/openai/responses").send({ model: "gpt-5.5", input: "hi" });
    expect(res.status).toBe(401);
    expect(res.body.error.type).toBe("error");
    expect(res.body.error.message).toMatch(/login|expired/i);
  });

  it("EP-36 a mid-stream failure emits a data error frame, not a silent close", async () => {
    const { worker } = wired(authFailProvider(true)); // throws after a text yield (stream already open)
    const res = await request(worker).post("/openai/responses").send({ model: "gpt-5.5", input: "hi", stream: true });
    expect(res.text).toMatch(/"type":"error"/);
  });

  it("EP-37 a /responses request is recorded in the supervisor request_log", async () => {
    const { worker, db } = wired(ok);
    await request(worker).post("/openai/responses").send({ model: "gpt-5.5", input: "hi" });
    const logged = recentRequests(db, 10);
    expect(logged.some((r) => r.endpoint === "/openai/responses" && r.status === 200)).toBe(true);
  });

  it("EP-38 resolveModel applies to /responses too (strips the [1m] suffix)", async () => {
    let seen: any;
    const spy: ProviderAdapter = { name: "copilot", async complete(req) { seen = req; return { id: "c1", model: req.model, content: [{ type: "text", text: "ok" }], finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 } }; }, async *stream() { yield { kind: "done", done: true, finishReason: "stop" } as const; } };
    const { worker } = wired(spy);
    await request(worker).post("/openai/responses").send({ model: "gpt-4o[1m]", input: "hi" });
    expect(seen.model).not.toContain("[1m]");
  });

  it("EP-42 tools carried in an `additional_tools` input item reach the provider (Codex 0.145 / gpt-5.6, #4231)", async () => {
    // Newer Codex sends NO top-level tools — they ride inside an `additional_tools` item in `input`.
    // If the worker drops that item the model reaches the provider tool-less and can only narrate its
    // tool calls as text. Assert the tools survive to the provider AND the item never leaks as a message.
    let seen: any;
    const spy: ProviderAdapter = { name: "copilot", async complete(req) { seen = req; return { id: "c1", model: req.model, content: [{ type: "text", text: "ok" }], finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 } }; }, async *stream() { yield { kind: "done", done: true, finishReason: "stop" } as const; } };
    const { worker } = wired(spy);
    await request(worker).post("/openai/responses").send({
      model: "gpt-5.6", input: [
        { type: "additional_tools", role: "developer", tools: [
          { type: "custom", name: "exec", description: "run JS" },
          { type: "function", name: "wait", parameters: { type: "object", properties: {} } },
        ] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "list files" }] },
      ],
    });
    expect(seen.tools?.map((t: any) => t.name).sort()).toEqual(["exec", "wait"]);
    // the additional_tools item is tools, not a message — only the real user turn becomes a message
    expect(seen.messages).toEqual([{ role: "user", content: [{ type: "text", text: "list files" }] }]);
  });

  it("EP-43 custom_tool_call / custom_tool_call_output history round-trips to the provider (#4231)", async () => {
    let seen: any;
    const spy: ProviderAdapter = { name: "copilot", async complete(req) { seen = req; return { id: "c1", model: req.model, content: [{ type: "text", text: "ok" }], finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 } }; }, async *stream() { yield { kind: "done", done: true, finishReason: "stop" } as const; } };
    const { worker } = wired(spy);
    await request(worker).post("/openai/responses").send({
      model: "gpt-5.6", input: [
        { type: "custom_tool_call", call_id: "ctc1", name: "exec", input: "text('hi')" },
        { type: "custom_tool_call_output", call_id: "ctc1", output: "hi" },
      ],
    });
    // custom tool's raw-string input is wrapped as {input:<string>} (not JSON.parse'd)
    expect(seen.messages.find((m: any) => m.content.some((b: any) => b.type === "tool_use" && b.id === "ctc1" && b.input?.input === "text('hi')"))).toBeTruthy();
    expect(seen.messages.find((m: any) => m.content.some((b: any) => b.type === "tool_result" && b.toolUseId === "ctc1"))).toBeTruthy();
  });
});

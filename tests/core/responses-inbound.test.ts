import { describe, it, expect } from "vitest";
import { responsesRequestToCanonical, canonicalToResponsesResponse, ResponsesSSE } from "../../src/core/responses-inbound.js";
import type { CanonicalResponse } from "../../src/core/canonical.js";

describe("responsesRequestToCanonical", () => {
  it("flattens instructions to a system message and a string input to a user message", () => {
    const c = responsesRequestToCanonical({ model: "gpt-5-mini", instructions: "be terse", input: "hello", stream: false });
    expect(c.model).toBe("gpt-5-mini");
    expect(c.messages[0]).toEqual({ role: "system", content: [{ type: "text", text: "be terse" }] });
    expect(c.messages[1]).toEqual({ role: "user", content: [{ type: "text", text: "hello" }] });
  });

  it("maps input items: message / function_call / function_call_output", () => {
    const c = responsesRequestToCanonical({
      model: "gpt-5", stream: false,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "what time" }] },
        { type: "function_call", call_id: "fc1", name: "now", arguments: '{"tz":"utc"}' },
        { type: "function_call_output", call_id: "fc1", output: "12:00" },
      ],
    });
    expect(c.messages[0]).toEqual({ role: "user", content: [{ type: "text", text: "what time" }] });
    expect(c.messages[1].content[0]).toEqual({ type: "tool_use", id: "fc1", name: "now", input: { tz: "utc" } });
    expect(c.messages[2]).toEqual({ role: "tool", content: [{ type: "tool_result", toolUseId: "fc1", content: "12:00" }] });
  });

  it("maps function tools to canonical tools and passes hosted web_search through as a hostedTool", () => {
    const c = responsesRequestToCanonical({
      model: "gpt-5", stream: false, input: "hi",
      tools: [
        { type: "function", name: "search", description: "d", parameters: { type: "object", properties: {} } },
        { type: "web_search" },
      ] as any,
    });
    expect(c.tools).toHaveLength(1);
    expect(c.tools![0]).toMatchObject({ name: "search" });
    // Codex asks for Copilot's native web_search — keep it as a hosted tool so the outbound /responses
    // translator can forward it to Copilot (which runs it server-side), instead of dropping it.
    expect(c.hostedTools).toEqual(["web_search"]);
  });

  it("handles Codex's real tool mix without producing a nameless hosted tool (regression)", () => {
    // Codex sends function tools, a `custom` tool (apply_patch — HAS a name), and nameless hosted
    // tools (tool_search, web_search). Forwarding `custom` as a bare {type:"custom"} made Copilot
    // reject the whole request with 400 "Missing required parameter: tools[N].name", which surfaced
    // to the codex CLI as "stream closed before response.completed".
    const c = responsesRequestToCanonical({
      model: "gpt-5.5", stream: true, input: "hi",
      tools: [
        { type: "function", name: "exec_command", parameters: { type: "object", properties: {} } },
        { type: "custom", name: "apply_patch", description: "patch" },
        { type: "tool_search" },
        { type: "web_search" },
      ] as any,
    });
    // custom tools carry a name → treated as function tools (kept, with their name)
    expect(c.tools?.map((t) => t.name).sort()).toEqual(["apply_patch", "exec_command"]);
    // only web_search passes through; tool_search is NOT forwarded (Copilot 400s it without a
    // deferred tool), and a nameless `custom` is never forwarded.
    expect(c.hostedTools).toEqual(["web_search"]);
    expect(c.hostedTools).not.toContain("custom");
    expect(c.hostedTools).not.toContain("tool_search");
  });

  it("drops an unrecognized nameless tool rather than forwarding a malformed one", () => {
    const c = responsesRequestToCanonical({
      model: "gpt-5", stream: false, input: "hi",
      tools: [{ type: "some_future_hosted_tool" }] as any, // no name, not on the allowlist
    });
    expect(c.hostedTools ?? []).toEqual([]); // dropped, not forwarded as {type} with no name
  });

  it("extracts tools carried by an `additional_tools` input item (Codex 0.145 / gpt-5.6)", () => {
    // PROVEN against a live `codex exec -m gpt-5.6-luna`: newer Codex sends NO top-level `tools`;
    // instead the tools ride inside an `additional_tools` item in `input`. We must merge those into
    // the canonical tool list, or the model reaches Copilot with zero tools and can only narrate its
    // tool calls as text ("I'm unable to access a shell tool"). This is the crux of the bug.
    const c = responsesRequestToCanonical({
      model: "gpt-5.6", stream: true,
      input: [
        { type: "additional_tools", role: "developer", tools: [
          { type: "custom", name: "exec", description: "run JS to orchestrate tools" },
          { type: "function", name: "wait", parameters: { type: "object", properties: {} } },
          { type: "function", name: "request_user_input", parameters: { type: "object", properties: {} } },
        ] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      ] as any,
    });
    // All three become named canonical tools (custom carries a name → kept as a function tool).
    expect(c.tools?.map((t) => t.name).sort()).toEqual(["exec", "request_user_input", "wait"]);
    // The additional_tools item itself is not a message — it must not leak into the conversation.
    expect(c.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
  });

  it("merges top-level tools with additional_tools and forwards hosted web_search from either", () => {
    const c = responsesRequestToCanonical({
      model: "gpt-5.6", stream: true, input: [
        { type: "additional_tools", tools: [
          { type: "function", name: "exec_command", parameters: { type: "object", properties: {} } },
          { type: "web_search" },
        ] },
      ],
      tools: [{ type: "function", name: "apply_patch", parameters: { type: "object", properties: {} } }],
    } as any);
    expect(c.tools?.map((t) => t.name).sort()).toEqual(["apply_patch", "exec_command"]);
    expect(c.hostedTools).toEqual(["web_search"]); // hosted tool inside additional_tools still forwards
  });

  it("maps custom_tool_call / custom_tool_call_output history so multi-turn custom-tool context survives", () => {
    // Codex's `custom` tool (exec) replays prior calls as custom_tool_call (assistant) +
    // custom_tool_call_output (result). itemToMessage only knew function_call/_output, so it dropped
    // these — the model lost its own tool history mid-session. `input` on a custom_tool_call is a RAW
    // string (not JSON), so we wrap it as tool_use input {input:<string>} rather than JSON.parse it.
    const c = responsesRequestToCanonical({
      model: "gpt-5.6", stream: false, input: [
        { type: "custom_tool_call", call_id: "ctc1", name: "exec", input: "text('hi')" },
        { type: "custom_tool_call_output", call_id: "ctc1", output: "hi" },
      ] as any,
    });
    expect(c.messages[0]).toEqual({ role: "assistant", content: [{ type: "tool_use", id: "ctc1", name: "exec", input: { input: "text('hi')" } }] });
    expect(c.messages[1]).toEqual({ role: "tool", content: [{ type: "tool_result", toolUseId: "ctc1", content: "hi" }] });
  });
});

describe("canonicalToResponsesResponse", () => {
  it("wraps text in an output_text message item with usage", () => {
    const r: CanonicalResponse = { id: "r1", model: "gpt-5", content: [{ type: "text", text: "hi there" }], finishReason: "stop", usage: { promptTokens: 10, completionTokens: 3 } };
    const out = canonicalToResponsesResponse(r);
    expect(out.object).toBe("response");
    expect(out.status).toBe("completed");
    const msg = out.output.find((o: any) => o.type === "message");
    expect(msg.content[0]).toMatchObject({ type: "output_text", text: "hi there" });
    expect(out.usage).toMatchObject({ input_tokens: 10, output_tokens: 3, total_tokens: 13 });
  });

  it("emits function_call items for tool_use blocks", () => {
    const r: CanonicalResponse = { id: "r1", model: "gpt-5", content: [{ type: "tool_use", id: "fc1", name: "search", input: { q: "x" } }], finishReason: "tool_use", usage: { promptTokens: 1, completionTokens: 1 } };
    const out = canonicalToResponsesResponse(r);
    const fc = out.output.find((o: any) => o.type === "function_call");
    expect(fc).toMatchObject({ type: "function_call", call_id: "fc1", name: "search" });
    expect(JSON.parse(fc.arguments)).toEqual({ q: "x" });
  });
});

describe("ResponsesSSE emitter", () => {
  it("emits the ordered text event sequence with monotonic sequence_number", () => {
    const sse = new ResponsesSSE("resp_1", "gpt-5");
    const out: string[] = [];
    out.push(sse.start());
    out.push(...[sse.text("Hel"), sse.text("lo")].flat());
    out.push(...sse.finish({ promptTokens: 1, completionTokens: 1 }, "stop"));
    const events = out.join("").split("\n\n").filter(Boolean).map((b) => JSON.parse(b.replace(/^data: /, "")));
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("response.created");
    expect(types).toContain("response.output_item.added");
    expect(types).toContain("response.content_part.added");
    expect(types.filter((t) => t === "response.output_text.delta")).toHaveLength(2);
    expect(types).toContain("response.output_text.done");
    expect(types.at(-1)).toBe("response.completed");
    // sequence_number is present and strictly increasing
    const seqs = events.map((e) => e.sequence_number);
    expect(seqs.every((n, i) => i === 0 || n > seqs[i - 1])).toBe(true);
  });

  it("carries the accumulated text in the terminal done events (so codex can reconstruct the message)", () => {
    // Regression: the done events used to send empty text, so the codex CLI completed the turn but
    // rendered NO assistant text (it reconstructs the final message from output_text.done /
    // content_part.done / output_item.done, not just the deltas).
    const sse = new ResponsesSSE("resp_x", "gpt-5");
    const out = [sse.start(), ...sse.text("Hel"), ...sse.text("lo"), ...sse.finish({ promptTokens: 1, completionTokens: 1 }, "stop")];
    const events = out.join("").split("\n\n").filter(Boolean).map((b) => JSON.parse(b.replace(/^data: /, "")));
    const byType = (t: string) => events.find((e) => e.type === t);
    expect(byType("response.output_text.done").text).toBe("Hello");
    expect(byType("response.content_part.done").part.text).toBe("Hello");
    expect(byType("response.output_item.done").item.content[0]).toMatchObject({ type: "output_text", text: "Hello" });
  });

  it("emits function_call argument events for a tool call", () => {
    const sse = new ResponsesSSE("resp_2", "gpt-5");
    const out: string[] = [];
    out.push(sse.start());
    out.push(...sse.toolStart(0, "fc1", "search"));
    out.push(...sse.toolArgs(0, '{"q":1}'));
    out.push(...sse.finish({ promptTokens: 1, completionTokens: 1 }, "tool_use"));
    const text = out.join("");
    expect(text).toContain("response.output_item.added");
    expect(text).toContain("response.function_call_arguments.delta");
    expect(text).toContain("response.function_call_arguments.done");
    expect(text).toContain("response.completed");
  });

  // #50 P2: Codex reads the FINAL function_call from the terminal events (arguments.done +
  // output_item.done + response.completed.output) to know what shell command to run. The OpenAI spec
  // (verified against the Responses API reference) requires each of these to carry the COMPLETE call —
  // call_id, name, AND the accumulated arguments. We previously emitted a bare {type,id,status} on
  // output_item.done and omitted `name` from response.completed.output, so Codex saw a nameless/argless
  // call and silently skipped execution — the file never got written. Assert all three are complete.
  it("finalizes a function_call with call_id + name + arguments on every terminal event (Codex tool loop)", () => {
    const sse = new ResponsesSSE("resp_x", "gpt-5.5");
    const args = '{"command":["bash","-c","echo hi"]}';
    // The server accumulates arg deltas into argsByIdx and hands the finished map to finish() (mirrors
    // openai-server.ts). toolArgs only emits the streaming delta frame; the terminal args come from the map.
    const argsByIdx = new Map([[0, args]]);
    const out = [sse.start(), ...sse.toolStart(0, "call_abc", "shell_command"), ...sse.toolArgs(0, args), ...sse.finish({ promptTokens: 1, completionTokens: 1 }, "tool_use", argsByIdx)];
    const events = out.join("").split("\n\n").filter(Boolean).map((b) => JSON.parse(b.replace(/^data: /, "")));
    const byType = (t: string) => events.find((e) => e.type === t);

    const argsDone = byType("response.function_call_arguments.done");
    expect(argsDone).toMatchObject({ call_id: "call_abc", name: "shell_command", arguments: args });

    const itemDone = events.filter((e) => e.type === "response.output_item.done").find((e) => e.item?.type === "function_call");
    expect(itemDone.item).toMatchObject({ type: "function_call", call_id: "call_abc", name: "shell_command", arguments: args, status: "completed" });

    const completed = byType("response.completed");
    const fc = completed.response.output.find((o: any) => o.type === "function_call");
    expect(fc).toMatchObject({ type: "function_call", call_id: "call_abc", name: "shell_command", arguments: args });
  });
});

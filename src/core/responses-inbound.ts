import type { CanonicalRequest, CanonicalResponse, CanonicalMessage, ContentBlock } from "./canonical.js";
import { joinText } from "./canonical.js";

// OpenAI Responses API translation. Codex (post codex#7782) speaks ONLY this API — it POSTs to
// {base_url}/responses. Like agent-maestro's implementation we are STATELESS: previous_response_id /
// conversation / item_reference are unsupported (the client sends full history in `input` each turn),
// and only function tools are honored. Mirrors the chat-completions translator in openai-inbound.ts.

interface ResponsesContentPart { type?: string; text?: string; image_url?: string | { url?: string } }
interface ResponsesInputItem {
  type?: string; role?: string;
  content?: string | ResponsesContentPart[];     // message
  call_id?: string; name?: string; arguments?: string; // function_call
  output?: string;                                // function_call_output / custom_tool_call_output
  input?: string;                                 // custom_tool_call (raw string, not JSON)
  tools?: ResponsesTool[];                        // additional_tools (tools injected mid-conversation)
}
interface ResponsesTool { type: string; name?: string; description?: string; parameters?: Record<string, unknown>; tools?: ResponsesTool[] }
export interface ResponsesRequest {
  model: string; input: string | ResponsesInputItem[]; instructions?: string;
  stream?: boolean; temperature?: number; max_output_tokens?: number; tools?: ResponsesTool[];
}

function partsText(content: string | ResponsesContentPart[] | undefined): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join("");
}
function partsImages(content: string | ResponsesContentPart[] | undefined): ContentBlock[] {
  if (!Array.isArray(content)) return [];
  const urlOf = (p: ResponsesContentPart): string | undefined => typeof p.image_url === "string" ? p.image_url : p.image_url?.url;
  return content.filter((p) => p?.type === "input_image" && urlOf(p)).map((p) => ({ type: "image", dataUrl: urlOf(p)! }));
}
function safeJson(s: string | undefined): unknown { try { return s ? JSON.parse(s) : {}; } catch { return {}; } }

function itemToMessage(it: ResponsesInputItem): CanonicalMessage | null {
  if (it.type === "function_call" && it.call_id) {
    return { role: "assistant", content: [{ type: "tool_use", id: it.call_id, name: it.name ?? "", input: safeJson(it.arguments) }] };
  }
  if (it.type === "function_call_output" && it.call_id) {
    return { role: "tool", content: [{ type: "tool_result", toolUseId: it.call_id, content: it.output ?? "" }] };
  }
  // Codex's `custom` tool (e.g. `exec`) replays its history as custom_tool_call / custom_tool_call_output.
  // Unlike function_call, a custom tool's `input` is a RAW string (the freeform text the model produced),
  // not JSON. Keep it raw on the tool_use block (custom:true) so it never gets JSON.parse'd or re-encoded.
  // Dropping these (the old behavior) lost the model's own tool history mid-session.
  if (it.type === "custom_tool_call" && it.call_id) {
    return { role: "assistant", content: [{ type: "tool_use", id: it.call_id, name: it.name ?? "", input: it.input ?? "", custom: true }] };
  }
  if (it.type === "custom_tool_call_output" && it.call_id) {
    return { role: "tool", content: [{ type: "tool_result", toolUseId: it.call_id, content: it.output ?? "" }] };
  }
  // additional_tools carries tools, not a message — its tools are merged separately (see collectTools).
  if (it.type === "additional_tools") return null;
  // default: a message item
  const role = (["system", "user", "assistant"].includes(it.role ?? "") ? it.role : "user") as CanonicalMessage["role"];
  const content: ContentBlock[] = [];
  const text = partsText(it.content);
  if (text) content.push({ type: "text", text });
  content.push(...partsImages(it.content));
  return content.length ? { role, content } : null;
}

// Gather every tool the request offers, from BOTH the top-level `tools` and any `additional_tools`
// input items. Codex 0.145+ (gpt-5.6 family) sends NO top-level tools — it rides them inside an
// `additional_tools` item in `input` (proven against a live `codex exec`). Missing this merge left the
// model tool-less: it reached Copilot with zero tools and could only narrate its calls as text
// ("I'm unable to access a shell tool"). Mirrors agent-maestro's extractAdditionalTools (#208).
function collectTools(req: ResponsesRequest): ResponsesTool[] {
  const fromInput = Array.isArray(req.input)
    ? req.input.filter((it) => it.type === "additional_tools").flatMap((it) => it.tools ?? [])
    : [];
  return [...(req.tools ?? []), ...fromInput];
}

export function responsesRequestToCanonical(req: ResponsesRequest): CanonicalRequest {
  const messages: CanonicalMessage[] = [];
  if (req.instructions) messages.push({ role: "system", content: [{ type: "text", text: req.instructions }] });
  if (typeof req.input === "string") {
    messages.push({ role: "user", content: [{ type: "text", text: req.input }] });
  } else {
    for (const it of req.input) { const m = itemToMessage(it); if (m) messages.push(m); }
  }
  const tools = collectTools(req);
  return {
    model: req.model, stream: Boolean(req.stream), temperature: req.temperature, maxTokens: req.max_output_tokens,
    // Function tools and `custom` tools (e.g. Codex's apply_patch/exec) both carry a name — keep them as
    // named tools so Copilot doesn't reject a nameless tool. A `custom` tool takes FREEFORM string input
    // (not JSON), so flag it (custom:true) — Copilot's /responses accepts {type:"custom"} natively and
    // returns a custom_tool_call (probed); flattening it to a JSON-schema function made the model emit
    // empty {} and Codex reject the reply ("tool exec invoked with incompatible payload"). Only the KNOWN
    // nameless server-side tools pass through as hostedTools; an unrecognized nameless tool is dropped
    // rather than forwarded as a bare {type} (which 400s "Missing required parameter: tools[N].name").
    tools: tools.filter((t) => (t.type === "function" || t.type === "custom") && t.name).map((t) => ({ name: t.name!, description: t.description, parameters: t.parameters ?? {}, ...(t.type === "custom" ? { custom: true } : {}) })),
    hostedTools: tools.filter((t) => HOSTED_TOOL_TYPES.has(t.type ?? "")).map((t) => t.type!),
    messages,
  };
}

// Copilot's /responses accepts these as standalone nameless hosted tools. NOTE: `tool_search` is
// deliberately excluded — Copilot rejects it unless the request also defines "deferred" tools
// ("tools.tool_search requires at least one deferred tool"), which we can't satisfy, so forwarding it
// 400s the whole request. web_search is the one Codex hosted tool we can pass straight through.
const HOSTED_TOOL_TYPES = new Set(["web_search", "web_search_preview"]);

// Build the non-stream Responses object: text -> an output_text message item, tool_use -> function_call
// (JSON args) or custom_tool_call (raw-string input) items.
export function canonicalToResponsesResponse(r: CanonicalResponse) {
  const output: unknown[] = [];
  const text = joinText(r.content);
  if (text) output.push({ type: "message", id: `msg_${r.id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });
  for (const b of r.content) {
    if (b.type !== "tool_use") continue;
    output.push(b.custom
      ? { type: "custom_tool_call", id: `ctc_${b.id}`, call_id: b.id, name: b.name, input: typeof b.input === "string" ? b.input : JSON.stringify(b.input ?? ""), status: "completed" }
      : { type: "function_call", id: `fc_${b.id}`, call_id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}), status: "completed" });
  }
  return {
    id: r.id, object: "response" as const, status: "completed" as const, model: r.model,
    output, output_text: text,
    usage: { input_tokens: r.usage.promptTokens, output_tokens: r.usage.completionTokens, total_tokens: r.usage.promptTokens + r.usage.completionTokens },
  };
}

// Stateful SSE emitter for the Responses stream. Each event carries a monotonically increasing
// sequence_number (Codex/agent-maestro require it). Text streams as one output_text message item;
// each tool call is its own function_call output item. Indices are allocated sequentially.
const frame = (event: unknown): string => `data: ${JSON.stringify(event)}\n\n`;
export class ResponsesSSE {
  private seq = 0;
  private nextIndex = 0;
  private textIndex?: number;
  private textItemId?: string;
  private accumulatedText = ""; // the full assistant text, replayed in the terminal done events
  private toolIndex = new Map<number, { outputIndex: number; itemId: string; callId: string; name: string; custom: boolean }>();
  constructor(private responseId: string, private model: string) {}

  private ev(type: string, extra: Record<string, unknown>): string {
    return frame({ type, sequence_number: this.seq++, ...extra });
  }
  private envelope(status: string) {
    return { id: this.responseId, object: "response", status, model: this.model };
  }

  start(): string {
    return this.ev("response.created", { response: { ...this.envelope("in_progress"), output: [] } });
  }

  text(delta: string): string[] {
    const out: string[] = [];
    if (this.textIndex === undefined) {
      this.textIndex = this.nextIndex++;
      this.textItemId = `msg_${this.responseId}`;
      out.push(this.ev("response.output_item.added", { output_index: this.textIndex, item: { type: "message", id: this.textItemId, role: "assistant", status: "in_progress", content: [] } }));
      out.push(this.ev("response.content_part.added", { item_id: this.textItemId, output_index: this.textIndex, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }));
    }
    out.push(this.ev("response.output_text.delta", { item_id: this.textItemId, output_index: this.textIndex, content_index: 0, delta }));
    this.accumulatedText += delta;
    return out;
  }

  // A custom tool (Codex's exec) streams its freeform input as custom_tool_call_input.* events and its
  // item is a custom_tool_call (input string), not a function_call (JSON arguments). Codex validates the
  // reply against how it registered the tool, so a custom tool MUST come back as custom_tool_call — a
  // function_call reply is rejected ("tool exec invoked with incompatible payload").
  toolStart(copilotIdx: number, callId: string, name: string, custom = false): string[] {
    if (this.toolIndex.has(copilotIdx)) return [];
    const outputIndex = this.nextIndex++;
    const itemId = `${custom ? "ctc" : "fc"}_${callId}`;
    this.toolIndex.set(copilotIdx, { outputIndex, itemId, callId, name, custom });
    const item = custom
      ? { type: "custom_tool_call", id: itemId, call_id: callId, name, input: "", status: "in_progress" }
      : { type: "function_call", id: itemId, call_id: callId, name, arguments: "", status: "in_progress" };
    return [this.ev("response.output_item.added", { output_index: outputIndex, item })];
  }

  toolArgs(copilotIdx: number, deltaArgs: string): string[] {
    const t = this.toolIndex.get(copilotIdx);
    if (!t) return [];
    return t.custom
      ? [this.ev("response.custom_tool_call_input.delta", { item_id: t.itemId, output_index: t.outputIndex, delta: deltaArgs })]
      : [this.ev("response.function_call_arguments.delta", { item_id: t.itemId, output_index: t.outputIndex, delta: deltaArgs })];
  }

  // Close all open items and complete the response. `argsByIdx` supplies each tool's final accumulated
  // input (JSON args for a function call, raw string for a custom call).
  finish(usage: { promptTokens: number; completionTokens: number } | undefined, _finishReason: string, argsByIdx?: Map<number, string>): string[] {
    const out: string[] = [];
    if (this.textIndex !== undefined) {
      const text = this.accumulatedText;
      out.push(this.ev("response.output_text.done", { item_id: this.textItemId, output_index: this.textIndex, content_index: 0, text }));
      out.push(this.ev("response.content_part.done", { item_id: this.textItemId, output_index: this.textIndex, content_index: 0, part: { type: "output_text", text, annotations: [] } }));
      out.push(this.ev("response.output_item.done", { output_index: this.textIndex, item: { type: "message", id: this.textItemId, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] } }));
    }
    for (const [copilotIdx, t] of this.toolIndex) {
      const args = argsByIdx?.get(copilotIdx) ?? "";
      // Spec (Responses API): the terminal input/args-done + output_item.done carry the COMPLETE finalized
      // item. Codex reads these to know what to run — a bare {type,id,status} left it nameless/argless, so
      // Codex skipped execution (#50 P2). A custom tool uses custom_tool_call_input.done + a custom_tool_call
      // item with a raw-string `input`; a function tool uses function_call_arguments.done + JSON arguments.
      if (t.custom) {
        out.push(this.ev("response.custom_tool_call_input.done", { item_id: t.itemId, output_index: t.outputIndex, call_id: t.callId, name: t.name, input: args }));
        out.push(this.ev("response.output_item.done", { output_index: t.outputIndex, item: { type: "custom_tool_call", id: t.itemId, call_id: t.callId, name: t.name, input: args, status: "completed" } }));
      } else {
        out.push(this.ev("response.function_call_arguments.done", { item_id: t.itemId, output_index: t.outputIndex, call_id: t.callId, name: t.name, arguments: args }));
        out.push(this.ev("response.output_item.done", { output_index: t.outputIndex, item: { type: "function_call", id: t.itemId, call_id: t.callId, name: t.name, arguments: args, status: "completed" } }));
      }
    }
    const u = usage ? { input_tokens: usage.promptTokens, output_tokens: usage.completionTokens, total_tokens: usage.promptTokens + usage.completionTokens } : undefined;
    // Spec-correct clients reconstruct the final response from response.completed.response.output, so
    // include the finished items (the text message + any tool calls), not just an empty envelope.
    const output: unknown[] = [];
    if (this.textIndex !== undefined) output.push({ type: "message", id: this.textItemId, role: "assistant", status: "completed", content: [{ type: "output_text", text: this.accumulatedText, annotations: [] }] });
    for (const [copilotIdx, t] of this.toolIndex) {
      const args = argsByIdx?.get(copilotIdx) ?? "";
      output.push(t.custom
        ? { type: "custom_tool_call", id: t.itemId, call_id: t.callId, name: t.name, input: args, status: "completed" }
        : { type: "function_call", id: t.itemId, call_id: t.callId, name: t.name, arguments: args, status: "completed" });
    }
    out.push(this.ev("response.completed", { response: { ...this.envelope("completed"), output, ...(u ? { usage: u } : {}) } }));
    return out;
  }
}

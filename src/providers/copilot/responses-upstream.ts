import { randomUUID } from "node:crypto";
import type { CanonicalRequest, CanonicalResponse, CanonicalChunk, CanonicalMessage, ContentBlock } from "../../core/canonical.js";
import { ToolCallExtractor, type ExtractEvent } from "../../core/tool-xml.js";
import { clampEffort } from "../../core/reasoning.js";

// Outbound translation to GitHub Copilot's OpenAI Responses API. Newer Copilot models (e.g. gpt-5.5)
// are served ONLY on /responses — their `supported_endpoints` omits /chat/completions — so the adapter
// routes them here instead of the chat path. This is the mirror image of core/responses-inbound.ts
// (which translates Codex's INBOUND /responses calls); here we SEND /responses to Copilot.

export const RESPONSES_URL = "https://api.githubcopilot.com/responses";

// ---- request: canonical -> Responses body -------------------------------------------------------

interface ResponsesInputItem {
  type: "message" | "function_call" | "function_call_output" | "custom_tool_call" | "custom_tool_call_output";
  role?: string;
  content?: { type: string; text?: string; image_url?: string }[];
  call_id?: string; name?: string; arguments?: string; output?: string;
  input?: string; // custom_tool_call: freeform raw-string input (not JSON args)
}
// A Responses tool is a function tool, a `custom` tool (freeform string input, no JSON schema), or a
// hosted tool (just a {type} marker, e.g. web_search).
type ResponsesToolEntry =
  | { type: "function"; name: string; description?: string; parameters: Record<string, unknown> }
  | { type: "custom"; name: string; description?: string }
  | { type: string };
export interface ResponsesBody {
  model: string;
  input: ResponsesInputItem[];
  instructions?: string;
  stream?: boolean;
  temperature?: number;
  max_output_tokens?: number;
  tools?: ResponsesToolEntry[];
  // Reasoning models on /responses take a nested reasoning config (vs /chat's flat reasoning_effort).
  reasoning?: { effort: string };
}

function textOf(content: ContentBlock[]): string {
  return content.filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text").map((b) => b.text).join("");
}

// One canonical message can expand into several Responses items (parallel tool calls / results).
function messageToItems(m: CanonicalMessage): ResponsesInputItem[] {
  const items: ResponsesInputItem[] = [];
  const toolResults = m.content.filter((b): b is Extract<ContentBlock, { type: "tool_result" }> => b.type === "tool_result");
  // The Responses `function_call_output.output` is a plain string — it has no place for an image part.
  // A tool that returned image(s) (Bash screenshot / MCP image) would otherwise force the base64 into
  // that string and blow the token budget on this path. Since the image can't be delivered here, note
  // its omission in the output text instead of shipping raw base64. (This path is gpt-5/Codex; the
  // image round-trip lives on /chat, which Claude uses.)
  for (const tr of toolResults) {
    const note = tr.images?.length ? `${tr.content ? "\n" : ""}[${tr.images.length} image(s) omitted — not supported on this endpoint]` : "";
    items.push({ type: "function_call_output", call_id: tr.toolUseId, output: tr.content + note });
  }
  if (toolResults.length) return items; // a tool message carries only results

  const toolUses = m.content.filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use");
  for (const tu of toolUses) {
    // A `custom` tool call carries a RAW string input (Codex's exec) — serialize it as a custom_tool_call
    // with a plain `input` string, NOT a function_call with JSON arguments. Copilot accepts this shape
    // (probed) and it's what Codex replays/expects. A normal function call keeps JSON arguments.
    if (tu.custom) {
      items.push({ type: "custom_tool_call", call_id: tu.id, name: tu.name, input: typeof tu.input === "string" ? tu.input : JSON.stringify(tu.input ?? "") });
    } else {
      items.push({ type: "function_call", call_id: tu.id, name: tu.name, arguments: JSON.stringify(tu.input ?? {}) });
    }
  }

  // Assistant text becomes an output_text part; user/system text an input_text part. Images are input_image.
  const text = textOf(m.content);
  const images = m.content.filter((b): b is Extract<ContentBlock, { type: "image" }> => b.type === "image");
  const parts: { type: string; text?: string; image_url?: string }[] = [];
  const textType = m.role === "assistant" ? "output_text" : "input_text";
  if (text) parts.push({ type: textType, text });
  for (const img of images) parts.push({ type: "input_image", image_url: img.dataUrl });
  if (parts.length) items.push({ type: "message", role: m.role, content: parts });
  return items;
}

// The Responses API rejects max_output_tokens below 16 with a 400 ("Invalid 'max_output_tokens':
// integer below minimum value"). Tiny caps reach us legitimately — Claude Code's connection probe
// and /doctor's ping send max_tokens:1 — so clamp UP to the API floor rather than forwarding a value
// the upstream will reject. A 1-token answer is meaningless anyway; this just keeps the request valid.
const MIN_OUTPUT_TOKENS = 16;

export function canonicalToResponsesBody(req: CanonicalRequest, supportedEfforts: string[] = []): ResponsesBody {
  const system = req.messages.filter((m) => m.role === "system").map((m) => textOf(m.content)).filter(Boolean).join("\n");
  const input: ResponsesInputItem[] = [];
  for (const m of req.messages) { if (m.role === "system") continue; input.push(...messageToItems(m)); }
  // Function tools -> {type:"function",…}; `custom` tools -> {type:"custom", name, description} (freeform
  // string input, no JSON schema — Copilot accepts these and returns a custom_tool_call); hosted tools
  // (web_search) pass through as {type}.
  const tools: ResponsesToolEntry[] = [
    ...(req.tools ?? []).map((t) => t.custom
      ? { type: "custom" as const, name: t.name, description: t.description }
      : { type: "function" as const, name: t.name, description: t.description, parameters: t.parameters }),
    ...(req.hostedTools ?? []).map((type) => ({ type })),
  ];
  return {
    model: req.model, input, stream: req.stream,
    ...(system ? { instructions: system } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.maxTokens !== undefined ? { max_output_tokens: Math.max(req.maxTokens, MIN_OUTPUT_TOKENS) } : {}),
    ...(tools.length ? { tools } : {}),
    ...(req.reasoning?.effort ? { reasoning: { effort: clampEffort(req.reasoning.effort, supportedEfforts) } } : {}),
  };
}

// ---- non-stream response: Responses object -> canonical -----------------------------------------

function safeJson(s: string | undefined): Record<string, unknown> { try { return s ? JSON.parse(s) : {}; } catch { return {}; } }

// A `custom` tool's input is a freeform string. Copilot may return it as a raw string, or wrapped as
// {source} (generated free-form) / {input}. Unwrap either to the raw string; fall back to JSON.
function customInput(input: unknown): string {
  if (typeof input === "string") return input;
  if (input && typeof input === "object") {
    const w = input as { input?: unknown; source?: unknown };
    if (typeof w.input === "string") return w.input;
    if (typeof w.source === "string") return w.source;
  }
  return input == null ? "" : JSON.stringify(input);
}

function mapIncomplete(reason: string | undefined): CanonicalResponse["finishReason"] {
  return reason === "max_output_tokens" ? "length" : "stop";
}

export function parseResponsesResult(data: any): CanonicalResponse {
  const content: ContentBlock[] = [];
  let sawTool = false;
  for (const item of data.output ?? []) {
    if (item.type === "message") {
      const text = (item.content ?? []).filter((p: any) => p.type === "output_text").map((p: any) => p.text ?? "").join("");
      if (text) {
        // Recover inline-XML tool calls here too (some models emit them as output_text).
        const ex = new ToolCallExtractor();
        for (const ev of [...ex.feed(text), ...ex.flush()]) {
          if (ev.kind === "text") { if (ev.text) content.push({ type: "text", text: ev.text }); }
          else { sawTool = true; content.push({ type: "tool_use", id: ev.tool.id, name: ev.tool.name, input: ev.tool.input }); }
        }
      }
    } else if (item.type === "function_call" && item.name) {
      sawTool = true;
      content.push({ type: "tool_use", id: item.call_id ?? item.id, name: item.name, input: safeJson(item.arguments) });
    } else if (item.type === "custom_tool_call" && item.name) {
      // A custom tool returns a freeform string `input` (not JSON args). Preserve it raw with custom:true
      // so the Responses translator re-emits it as a custom_tool_call the client (Codex) can execute.
      sawTool = true;
      content.push({ type: "tool_use", id: item.call_id ?? item.id, name: item.name, input: customInput(item.input), custom: true });
    }
  }
  const finishReason: CanonicalResponse["finishReason"] =
    data.status === "incomplete" ? mapIncomplete(data.incomplete_details?.reason) : sawTool ? "tool_use" : "stop";
  return {
    id: data.id ?? `resp-${randomUUID().replace(/-/g, "")}`, model: data.model, content, finishReason,
    usage: { promptTokens: data.usage?.input_tokens ?? 0, completionTokens: data.usage?.output_tokens ?? 0 },
  };
}

// ---- streaming: Responses SSE -> canonical chunks ------------------------------------------------

// Copilot's Responses stream is item-centric: each output item is announced by response.output_item.added
// (carrying the item's type + identity), then text streams via response.output_text.delta and tool args
// via response.function_call_arguments.delta. We map item output_index -> a canonical tool index so deltas
// attach to the right call. The terminal event is response.completed (or response.incomplete on a cap).
export async function* streamResponses(res: Response): AsyncIterable<CanonicalChunk> {
  if (!res.body) { yield { kind: "done", done: true, finishReason: "stop" }; return; }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finishReason: CanonicalResponse["finishReason"] = "stop";
  let usage: { promptTokens: number; completionTokens: number; cachedTokens?: number } | undefined;
  const toolByOutputIndex = new Map<number, number>(); // responses output_index -> canonical tool index
  let nextToolIndex = 0;
  // Some models stream a tool call as inline XML text instead of a function_call item; recover it.
  // Extracted tools use a high index space so they never collide with native function_call indices.
  const extractor = new ToolCallExtractor();
  let extIdx = 100, extractedTool = false;
  const toChunks = (events: ExtractEvent[]): CanonicalChunk[] => {
    const out: CanonicalChunk[] = [];
    for (const ev of events) {
      if (ev.kind === "text") { if (ev.text) out.push({ kind: "text", delta: ev.text, done: false }); continue; }
      const index = extIdx++; extractedTool = true;
      out.push({ kind: "tool_use_start", index, id: ev.tool.id, name: ev.tool.name, done: false });
      out.push({ kind: "tool_use_delta", index, argsDelta: JSON.stringify(ev.tool.input), done: false });
    }
    return out;
  };

  const usageOf = (u: any) => u ? { promptTokens: u.input_tokens ?? 0, completionTokens: u.output_tokens ?? 0, cachedTokens: u.input_tokens_details?.cached_tokens ?? 0 } : undefined;

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const line = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      const payload = line.slice(6).trim();
      if (!payload || payload === "[DONE]") continue;
      let ev: any;
      try { ev = JSON.parse(payload); } catch { continue; }
      switch (ev.type) {
        case "response.output_item.added": {
          const item = ev.item ?? {};
          // Gate on a present name, mirroring the chat adapter's `tc.function?.name` guard: a
          // nameless function_call would surface as a bare "call:" the client can't run. No name,
          // no start — its later arg deltas find no mapping and are dropped, not rendered.
          if (item.type === "function_call" && item.name) {
            const idx = nextToolIndex++;
            toolByOutputIndex.set(ev.output_index, idx);
            yield { kind: "tool_use_start", index: idx, id: item.call_id ?? item.id ?? `call_${idx}`, name: item.name, done: false };
          } else if (item.type === "custom_tool_call" && item.name) {
            // A custom tool streams its freeform input via custom_tool_call_input.delta (not JSON args).
            // Mark the start custom so the inbound SSE re-emits it as a custom_tool_call for the client.
            const idx = nextToolIndex++;
            toolByOutputIndex.set(ev.output_index, idx);
            yield { kind: "tool_use_start", index: idx, id: item.call_id ?? item.id ?? `call_${idx}`, name: item.name, custom: true, done: false };
          }
          break;
        }
        case "response.output_text.delta":
          if (ev.delta) for (const ch of toChunks(extractor.feed(ev.delta))) yield ch;
          break;
        case "response.function_call_arguments.delta":
        case "response.custom_tool_call_input.delta": {
          // Both carry the tool's incremental input for the mapped output item — function calls send
          // JSON arg fragments, custom calls send raw-string fragments. Accumulated the same way.
          const idx = toolByOutputIndex.get(ev.output_index);
          if (idx !== undefined && ev.delta) yield { kind: "tool_use_delta", index: idx, argsDelta: ev.delta, done: false };
          break;
        }
        case "response.completed":
          if (toolByOutputIndex.size || extractedTool) finishReason = "tool_use";
          usage = usageOf(ev.response?.usage) ?? usage;
          break;
        case "response.incomplete":
          finishReason = mapIncomplete(ev.response?.incomplete_details?.reason);
          usage = usageOf(ev.response?.usage) ?? usage;
          break;
        case "response.failed":
        case "error":
          finishReason = "error";
          break;
      }
    }
  }
  for (const ch of toChunks(extractor.flush())) yield ch;
  if (extractedTool && finishReason === "stop") finishReason = "tool_use";
  yield { kind: "done", done: true, finishReason, usage };
}

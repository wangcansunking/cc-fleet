import { randomUUID } from "node:crypto";
import type { ProviderAdapter } from "../types.js";
import type { CanonicalRequest, CanonicalResponse, CanonicalChunk, CanonicalMessage, ContentBlock } from "../../core/canonical.js";
import { ToolCallExtractor, type ExtractEvent } from "../../core/tool-xml.js";
import { canonicalToResponsesBody, parseResponsesResult, streamResponses, RESPONSES_URL } from "./responses-upstream.js";
import { oneLine } from "../../shared/format.js";
import { clampEffort } from "../../core/reasoning.js";

const CHAT_URL = "https://api.githubcopilot.com/chat/completions";
interface TokenSource { get(): Promise<string> }

// A non-ok HTTP response from Copilot, carrying the upstream status so the request handlers can
// classify it: a permanent 4xx (bad model, malformed request) must surface as a TERMINAL client
// error so the caller fails fast — mapping it to a retriable 502 makes clients (Claude Code, the
// Anthropic SDK) retry with backoff until their turn timeout, freezing the session (issue #50 P1).
// 429/408 stay retriable (see isTerminalUpstream). Network/parse failures are plain Errors → 502.
export class UpstreamError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "UpstreamError";
  }
}
// A permanent client-side upstream failure: a 4xx that won't succeed on retry. 429 (rate limit) and
// 408 (request timeout) are transient, so they DON'T count — those should keep retrying. Everything
// else 400–499 is terminal (bad model, invalid body, unsupported feature).
export function isTerminalUpstream(err: unknown): err is UpstreamError {
  return err instanceof UpstreamError && err.status >= 400 && err.status < 500 && err.status !== 429 && err.status !== 408;
}
type EndpointsFor = (model: string) => string[];
// Whether a model advertises reasoning_effort support (from /models capabilities). Sending
// reasoning_effort to a model without it (e.g. gpt-4o) is a hard 400 — gate on this.
type SupportsReasoning = (model: string) => boolean;
type ReasoningEffortsFor = (model: string) => string[];

// A /chat 400 whose body names one of these means "this model is responses-only" — retry on /responses
// once. Matches agent-maestro's safety net for models that drop /chat/completions from their endpoints.
const RESPONSES_HINT_RE = /unsupported_api_for_model|invalid_request_body|does not support|use the responses|model_not_supported/i;

// Copilot's Responses API is gpt-5-class only: probing /models shows ONLY gpt-5.x / mai-code ids carry
// /responses in supported_endpoints — every claude, gpt-4o, gemini id is /chat-only (gpt-4o isn't even
// in the endpoint map). So a request must reach /responses ONLY when we can positively confirm the model
// advertises it. Guarding on this (instead of "is it Claude?") also fixes the gpt-4o case: a gpt-4o /chat
// 400 (e.g. a rate-limit body containing "unsupported_api_for_model") used to trip the broad hint regex
// into a /responses retry, which then 400'd "gpt-4o is not supported via Responses API" — masking the
// real error. A model that can't speak /responses now surfaces its true /chat failure instead.

// Canonical messages -> OpenAI wire messages (Copilot is OpenAI-shaped).
function toWireMessages(messages: CanonicalMessage[]) {
  const out: any[] = [];
  for (const m of messages) {
    const toolResults = m.content.filter((b): b is Extract<ContentBlock, { type: "tool_result" }> => b.type === "tool_result");
    // EACH tool_result becomes its own OpenAI `tool` message. Anthropic packs parallel results
    // into one user message; emitting only the first (the old bug) left later tool_use ids without
    // a matching tool_result -> Claude/Copilot 400 "tool_use ids ... without tool_result blocks".
    if (toolResults.length) {
      for (const tr of toolResults) {
        // A tool that returned image(s) (a Bash screenshot, an MCP image tool) sends them inline on the
        // tool message as an OpenAI multipart array — Copilot accepts images on a `tool` role message
        // (probed). Text-only results stay a plain string, exactly as before.
        const content = tr.images?.length
          ? [...(tr.content ? [{ type: "text", text: tr.content }] : []), ...tr.images.map((url) => ({ type: "image_url", image_url: { url } }))]
          : tr.content;
        out.push({ role: "tool", tool_call_id: tr.toolUseId, content });
      }
      continue;
    }
    const text = m.content.filter((b) => b.type === "text").map((b) => (b as any).text).join("");
    const images = m.content.filter((b): b is Extract<ContentBlock, { type: "image" }> => b.type === "image");
    const toolUses = m.content.filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use");
    // With images, content becomes an OpenAI multipart array (text part + image_url parts); otherwise a string.
    let msgContent: any = text || null;
    if (images.length) {
      msgContent = [...(text ? [{ type: "text", text }] : []), ...images.map((img) => ({ type: "image_url", image_url: { url: img.dataUrl } }))];
    }
    const msg: any = { role: m.role, content: msgContent };
    if (toolUses.length) msg.tool_calls = toolUses.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: JSON.stringify(t.input) } }));
    // Echo a prior assistant turn's reasoning back upstream so the model keeps its chain-of-thought
    // context across tool calls — Copilot reads back reasoning_text + the signed reasoning_opaque token.
    // Copilot's wire shape is SINGULAR (one reasoning per message), so when a turn carried several
    // thinking blocks we echo the LAST one bearing an opaque token — the reasoning closest to the answer,
    // i.e. the continuation context the model actually wants (and never a redacted block's empty text).
    const thinkingBlocks = m.content.filter((b): b is Extract<ContentBlock, { type: "thinking" }> => b.type === "thinking");
    const thinking = [...thinkingBlocks].reverse().find((t) => t.opaque) ?? thinkingBlocks[0];
    if (thinking) {
      if (thinking.text) msg.reasoning_text = thinking.text;
      if (thinking.opaque) msg.reasoning_opaque = thinking.opaque;
    }
    out.push(msg);
  }
  return out;
}

function buildBody(req: CanonicalRequest, supportsReasoning = true, supportedEfforts: string[] = []) {
  const body: any = { model: req.model, messages: toWireMessages(req.messages), stream: req.stream, temperature: req.temperature, max_tokens: req.maxTokens };
  if (req.stream) body.stream_options = { include_usage: true }; // ask Copilot for usage in the final frame
  if (req.tools?.length) body.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  // Extended thinking: Copilot /chat takes a top-level reasoning_effort enum. Only set it when asked AND
  // the model advertises reasoning_effort — sending it to a model without support (e.g. gpt-4o) is a hard
  // 400 (`invalid_reasoning_effort`). When support is unknown (discovery not yet resolved) we default to
  // true and let a real 400 surface rather than silently dropping a reasoning turn the model does support.
  if (req.reasoning?.effort && supportsReasoning) body.reasoning_effort = clampEffort(req.reasoning.effort, supportedEfforts);
  return body;
}
function headers(token: string) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json", "editor-version": "vscode/1.95.0", "copilot-integration-id": "vscode-chat" };
}

// Copilot puts the real reason (bad model, oversized prompt, unsupported tool, …) in the body —
// surface it instead of a bare status code so failures are diagnosable. Flatten it to one line:
// a 502 returns a whole HTML page, and the raw newlines would later shatter the bordered /logs card.
async function errorDetail(res: Response): Promise<string> {
  try { const t = oneLine(await res.text(), 400); return t ? ` — ${t}` : ""; }
  catch { return ""; }
}

export class CopilotAdapter implements ProviderAdapter {
  readonly name = "copilot";
  // endpointsFor(model) -> the model's supported_endpoints (e.g. ["/responses"]). When known and it
  // omits /chat/completions, route to /responses; unknown ([]) keeps the chat path (with a 400 net).
  // supportsReasoningFn(model) -> whether the model advertises reasoning_effort (gates the /chat field).
  constructor(
    private tokenStore: TokenSource,
    private fetchFn: typeof fetch = fetch,
    private endpointsFor?: EndpointsFor,
    private supportsReasoningFn?: SupportsReasoning,
    private reasoningEffortsFor?: ReasoningEffortsFor,
  ) {}

  // reasoning_effort is safe to send only when the model advertises it. Unknown (no discovery / no fn) →
  // true, so we don't silently drop a reasoning turn before discovery resolves; a real 400 would surface.
  private supportsReasoning(model: string): boolean {
    return this.supportsReasoningFn ? this.supportsReasoningFn(model) : true;
  }

  // True only when the live endpoint map positively lists /responses for this model (gpt-5.x / mai-code).
  // The single gate for EVERY /responses route — the primary path and both /chat 400 safety nets — so a
  // model we can't confirm as responses-capable (claude, gpt-4o, gemini, or anything before discovery
  // resolves) never gets sent there. Unknown model (no entry) → false → stays on /chat.
  private canUseResponses(model: string): boolean {
    return !!this.endpointsFor?.(model)?.includes("/responses");
  }
  private usesResponses(model: string): boolean {
    const eps = this.endpointsFor?.(model);
    // Route to /responses only for a model that advertises it AND has dropped /chat/completions.
    return !!eps && eps.includes("/responses") && !eps.includes("/chat/completions");
  }

  async complete(req: CanonicalRequest): Promise<CanonicalResponse> {
    if (this.usesResponses(req.model)) return this.completeResponses(req);
    const token = await this.tokenStore.get();
    const res = await this.fetchFn(CHAT_URL, { method: "POST", headers: headers(token), body: JSON.stringify(buildBody({ ...req, stream: false }, this.supportsReasoning(req.model), this.reasoningEffortsFor?.(req.model))) });
    if (!res.ok) {
      const detail = await errorDetail(res);
      // Safety net: a responses-capable model rejected on /chat — retry once on /responses. ONLY when
      // the model actually advertises /responses; otherwise a matching 400 is a real /chat error to surface.
      if (res.status === 400 && this.canUseResponses(req.model) && RESPONSES_HINT_RE.test(detail)) return this.completeResponses(req);
      throw new UpstreamError(res.status, `copilot completion failed: ${res.status}${detail}`);
    }
    const data = (await res.json()) as any;
    const content: ContentBlock[] = [];
    // Copilot can answer 200 with an EMPTY choices array (a content-filtered turn, or a 1-token ping
    // that emitted nothing). choices[0] is then undefined — reading .message threw "Cannot read
    // properties of undefined (reading 'message')", which the server turned into a 502. A choice-less
    // 200 is a valid empty completion: report it as such (empty content, stop) instead of crashing.
    const choice = data.choices?.[0];
    const message = choice?.message ?? {};
    // Non-stream reasoning: a reasoning_text (+ reasoning_opaque) on the message becomes a leading
    // thinking block, mirroring Anthropic's ordering where thinking precedes the answer text.
    if (message.reasoning_text || message.reasoning_opaque) {
      content.push({ type: "thinking", text: message.reasoning_text ?? "", opaque: message.reasoning_opaque });
    }
    // Recover inline-XML tool calls in non-stream replies too (same reason as the stream path).
    let xmlTool = false;
    if (message.content) {
      const ex = new ToolCallExtractor();
      for (const ev of [...ex.feed(message.content), ...ex.flush()]) {
        if (ev.kind === "text") { if (ev.text) content.push({ type: "text", text: ev.text }); }
        else { xmlTool = true; content.push({ type: "tool_use", id: ev.tool.id, name: ev.tool.name, input: ev.tool.input }); }
      }
    }
    for (const tc of message.tool_calls ?? []) content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: safeJson(tc.function.arguments) });
    return {
      id: data.id ?? `cmpl-${randomUUID().replace(/-/g, "")}`, model: req.model, content,
      finishReason: choice?.finish_reason === "tool_calls" || xmlTool ? "tool_use" : choice?.finish_reason === "length" ? "length" : "stop",
      usage: { promptTokens: data.usage?.prompt_tokens ?? 0, completionTokens: data.usage?.completion_tokens ?? 0 },
    };
  }

  // /responses variants — used for responses-only models and as the /chat 400 safety-net target.
  private async completeResponses(req: CanonicalRequest): Promise<CanonicalResponse> {
    const token = await this.tokenStore.get();
    const res = await this.fetchFn(RESPONSES_URL, { method: "POST", headers: headers(token), body: JSON.stringify(canonicalToResponsesBody({ ...req, stream: false }, this.reasoningEffortsFor?.(req.model))) });
    if (!res.ok) throw new UpstreamError(res.status, `copilot responses failed: ${res.status}${await errorDetail(res)}`);
    return { ...parseResponsesResult(await res.json()), model: req.model };
  }
  private async *streamResponsesReq(req: CanonicalRequest): AsyncIterable<CanonicalChunk> {
    const token = await this.tokenStore.get();
    const res = await this.fetchFn(RESPONSES_URL, { method: "POST", headers: headers(token), body: JSON.stringify(canonicalToResponsesBody({ ...req, stream: true }, this.reasoningEffortsFor?.(req.model))) });
    if (!res.ok || !res.body) throw new UpstreamError(res.status, `copilot responses stream failed: ${res.status}${await errorDetail(res)}`);
    yield* streamResponses(res);
  }

  async *stream(req: CanonicalRequest): AsyncIterable<CanonicalChunk> {
    if (this.usesResponses(req.model)) { yield* this.streamResponsesReq(req); return; }
    const token = await this.tokenStore.get();
    const res = await this.fetchFn(CHAT_URL, { method: "POST", headers: headers(token), body: JSON.stringify(buildBody({ ...req, stream: true }, this.supportsReasoning(req.model), this.reasoningEffortsFor?.(req.model))) });
    if (!res.ok || !res.body) {
      const detail = await errorDetail(res);
      if (res.status === 400 && this.canUseResponses(req.model) && RESPONSES_HINT_RE.test(detail)) { yield* this.streamResponsesReq(req); return; }
      throw new UpstreamError(res.status, `copilot stream failed: ${res.status}${detail}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const startedTools = new Set<number>();
    let buffer = "";
    let finishReason: CanonicalResponse["finishReason"] = "stop";
    let usage: { promptTokens: number; completionTokens: number; cachedTokens?: number } | undefined;
    const mapFinish = (f: string | null | undefined): CanonicalResponse["finishReason"] =>
      f === "tool_calls" ? "tool_use" : f === "length" ? "length" : "stop";

    // Some models emit a tool call as inline XML text instead of native tool_calls (more likely on
    // long/tool-heavy turns) — and they do it even when THIS request declared no tools (a follow-up
    // turn, or a model that ignores the tools field). Always run assistant text through the extractor;
    // it only captures on the distinctive `<invoke>`/`<function_calls>` sentinel and flushes anything
    // unparseable back as text, so plain prose is unaffected.
    const extractor = new ToolCallExtractor();
    let extractedTool = false;
    let extIdx = 100; // separate index space so recovered tools never collide with native tool_calls
    const toChunks = (events: ExtractEvent[]): CanonicalChunk[] => {
      const out: CanonicalChunk[] = [];
      for (const ev of events) {
        if (ev.kind === "text") { if (ev.text) out.push({ kind: "text", delta: ev.text, done: false }); continue; }
        const index = extIdx++;
        extractedTool = true;
        out.push({ kind: "tool_use_start", index, id: ev.tool.id, name: ev.tool.name, done: false });
        out.push({ kind: "tool_use_delta", index, argsDelta: JSON.stringify(ev.tool.input), done: false });
      }
      return out;
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";
      for (const evt of events) {
        const line = evt.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") {
          if (extractor) for (const ch of toChunks(extractor.flush())) yield ch;
          if (extractedTool && finishReason === "stop") finishReason = "tool_use";
          yield { kind: "done", done: true, finishReason, usage };
          return;
        }
        let json: any;
        try { json = JSON.parse(payload); } catch { continue; }
        // Copilot sends a final frame with empty choices carrying usage (stream_options.include_usage).
        if (json.usage) usage = { promptTokens: json.usage.prompt_tokens ?? 0, completionTokens: json.usage.completion_tokens ?? 0, cachedTokens: json.usage.prompt_tokens_details?.cached_tokens ?? 0 };
        const choice = json.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = mapFinish(choice.finish_reason);
        const delta = choice.delta;
        if (!delta) continue;
        // Extended thinking: Copilot streams reasoning as `reasoning_text` deltas (+ a `reasoning_opaque`
        // continuation token) ahead of the answer `content`. Surface it as a canonical thinking chunk so
        // the relay can render it as an Anthropic thinking block. Emit before content to preserve order.
        if (delta.reasoning_text || delta.reasoning_opaque) {
          yield { kind: "thinking", delta: delta.reasoning_text ?? "", opaque: delta.reasoning_opaque, done: false };
        }
        if (delta.content) {
          if (extractor) { for (const ch of toChunks(extractor.feed(delta.content))) yield ch; }
          else yield { kind: "text", delta: delta.content, done: false };
        }
        for (const tc of delta.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          if (!startedTools.has(idx) && tc.function?.name) { startedTools.add(idx); yield { kind: "tool_use_start", index: idx, id: tc.id ?? `call_${idx}`, name: tc.function.name, done: false }; }
          if (tc.function?.arguments) yield { kind: "tool_use_delta", index: idx, argsDelta: tc.function.arguments, done: false };
        }
      }
    }
    if (extractor) for (const ch of toChunks(extractor.flush())) yield ch;
    if (extractedTool && finishReason === "stop") finishReason = "tool_use";
    yield { kind: "done", done: true, finishReason, usage };
  }
}
function safeJson(s: string): unknown { try { return JSON.parse(s); } catch { return {}; } }

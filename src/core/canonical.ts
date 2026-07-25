export interface TextBlock { type: "text"; text: string }
export interface ImageBlock { type: "image"; dataUrl: string } // full data URI, e.g. data:image/png;base64,...
export interface ToolUseBlock { type: "tool_use"; id: string; name: string; input: unknown;
  // A `custom` tool (Codex's `exec`) takes FREEFORM input — a raw string, not JSON args. When true,
  // `input` holds that raw string; the Responses translators emit/parse it as a custom_tool_call
  // (custom_tool_call_input events) rather than a function_call with JSON arguments.
  custom?: boolean }
export interface ToolResultBlock {
  type: "tool_result";
  toolUseId: string;
  content: string;
  // Images returned BY the tool (e.g. a Bash command that emits a screenshot, or an MCP tool that
  // returns an image). Anthropic/OpenAI both allow images inside a tool result, and Copilot accepts
  // them on a `tool` role message (probed). Kept as a separate field (not folded into `content`) so
  // the six existing string-only consumers of `content` stay untouched, while resize + token
  // estimation + the adapter opt into images. Each entry is a full data URI (data:image/...;base64,).
  images?: string[];
}
// Extended-thinking / reasoning output. `text` is the human-readable chain of thought; `opaque` is the
// upstream's signed/encrypted continuation token (Copilot's `reasoning_opaque`) that must be echoed back
// on the next turn to preserve the model's reasoning context across tool calls. Either may be empty.
export interface ThinkingBlock { type: "thinking"; text: string; opaque?: string }
export type ContentBlock = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock;

export interface CanonicalMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: ContentBlock[];
}
export interface CanonicalTool {
  name: string;
  description?: string;
  parameters: Record<string, unknown>; // JSON Schema
  // A `custom` tool (e.g. Codex's `exec`) takes freeform text input instead of JSON args. Copilot's
  // /responses accepts these as {type:"custom"} (probed) and returns a custom_tool_call. When true the
  // outbound translator emits {type:"custom", name, description} and drops the (unused) JSON schema.
  custom?: boolean;
}
// Reasoning controls. `effort` is the normalized knob clients ask for; the adapter maps it to each
// upstream's wire form (Copilot /chat + /responses take a top-level `reasoning_effort` enum). A client
// that sends an Anthropic-style token budget instead is mapped to the nearest effort by the inbound
// translator, so the canonical request always carries the normalized enum.
export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";
export interface ReasoningConfig {
  effort?: ReasoningEffort;
}
export interface CanonicalRequest {
  model: string;
  messages: CanonicalMessage[];
  stream: boolean;
  temperature?: number;
  maxTokens?: number;
  tools?: CanonicalTool[];
  // Hosted tool type names (e.g. "web_search") the gateway passes THROUGH to the upstream provider to
  // run server-side, rather than translating to function tools or executing itself. Used for Copilot's
  // native web_search on /responses (gpt-5 models), which Codex requests and Copilot fulfils directly.
  hostedTools?: string[];
  // Extended-thinking request knob. Present when a client asked the model to reason (Anthropic
  // `thinking`, OpenAI `reasoning_effort`); the adapter forwards it as the upstream's reasoning_effort.
  reasoning?: ReasoningConfig;
}
export interface CanonicalResponse {
  id: string;
  model: string;
  content: ContentBlock[]; // text and/or tool_use
  finishReason: "stop" | "length" | "tool_use" | "error";
  usage: { promptTokens: number; completionTokens: number };
}

// Streaming deltas. Tool-call deltas accumulate by index in the translator.
export type CanonicalChunk =
  | { kind: "text"; delta: string; done: false }
  | { kind: "thinking"; delta: string; opaque?: string; done: false }
  | { kind: "tool_use_start"; index: number; id: string; name: string; custom?: boolean; done: false }
  | { kind: "tool_use_delta"; index: number; argsDelta: string; done: false }
  | { kind: "done"; done: true; finishReason?: CanonicalResponse["finishReason"]; usage?: { promptTokens: number; completionTokens: number; cachedTokens?: number } };

export function textContent(s: string): ContentBlock[] {
  return [{ type: "text", text: s }];
}
export function joinText(blocks: ContentBlock[]): string {
  return blocks.filter((b): b is TextBlock => b.type === "text").map((b) => b.text).join("");
}

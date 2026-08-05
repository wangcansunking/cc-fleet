import type { ReasoningConfig, ReasoningEffort } from "./canonical.js";

// The effort enum Copilot accepts on /chat + /responses (and that Anthropic-protocol clients pick from).
// "none" disables reasoning; the rest scale depth. Unknown strings normalize to "medium" so a client
// sending a slightly-off label still gets reasoning rather than silently none.
const EFFORTS: ReasoningEffort[] = ["none", "low", "medium", "high", "xhigh", "max"];

// Claude clients can request an effort the mapped GPT backend doesn't advertise (e.g. `max` on
// gpt-5.4, whose ceiling is `xhigh`). Pick the closest supported level by ordinal distance so an alias
// degrades predictably instead of hard-400ing. Empty support means discovery is unknown: preserve the
// request and let the upstream decide, matching the existing pre-discovery behavior.
export function clampEffort(requested: ReasoningEffort, supported: readonly string[]): ReasoningEffort {
  const allowed = supported.filter((effort): effort is ReasoningEffort => EFFORTS.includes(effort as ReasoningEffort));
  if (!allowed.length || allowed.includes(requested)) return requested;
  const index = EFFORTS.indexOf(requested);
  return allowed.reduce((best, effort) =>
    Math.abs(EFFORTS.indexOf(effort) - index) < Math.abs(EFFORTS.indexOf(best) - index) ? effort : best,
  );
}

export function normalizeEffort(effort: string | undefined | null): ReasoningEffort | undefined {
  if (!effort) return undefined;
  const e = effort.toLowerCase();
  if ((EFFORTS as string[]).includes(e)) return e as ReasoningEffort;
  if (e === "minimal") return "low";   // gemini uses "minimal"
  return "medium";
}

// OpenAI `reasoning_effort` (a bare enum) -> canonical reasoning config.
export function reasoningFromEffort(effort: string | undefined | null): ReasoningConfig | undefined {
  const e = normalizeEffort(effort);
  return e ? { effort: e } : undefined;
}

// Anthropic `thinking: { type: "enabled", budget_tokens }` -> canonical reasoning. LEGACY clients
// (Opus 4.6 / Sonnet 4.6 and older) gate reasoning with a TOKEN BUDGET, not an enum, so map the budget
// onto the nearest effort bucket. The buckets mirror Copilot's advertised min/max thinking budget
// (~1k..32k). type:"disabled" (or absent) yields no reasoning. NOTE: newer clients (Opus 4.7/4.8,
// Claude Code 2.1.x) no longer send budget_tokens — they send output_config.effort instead; see
// resolveReasoning, which is the real inbound entry point.
export function reasoningFromThinking(thinking: { type?: string; budget_tokens?: number } | undefined): ReasoningConfig | undefined {
  if (!thinking || thinking.type === "disabled") return undefined;
  const budget = thinking.budget_tokens;
  if (budget == null) return { effort: "medium" }; // enabled with no explicit budget
  if (budget <= 2048) return { effort: "low" };
  if (budget <= 8192) return { effort: "medium" };
  if (budget <= 20000) return { effort: "high" };
  return { effort: "max" };
}

// THE real inbound resolver for Anthropic requests, reflecting the live-captured wire of Claude Code
// 2.1.195 / Opus 4.7-4.8: reasoning effort arrives in a TOP-LEVEL `output_config: { effort }` (driven
// by /effort, CLAUDE_EFFORT, or the thinking keywords), while `thinking` only carries
// `{ type: "adaptive" | "disabled" }` with NO budget_tokens. Precedence:
//   1. thinking.type === "disabled"  -> reasoning OFF (the user toggled thinking off), regardless of effort.
//   2. output_config.effort present  -> use it (the value the user actually picked). THIS is the fix:
//      previously we only read thinking.budget_tokens, so a modern client's effort was dropped and an
//      adaptive turn fabricated a bogus "medium".
//   3. else fall back to the legacy thinking budget (older clients that still send budget_tokens).
//   4. adaptive/enabled with neither effort nor budget -> undefined (let the model/default decide;
//      do NOT fabricate an effort the user never chose).
export function resolveReasoning(
  outputConfig: { effort?: string } | undefined,
  thinking: { type?: string; budget_tokens?: number } | undefined,
): ReasoningConfig | undefined {
  if (thinking?.type === "disabled") return undefined;
  const fromEffort = reasoningFromEffort(outputConfig?.effort);
  if (fromEffort) return fromEffort;
  if (thinking?.budget_tokens != null) return reasoningFromThinking(thinking);
  return undefined;
}

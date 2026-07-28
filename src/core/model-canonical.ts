// Maps Copilot's model ids to the canonical ids Claude Code recognises, so its native /model picker
// lights up with friendly names, tier grouping, and the 1M-context badge instead of bare ids.
//
// Copilot advertises DOTTED ids (claude-opus-4.8); Claude Code's built-in table keys on DASHED ids
// (claude-opus-4-8) and shows the 1M badge only when the id ends with the [1m] suffix. So OUTBOUND
// (/v1/models, ANTHROPIC_MODEL) we dash every claude id + add [1m] for the families Claude Code knows
// to be 1M; INBOUND the proxy strips [1m] and fuzzy-maps the dashed id back to Copilot's dotted id
// (see bestModelMatch). Non-claude ids (gpt*, o3*) have no canonical form → pass through untouched.
export const ONE_M_SUFFIX = "[1m]";

// Dashed canonical ids known to carry a 1M window — the FALLBACK used when a caller can't supply live
// capabilities (e.g. TUI setup, or a worker whose discovery hasn't resolved / failed). Should reflect
// the KNOWN-CURRENT 1M models; the worker's /v1/models route additionally passes a live is1M oracle
// (from upstream max_context_window_tokens) so FUTURE 1M families badge correctly with zero code changes.
// Anchored on the probed v2.1.195 binary table + models since confirmed 1M upstream (claude-sonnet-5).
export const DEFAULT_ONE_M_MODELS = new Set(["claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8", "claude-opus-5", "claude-sonnet-4-6", "claude-sonnet-5"]);

// claude-<family>-<version> -> "Family Version". Family is any lowercase word (so future families like
// `fable` work); version is one or two dash-separated numeric segments joined with a dot, so BOTH the
// two-segment ids (claude-opus-4-8 -> "Opus 4.8") and single-segment ids (claude-sonnet-5 -> "Sonnet 5")
// get a friendly name. Anything that doesn't match echoes back unchanged.
function displayName(dashed: string): string {
  const m = /^claude-([a-z]+)-(\d+(?:-\d+)?)$/.exec(dashed);
  if (!m) return dashed;
  const [, fam, ver] = m;
  return `${fam[0].toUpperCase()}${fam.slice(1)} ${ver.replace(/-/g, ".")}`;
}

export interface CanonicalModel { id: string; display_name: string }

// Outbound: Copilot id -> the id+display Claude Code's picker understands. Claude ids are dashed to the
// canonical form; a model gets the [1m] suffix (badge + 1M context sizing) when `is1M` says so. `is1M`
// receives the DASHED id and is injected by callers holding live upstream capabilities; when omitted
// (no live data yet), it falls back to DEFAULT_ONE_M_MODELS so behaviour is unchanged for known models.
// Non-claude ids echo back as-is so they still appear, just without native metadata.
export function toCanonical(copilotId: string, is1M?: (dashed: string) => boolean): CanonicalModel {
  if (!copilotId.startsWith("claude-")) return { id: copilotId, display_name: copilotId };
  const dashed = copilotId.replace(/\./g, "-");
  const oneM = is1M ? is1M(dashed) : DEFAULT_ONE_M_MODELS.has(dashed);
  const id = oneM ? `${dashed}${ONE_M_SUFFIX}` : dashed;
  return { id, display_name: displayName(dashed) };
}

// Inbound: drop the [1m] picker suffix. The dashed canonical id then resolves back to Copilot's
// dotted id via the router's exact map + fuzzy fallback; nothing else to do here.
export function stripOneM(model: string): string {
  return model.endsWith(ONE_M_SUFFIX) ? model.slice(0, -ONE_M_SUFFIX.length) : model;
}

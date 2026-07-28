export interface Endpoint { host: string; port: number; apiKey: string }
export interface ClientSetup { env: Record<string, string>; instructions: string }
import { toCanonical, stripOneM } from "../../core/model-canonical.js";

export function claudeCodeConfig(e: Endpoint): ClientSetup {
  const base = `http://${e.host}:${e.port}/anthropic`;
  return {
    env: { ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: e.apiKey },
    instructions: `Set these env vars for Claude Code:\n  ANTHROPIC_BASE_URL=${base}\n  ANTHROPIC_API_KEY=${e.apiKey}`,
  };
}
export const ONE_M_SUFFIX = "[1m]";

// Claude Code switches to its 1M window only when ANTHROPIC_MODEL ends with `[1m]`, and only matches
// the model to its native picker entry when the id is the DASHED canonical form it knows
// (claude-opus-4-8, not Copilot's dotted claude-opus-4.8). Route the default model through toCanonical
// so it's both dashed and 1M-badged; for non-claude ids keep the legacy context-window suffix. The
// proxy strips [1m] + fuzzy-maps back to Copilot before forwarding.
//
// The 1M decision is driven by the REAL context window we were handed (fetchModelLimits), in the same
// ~800K..1.5M band agent-maestro uses, so a newly-shipped 1M model (claude-opus-5, or any future
// family) gets [1m] with zero list edits. Only when the window is unknown (discovery not yet resolved /
// no token) do we fall back to toCanonical's hardcoded DEFAULT_ONE_M_MODELS, so known models still badge.
export function withClaude1mSuffix(model: string, contextWindow?: number): string {
  const inBand = contextWindow != null && contextWindow > 800_000 && contextWindow < 1_500_000;
  // Strip any suffix the caller already applied so we never double-append when re-canonicalizing.
  const bare = stripOneM(model);
  if (bare.startsWith("claude-")) return toCanonical(bare, contextWindow != null ? () => inBand : undefined).id;
  return inBand && !model.endsWith(ONE_M_SUFFIX) ? `${model}${ONE_M_SUFFIX}` : model;
}

// Claude Code renders a model its BUILT-IN table doesn't know (one shipped after the CLI binary, e.g.
// claude-opus-5) as a RAW id in the picker + status line — `claude-opus-5[1m]` instead of a friendly
// `Opus 5 (1M context)`. Note this is DISPLAY ONLY: the 1M window itself comes from the `[1m]` suffix,
// which Claude Code matches with a plain regex (`/\[1m\]/i`), so an unknown model still gets the full
// 1M window — it just looks ugly.
//
// The supported escape hatch is the per-family custom-model env trio. Verified against the 2.1.216
// binary: the picker entry is built as
//   { value:"opus", label: ANTHROPIC_DEFAULT_OPUS_MODEL_NAME ?? <raw id>,
//     description: ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION ?? `Custom Opus model (1M context)` }
// gated on a check that passes whenever ANTHROPIC_BASE_URL isn't api.anthropic.com — i.e. always,
// through this proxy. Setting the trio also points the family ALIAS (`opus`, `sonnet`, …) at our model,
// so `/model opus` selects it. `(1M context)` only lands in the description by default, so we fold it
// into the label ourselves to match how built-in 1M models read in the status line.
//
// Only the families Claude Code exposes an alias for are eligible; anything else is left alone (it would
// have no env to write). Returns {} for non-claude ids.
const CLAUDE_ALIAS_FAMILIES = new Set(["opus", "sonnet", "haiku", "fable"]);

export function claudeCustomModelEnv(model: string, contextWindow?: number): Record<string, string> {
  const canonical = withClaude1mSuffix(model, contextWindow);
  const bare = stripOneM(canonical);
  const family = /^claude-([a-z]+)-/.exec(bare)?.[1];
  if (!family || !CLAUDE_ALIAS_FAMILIES.has(family)) return {};
  const prefix = `ANTHROPIC_DEFAULT_${family.toUpperCase()}_MODEL`;
  const oneM = canonical.endsWith(ONE_M_SUFFIX);
  const display = toCanonical(bare).display_name;
  return {
    [prefix]: canonical,
    [`${prefix}_NAME`]: oneM ? `${display} (1M context)` : display,
    [`${prefix}_DESCRIPTION`]: `${display}${oneM ? " · 1M context" : ""} · via copilot-reverse`,
  };
}

// The full env copilot-reverse writes into Claude Code's settings.json. Beyond the endpoint, it tells
// Claude Code the selected model's real context window (via the [1m] model suffix and
// CLAUDE_CODE_AUTO_COMPACT_WINDOW) so the client stops assuming the default 200K. Mirrors agent-maestro.
export function claudeCopilotReverseEnv(base: string, apiKey: string, model: string, contextWindow?: number): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: base,
    ANTHROPIC_API_KEY: apiKey,
    ANTHROPIC_MODEL: withClaude1mSuffix(model, contextWindow),
    ...(contextWindow ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(contextWindow) } : {}),
    // Friendly name + family alias for a model Claude Code's built-in table doesn't carry yet.
    ...claudeCustomModelEnv(model, contextWindow),
    CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "80",
    CLAUDE_CODE_ATTRIBUTION_HEADER: "0", // keep prompt caching working on a non-Anthropic gateway
    // NOTE: we deliberately do NOT set CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC. It reads like a
    // privacy win, but Claude Code gates gateway model discovery behind the same "essential traffic
    // only" switch — with it set, the discovery fetch returns before writing
    // ~/.claude/cache/gateway-models.json, so the picker below never sees our models and silently
    // falls back to Claude Code's built-in table. applyClaude strips it from older installs.
    // Populate Claude Code's /model picker from our /anthropic/v1/models so the user can switch
    // models natively. Coexists with ANTHROPIC_MODEL (which stays the 1M default — it does NOT lock
    // the picker). Claude Code >=2.1.129 only; older builds ignore it. Picker lists claude* ids.
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
  };
}

export function codexConfig(e: Endpoint): ClientSetup {
  const base = `http://${e.host}:${e.port}/openai`;
  return {
    env: { OPENAI_BASE_URL: base, OPENAI_API_KEY: e.apiKey },
    instructions: `Set these env vars for Codex / OpenAI clients:\n  OPENAI_BASE_URL=${base}\n  OPENAI_API_KEY=${e.apiKey}`,
  };
}

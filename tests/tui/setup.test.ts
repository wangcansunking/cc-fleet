import { describe, it, expect } from "vitest";
import { claudeCodeConfig, codexConfig, claudeCopilotReverseEnv, withClaude1mSuffix, claudeCustomModelEnv } from "../../src/tui/setup/clients.js";

describe("withClaude1mSuffix", () => {
  it("maps a claude model to the dashed canonical id + [1m] so Claude Code's picker matches it", () => {
    expect(withClaude1mSuffix("claude-opus-4.8", 1_000_000)).toBe("claude-opus-4-8[1m]");
    expect(withClaude1mSuffix("claude-opus-4.8", 936_000)).toBe("claude-opus-4-8[1m]");
  });
  it("dashes sub-1M claude models without [1m], leaves unknowns alone, no double-append", () => {
    expect(withClaude1mSuffix("claude-opus-4.5", 200_000)).toBe("claude-opus-4-5");
    expect(withClaude1mSuffix("gpt-4o")).toBe("gpt-4o");
    expect(withClaude1mSuffix("claude-opus-4-8[1m]", 1_000_000)).toBe("claude-opus-4-8[1m]");
  });
  // Regression: the 1M decision must follow the REAL context window we were handed, not a hardcoded
  // list. A freshly-shipped 1M claude model (claude-opus-5) whose window is 1M gets [1m] even though it
  // predates any list edit; a brand-new family (claude-fable-5) does too. Before the fix, claude ids
  // ignored contextWindow and consulted DEFAULT_ONE_M_MODELS, so opus-5 shipped WITHOUT [1m] → Claude
  // Code sized it at 200K instead of 1M.
  it("badges any claude model 1M from its real window, even one not in the default set", () => {
    expect(withClaude1mSuffix("claude-opus-5", 1_000_000)).toBe("claude-opus-5[1m]");
    expect(withClaude1mSuffix("claude-fable-5", 1_000_000)).toBe("claude-fable-5[1m]");
  });
  // The inverse: a live sub-1M window must strip a badge the hardcoded default set would otherwise add,
  // so data wins over the fallback in both directions.
  it("omits [1m] when the live window is sub-1M, even for a default-set member", () => {
    expect(withClaude1mSuffix("claude-opus-4.8", 200_000)).toBe("claude-opus-4-8");
  });
  // When no window is known (discovery not resolved / no token) it falls back to the default set, so a
  // known 1M model still badges rather than briefly sizing at 200K.
  it("falls back to the default set when the window is unknown", () => {
    expect(withClaude1mSuffix("claude-opus-4.8")).toBe("claude-opus-4-8[1m]");
    expect(withClaude1mSuffix("claude-opus-5")).toBe("claude-opus-5[1m]");
  });
});

describe("claudeCustomModelEnv", () => {
  // Claude Code shows a model missing from its built-in table as a raw id ("claude-opus-5[1m]"). The
  // per-family custom-model trio gives it a friendly label + points the family alias at it.
  it("declares name + alias for a 1M model the built-in table lacks", () => {
    expect(claudeCustomModelEnv("claude-opus-5", 1_000_000)).toEqual({
      ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5[1m]",
      ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: "Opus 5 (1M context)",
      ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION: "Opus 5 · 1M context · via copilot-reverse",
    });
  });
  it("uses the model's own family, and omits the 1M label for a sub-1M window", () => {
    const env = claudeCustomModelEnv("claude-sonnet-4.5", 200_000);
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("claude-sonnet-4-5");
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME).toBe("Sonnet 4.5");
  });
  it("leaves non-claude ids and unknown families alone (no env to write)", () => {
    expect(claudeCustomModelEnv("gpt-4o", 1_000_000)).toEqual({});
    expect(claudeCustomModelEnv("claude-mythos-preview", 1_000_000)).toEqual({});
  });
});

describe("claudeCopilotReverseEnv", () => {  it("writes the canonical dashed [1m] model + window so Claude Code matches + uses 1M", () => {
    const env = claudeCopilotReverseEnv("http://127.0.0.1:7891", "k", "claude-opus-4.8", 1_000_000);
    expect(env.ANTHROPIC_MODEL).toBe("claude-opus-4-8[1m]");
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("1000000");
    expect(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe("80");
    expect(env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe("0");
    expect(env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).toBe("1"); // /model picker is populated, not locked
  });
  it("omits the window/suffix when it's unknown", () => {
    const env = claudeCopilotReverseEnv("http://x", "k", "gpt-4o");
    expect(env.ANTHROPIC_MODEL).toBe("gpt-4o");
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
  });
  it("keeps a mapped setup pinned to its native Claude alias, not the GPT backend", () => {
    const env = claudeCopilotReverseEnv("http://x", "k", "claude-opus-5", 1_100_000);
    expect(env.ANTHROPIC_MODEL).toBe("claude-opus-5[1m]");
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("claude-opus-5[1m]");
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME).toBe("Opus 5 (1M context)");
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("1100000");
  });
  // Regression: setup used to write CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 alongside
  // CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1. The former gates the latter — Claude Code's
  // discovery fetch bails when traffic is "essential only", so gateway-models.json is never written
  // and the /model picker silently shows only its built-in models. The two must never coexist.
  it("never writes the traffic switch that would defeat gateway model discovery", () => {
    const env = claudeCopilotReverseEnv("http://127.0.0.1:7891", "k", "claude-opus-5", 1_000_000);
    expect(env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).toBe("1");
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBeUndefined();
  });
});

describe("client setup", () => {
  it("claude code points ANTHROPIC_BASE_URL at the worker's /anthropic prefix", () => {
    const c = claudeCodeConfig({ host: "127.0.0.1", port: 7891, apiKey: "k" });
    expect(c.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:7891/anthropic");
    expect(c.env.ANTHROPIC_API_KEY).toBe("k");
    expect(c.instructions).toMatch(/ANTHROPIC_BASE_URL/);
  });
  it("codex points at the worker's /openai prefix", () => {
    const c = codexConfig({ host: "127.0.0.1", port: 7891, apiKey: "k" });
    expect(c.env.OPENAI_BASE_URL).toBe("http://127.0.0.1:7891/openai");
  });
});

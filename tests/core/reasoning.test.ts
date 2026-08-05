import { describe, it, expect } from "vitest";
import { clampEffort, normalizeEffort, reasoningFromEffort, reasoningFromThinking, resolveReasoning } from "../../src/core/reasoning.js";

describe("reasoning normalization", () => {
  it("passes through the canonical effort enum", () => {
    for (const e of ["none", "low", "medium", "high", "xhigh", "max"]) {
      expect(normalizeEffort(e)).toBe(e);
    }
  });
  it("maps gemini's 'minimal' to low and unknown labels to medium", () => {
    expect(normalizeEffort("minimal")).toBe("low");
    expect(normalizeEffort("turbo")).toBe("medium");
  });
  it("returns undefined for empty/absent effort", () => {
    expect(normalizeEffort(undefined)).toBeUndefined();
    expect(normalizeEffort("")).toBeUndefined();
    expect(reasoningFromEffort(undefined)).toBeUndefined();
  });
  it("reasoningFromEffort wraps a normalized effort", () => {
    expect(reasoningFromEffort("HIGH")).toEqual({ effort: "high" });
  });

  it("clamps an unsupported requested effort to the nearest advertised level", () => {
    expect(clampEffort("max", ["none", "low", "medium", "high", "xhigh"])).toBe("xhigh");
    expect(clampEffort("xhigh", ["none", "low", "medium", "high"])).toBe("high");
    expect(clampEffort("medium", ["none", "low", "high"])).toBe("low");
    expect(clampEffort("none", ["low", "medium"])).toBe("low");
    expect(clampEffort("max", [])).toBe("max"); // unknown support: preserve the request
  });

  it("buckets Anthropic thinking budgets onto efforts at the boundaries", () => {
    expect(reasoningFromThinking({ type: "enabled", budget_tokens: 1024 })).toEqual({ effort: "low" });
    expect(reasoningFromThinking({ type: "enabled", budget_tokens: 2048 })).toEqual({ effort: "low" });
    expect(reasoningFromThinking({ type: "enabled", budget_tokens: 2049 })).toEqual({ effort: "medium" });
    expect(reasoningFromThinking({ type: "enabled", budget_tokens: 8192 })).toEqual({ effort: "medium" });
    expect(reasoningFromThinking({ type: "enabled", budget_tokens: 16000 })).toEqual({ effort: "high" });
    expect(reasoningFromThinking({ type: "enabled", budget_tokens: 32000 })).toEqual({ effort: "max" });
  });
  it("treats enabled-without-budget as medium, disabled/absent as none", () => {
    expect(reasoningFromThinking({ type: "enabled" })).toEqual({ effort: "medium" });
    expect(reasoningFromThinking({ type: "disabled" })).toBeUndefined();
    expect(reasoningFromThinking(undefined)).toBeUndefined();
  });
});

// resolveReasoning is the REAL inbound entry: it reflects what Claude Code 2.1.195 / Opus 4.7-4.8
// actually send on the wire (captured live) — a top-level `output_config: { effort }` plus a
// `thinking: { type: "adaptive" | "disabled" }` that no longer carries budget_tokens.
describe("resolveReasoning (real Claude Code wire)", () => {
  it("reads effort from output_config.effort — the value the user actually picked (/effort, CLAUDE_EFFORT)", () => {
    for (const eff of ["low", "medium", "high", "xhigh", "max"]) {
      expect(resolveReasoning({ effort: eff }, { type: "adaptive" })).toEqual({ effort: eff });
    }
  });

  it("output_config.effort takes precedence over a legacy thinking budget", () => {
    expect(resolveReasoning({ effort: "max" }, { type: "enabled", budget_tokens: 1024 })).toEqual({ effort: "max" });
  });

  it("thinking.type 'disabled' suppresses reasoning even if an effort is present (thinking off)", () => {
    expect(resolveReasoning({ effort: "high" }, { type: "disabled" })).toBeUndefined();
  });

  it("falls back to the legacy thinking budget when no output_config is sent (older clients)", () => {
    expect(resolveReasoning(undefined, { type: "enabled", budget_tokens: 16000 })).toEqual({ effort: "high" });
  });

  it("adaptive thinking with no output_config yields no explicit effort (let the model/default decide)", () => {
    // adaptive == "model decides"; without an explicit effort we must NOT fabricate one.
    expect(resolveReasoning(undefined, { type: "adaptive" })).toBeUndefined();
  });

  it("returns undefined when neither field carries reasoning", () => {
    expect(resolveReasoning(undefined, undefined)).toBeUndefined();
    expect(resolveReasoning({}, undefined)).toBeUndefined();
  });
});

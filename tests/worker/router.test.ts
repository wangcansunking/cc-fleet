import { describe, it, expect } from "vitest";
import { Router } from "../../src/worker/router.js";
import { toCanonical } from "../../src/core/model-canonical.js";
import type { ProviderAdapter } from "../../src/providers/types.js";

const fake: ProviderAdapter = { name: "copilot", complete: async () => ({ id: "x", model: "m", content: [], finishReason: "stop", usage: { promptTokens: 0, completionTokens: 0 } }), async *stream() {} };

describe("Router", () => {
  it("maps model names via modelMap with * fallback", () => {
    const r = new Router([fake], { "claude-opus-4-8": "gpt-4o", "*": "gpt-4o-mini" });
    expect(r.resolveModel("claude-opus-4-8")).toBe("gpt-4o");
    expect(r.resolveModel("whatever")).toBe("gpt-4o-mini");
  });
  it("fuzzy-matches a near-miss model id to an available Copilot model", () => {
    const r = new Router([fake], {});
    r.setAvailableModels(["claude-opus-4.8", "gpt-4o"]);
    expect(r.resolveModel("claude-opus-4-8-20251101")).toBe("claude-opus-4.8");
    expect(r.resolveModel("gpt-4o")).toBe("gpt-4o"); // exact stays
    expect(r.resolveModel("unknown-xyz")).toBe("unknown-xyz"); // no match -> passthrough
  });
  it("strips Claude Code's [1m] suffix before forwarding to Copilot", () => {
    const r = new Router([fake], {});
    r.setAvailableModels(["claude-opus-4.8", "gpt-4o"]);
    expect(r.resolveModel("claude-opus-4.8[1m]")).toBe("claude-opus-4.8");
  });
  it("round-trips every advertised canonical id back to its Copilot model", () => {
    const r = new Router([fake], {});
    r.setAvailableModels(["claude-opus-4.8", "claude-sonnet-4.6", "claude-sonnet-5", "claude-haiku-4-5", "gpt-4o"]);
    for (const real of ["claude-opus-4.8", "claude-sonnet-4.6", "claude-sonnet-5", "claude-haiku-4-5"]) {
      expect(r.resolveModel(toCanonical(real).id)).toBe(real);
    }
  });
  it("round-trips a 1M-badged single-segment id (sonnet-5[1m]) back to its Copilot model", () => {
    // The picker advertises claude-sonnet-5[1m] when the oracle marks it 1M; the inbound path must strip
    // [1m] and resolve it back to the dotted upstream id, exactly as it does for the opus/sonnet families.
    const r = new Router([fake], {});
    r.setAvailableModels(["claude-sonnet-5", "gpt-4o"]);
    expect(r.resolveModel(toCanonical("claude-sonnet-5", () => true).id)).toBe("claude-sonnet-5");
  });
  it("keeps compatibility aliases completely disabled by default", () => {
    const r = new Router([fake], {});
    r.setAvailableModels(["gpt-5.6-sol", "gpt-4o"]);
    r.setModelLimits({ "gpt-5.6-sol": 1_100_000 });
    expect(r.resolveModel("claude-opus-5[1m]")).toBe("claude-opus-5");
    expect(r.listAnthropicModels().map((m) => m.id)).toEqual(["gpt-5.6-sol", "gpt-4o"]);
  });

  it("adds live Claude aliases to Anthropic discovery and resolves them to GPT backends when enabled", () => {
    const r = new Router([fake], {}, { claudeMapEnabled: true });
    r.setAvailableModels(["gpt-5.6-sol", "gpt-5.6-luna", "gpt-4o"]);
    r.setModelLimits({ "gpt-5.6-sol": 1_100_000, "gpt-5.6-luna": 1_100_000 });
    expect(r.resolveModel("claude-opus-5[1m]")).toBe("gpt-5.6-sol");
    expect(r.resolveModel("claude-sonnet-5[1m]")).toBe("claude-sonnet-5"); // terra is not live
    expect(r.listModels()).toEqual(["gpt-5.6-sol", "gpt-5.6-luna", "gpt-4o"]); // OpenAI stays real-only
    expect(r.listAnthropicModels()).toEqual([
      { id: "gpt-5.6-sol", display_name: "gpt-5.6-sol" },
      { id: "gpt-5.6-luna", display_name: "gpt-5.6-luna" },
      { id: "gpt-4o", display_name: "gpt-4o" },
      { id: "claude-opus-4-8[1m]", display_name: "Opus 4.8" },
      { id: "claude-opus-5[1m]", display_name: "Opus 5" },
    ]);
  });

  it("derives a mapped alias context window from its GPT backend", () => {
    const r = new Router([fake], {}, { claudeMapEnabled: true });
    r.setAvailableModels(["gpt-5.6-sol"]);
    r.setModelLimits({ "gpt-5.6-sol": 1_100_000 });
    expect(r.modelLimit("claude-opus-5[1m]")).toBe(1_100_000);
    expect(r.modelLimit("gpt-5.6-sol")).toBe(1_100_000);
  });

  it("does not publish or resolve aliases from an offline fallback list", () => {
    const r = new Router([fake], {}, { claudeMapEnabled: true });
    r.setAvailableModels(["gpt-5.6-sol", "gpt-4o"], false);
    r.setModelLimits({ "gpt-5.6-sol": 1_100_000 });
    expect(r.listAnthropicModels().map((m) => m.id)).toEqual(["gpt-5.6-sol", "gpt-4o"]);
    expect(r.resolveModel("claude-opus-5[1m]")).toBe("claude-opus-5");
  });

  it("replaces an existing Claude discovery entry with backend-derived metadata in map mode", () => {
    const r = new Router([fake], {}, { claudeMapEnabled: true });
    r.setAvailableModels(["claude-opus-5", "gpt-5.6-sol"]);
    r.setModelLimits({ "claude-opus-5": 200_000, "gpt-5.6-sol": 1_100_000 });
    expect(r.listAnthropicModels()).toEqual([
      { id: "claude-opus-5[1m]", display_name: "Opus 5" },
      { id: "gpt-5.6-sol", display_name: "gpt-5.6-sol" },
    ]);
    expect(r.resolveModel("claude-opus-5[1m]")).toBe("gpt-5.6-sol");
  });

  it("returns the only provider", () => {
    expect(new Router([fake], { "*": "gpt-4o" }).pick("x").name).toBe("copilot");
  });
  it("throws with no providers", () => {
    expect(() => new Router([], { "*": "gpt-4o" }).pick("x")).toThrow(/no provider/i);
  });
});

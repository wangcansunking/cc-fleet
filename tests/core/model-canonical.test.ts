import { describe, it, expect } from "vitest";
import { toCanonical, stripOneM, ONE_M_SUFFIX } from "../../src/core/model-canonical.js";

describe("toCanonical (outbound /v1/models)", () => {
  it("maps Copilot's dotted opus id to the dashed canonical id + display + 1M badge", () => {
    expect(toCanonical("claude-opus-4.8")).toEqual({ id: "claude-opus-4-8[1m]", display_name: "Opus 4.8" });
  });
  it("maps sonnet to dashed canonical + 1M", () => {
    expect(toCanonical("claude-sonnet-4.6")).toEqual({ id: "claude-sonnet-4-6[1m]", display_name: "Sonnet 4.6" });
  });
  it("maps haiku without a 1M badge (no 1M window)", () => {
    expect(toCanonical("claude-haiku-4.5")).toEqual({ id: "claude-haiku-4-5", display_name: "Haiku 4.5" });
  });
  it("dashes other claude families without a 1M badge", () => {
    expect(toCanonical("claude-sonnet-4.5")).toEqual({ id: "claude-sonnet-4-5", display_name: "Sonnet 4.5" });
    expect(toCanonical("claude-opus-4.7")).toEqual({ id: "claude-opus-4-7[1m]", display_name: "Opus 4.7" });
  });
  it("passes non-claude ids through untouched", () => {
    expect(toCanonical("gpt-4o")).toEqual({ id: "gpt-4o", display_name: "gpt-4o" });
    expect(toCanonical("o3-mini")).toEqual({ id: "o3-mini", display_name: "o3-mini" });
  });

  // Single-segment version ids (claude-sonnet-5) and future families (claude-fable-5) must still get a
  // friendly display name — the old two-segment-only regex left them as bare ids. sonnet-5 is a known-
  // current 1M model so it's in the default set → badged even without an oracle; fable-5 is a future
  // family NOT in the default set → named but unbadged until a live oracle marks it 1M.
  it("badges a known single-segment 1M id (sonnet-5) from the default set, no oracle needed", () => {
    expect(toCanonical("claude-sonnet-5")).toEqual({ id: "claude-sonnet-5[1m]", display_name: "Sonnet 5" });
  });
  it("badges opus-5 from the default set, no oracle needed", () => {
    expect(toCanonical("claude-opus-5")).toEqual({ id: "claude-opus-5[1m]", display_name: "Opus 5" });
  });
  it("names an unknown future family from its id, no badge until an oracle says 1M", () => {
    expect(toCanonical("claude-fable-5")).toEqual({ id: "claude-fable-5", display_name: "Fable 5" });
  });

  // Capability injection: when the caller (the worker, holding the live /models list) passes an is1M
  // oracle, the [1m] badge follows the REAL upstream context window, not the hardcoded set. This is what
  // makes any future 1M model (claude-fable-5) badge correctly with zero code changes.
  it("badges a future family as 1M when the oracle says so", () => {
    expect(toCanonical("claude-fable-5", () => true)).toEqual({ id: "claude-fable-5[1m]", display_name: "Fable 5" });
  });
  it("lets the oracle override the default set (data wins over the hardcoded fallback)", () => {
    // opus-4.5 is 200K, not in the default set → no badge normally; an oracle asserting 1M must win.
    expect(toCanonical("claude-opus-4.5", () => true)).toEqual({ id: "claude-opus-4-5[1m]", display_name: "Opus 4.5" });
    // and the inverse: an oracle asserting NOT-1M must strip a badge the default set would have added.
    expect(toCanonical("claude-opus-4.8", () => false)).toEqual({ id: "claude-opus-4-8", display_name: "Opus 4.8" });
  });
});

describe("stripOneM (inbound)", () => {
  it("removes the [1m] picker suffix", () => {
    expect(stripOneM(`claude-opus-4-8${ONE_M_SUFFIX}`)).toBe("claude-opus-4-8");
  });
  it("leaves ids without the suffix unchanged", () => {
    expect(stripOneM("gpt-4o")).toBe("gpt-4o");
  });
});

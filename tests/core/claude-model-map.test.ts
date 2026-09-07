import { describe, expect, it } from "vitest";
import {
  BUILTIN_CLAUDE_MODEL_MAP,
  CLAUDE_MODEL_MAP,
  availableClaudeMappings,
  backendForClaudeAlias,
  claudeMappingRows,
  effectiveClaudeMappings,
  mappedModelIds,
  modelMapDisplay,
} from "../../src/core/claude-model-map.js";

describe("Claude model compatibility map", () => {
  it("keeps the approved presets as the versioned built-in baseline", () => {
    expect(BUILTIN_CLAUDE_MODEL_MAP).toEqual([
      { alias: "claude-haiku-4-5", backend: "gpt-5.4" },
      { alias: "claude-sonnet-4-6", backend: "gpt-5.5" },
      { alias: "claude-opus-4-8", backend: "gpt-5.6-luna" },
      { alias: "claude-opus-5", backend: "gpt-5.6-sol" },
      { alias: "claude-sonnet-5", backend: "gpt-5.6-terra" },
    ]);
    expect(CLAUDE_MODEL_MAP).toBe(BUILTIN_CLAUDE_MODEL_MAP);
  });

  it("applies user additions, overrides, and disables over built-ins", () => {
    const effective = effectiveClaudeMappings([
      { alias: "claude-opus-5", backend: "gemini-3-pro" },
      { alias: "claude-haiku-4-5", disabled: true },
      { alias: "claude-fable-6-1", backend: "grok-code-fast-2" },
    ]);
    expect(effective).toContainEqual({
      alias: "claude-opus-5", backend: "gemini-3-pro", source: "user", disabled: false, hasOverride: true,
    });
    expect(effective).toContainEqual({
      alias: "claude-haiku-4-5", source: "user", disabled: true, hasOverride: true,
    });
    expect(effective).toContainEqual({
      alias: "claude-fable-6-1", backend: "grok-code-fast-2", source: "user", disabled: false, hasOverride: true,
    });
    expect(effective).toContainEqual({
      alias: "claude-sonnet-4-6", backend: "gpt-5.5", source: "builtin", disabled: false, hasOverride: false,
    });
  });

  it("falls back to built-ins after removing overrides and drops user-only aliases", () => {
    const withOverrides = effectiveClaudeMappings([
      { alias: "claude-opus-5", backend: "gemini-3-pro" },
      { alias: "claude-fable-6-1", backend: "grok-code-fast-2" },
    ]);
    const reset = effectiveClaudeMappings([]);
    expect(withOverrides.find((x) => x.alias === "claude-opus-5")?.backend).toBe("gemini-3-pro");
    expect(reset.find((x) => x.alias === "claude-opus-5")?.backend).toBe("gpt-5.6-sol");
    expect(reset.find((x) => x.alias === "claude-fable-6-1")).toBeUndefined();
  });

  it("publishes only enabled mappings whose exact arbitrary backend is live", () => {
    const mappings = effectiveClaudeMappings([
      { alias: "claude-opus-5", backend: "gemini-3-pro" },
      { alias: "claude-sonnet-5", disabled: true },
      { alias: "claude-fable-6-1", backend: "grok-code-fast-2" },
    ]);
    expect(availableClaudeMappings(mappings, ["gemini-3-pro", "grok-code-fast-2", "gpt-4o"])).toEqual([
      expect.objectContaining({ alias: "claude-fable-6-1", backend: "grok-code-fast-2" }),
      expect.objectContaining({ alias: "claude-opus-5", backend: "gemini-3-pro" }),
    ]);
  });

  it("resolves canonical and [1m] aliases only when their exact backend is live", () => {
    const mappings = effectiveClaudeMappings([{ alias: "claude-opus-5", backend: "gemini-3-pro" }]);
    expect(backendForClaudeAlias(mappings, "claude-opus-5", ["gemini-3-pro"])).toBe("gemini-3-pro");
    expect(backendForClaudeAlias(mappings, "claude-opus-5[1m]", ["gemini-3-pro"])).toBe("gemini-3-pro");
    expect(backendForClaudeAlias(mappings, "claude-opus-5", ["gemini-3-pro-preview"])).toBeUndefined();
  });

  it("retains original IDs and appends available aliases without duplicates", () => {
    const mappings = effectiveClaudeMappings([{ alias: "claude-opus-5", backend: "gemini-3-pro" }]);
    expect(mappedModelIds(mappings, ["gemini-3-pro", "claude-opus-5"])).toEqual([
      "gemini-3-pro", "claude-opus-5",
    ]);
    expect(mappedModelIds(mappings, ["gemini-3-pro", "gpt-4o"])).toEqual([
      "gemini-3-pro", "gpt-4o", "claude-opus-5",
    ]);
  });

  it("provides display labels and management status without changing IDs", () => {
    const mappings = effectiveClaudeMappings([
      { alias: "claude-opus-5", backend: "gemini-3-pro" },
      { alias: "claude-sonnet-5", disabled: true },
    ]);
    expect(modelMapDisplay(mappings, "claude-opus-5", ["gemini-3-pro"])).toBe("claude-opus-5 → gemini-3-pro");
    expect(modelMapDisplay(mappings, "gemini-3-pro", ["gemini-3-pro"])).toBe("gemini-3-pro");
    expect(claudeMappingRows(mappings, ["gemini-3-pro"])).toEqual(expect.arrayContaining([
      { alias: "claude-opus-5", backend: "gemini-3-pro", source: "user", status: "available", hasOverride: true },
      { alias: "claude-sonnet-5", source: "user", status: "disabled", hasOverride: true },
      { alias: "claude-opus-4-8", backend: "gpt-5.6-luna", source: "builtin", status: "unavailable", hasOverride: false },
    ]));
  });
});

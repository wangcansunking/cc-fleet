import { describe, expect, it } from "vitest";
import {
  CLAUDE_MODEL_MAP,
  availableClaudeMappings,
  backendForClaudeAlias,
  mappedModelIds,
  modelMapDisplay,
} from "../../src/core/claude-model-map.js";

describe("Claude model compatibility map", () => {
  it("defines the approved five preset mappings", () => {
    expect(CLAUDE_MODEL_MAP).toEqual([
      { alias: "claude-haiku-4-5", backend: "gpt-5.4" },
      { alias: "claude-sonnet-4-6", backend: "gpt-5.5" },
      { alias: "claude-opus-4-8", backend: "gpt-5.6-luna" },
      { alias: "claude-opus-5", backend: "gpt-5.6-sol" },
      { alias: "claude-sonnet-5", backend: "gpt-5.6-terra" },
    ]);
  });

  it("publishes only aliases whose exact GPT backend is live", () => {
    expect(availableClaudeMappings(["gpt-5.4", "gpt-5.6-sol", "gpt-4o"])).toEqual([
      { alias: "claude-haiku-4-5", backend: "gpt-5.4" },
      { alias: "claude-opus-5", backend: "gpt-5.6-sol" },
    ]);
  });

  it("resolves canonical and [1m] aliases only when their backend is live", () => {
    const live = ["gpt-5.6-sol"];
    expect(backendForClaudeAlias("claude-opus-5", live)).toBe("gpt-5.6-sol");
    expect(backendForClaudeAlias("claude-opus-5[1m]", live)).toBe("gpt-5.6-sol");
    expect(backendForClaudeAlias("claude-sonnet-5[1m]", live)).toBeUndefined();
  });

  it("retains original GPT ids and appends available aliases without duplicates", () => {
    expect(mappedModelIds(["gpt-5.6-sol", "gpt-4o", "claude-opus-5"])).toEqual([
      "gpt-5.6-sol", "gpt-4o", "claude-opus-5",
    ]);
    expect(mappedModelIds(["gpt-5.6-sol", "gpt-4o"])).toEqual([
      "gpt-5.6-sol", "gpt-4o", "claude-opus-5",
    ]);
  });

  it("provides an arrow label without changing the model id", () => {
    expect(modelMapDisplay("claude-opus-5", ["gpt-5.6-sol"])).toBe("claude-opus-5 → gpt-5.6-sol");
    expect(modelMapDisplay("gpt-5.6-sol", ["gpt-5.6-sol"])).toBe("gpt-5.6-sol");
  });
});

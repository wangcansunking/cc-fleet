import { describe, it, expect } from "vitest";
import { modelLabel } from "../../src/tui/screens/model.js";

describe("modelLabel", () => {
  it("appends a formatted context window when known", () => {
    expect(modelLabel("claude-opus-4.8", "", { "claude-opus-4.8": 1_000_000 })).toBe("claude-opus-4.8  · 1M");
    expect(modelLabel("gpt-4o", "", { "gpt-4o": 128_000 })).toBe("gpt-4o  · 128K");
  });
  it("marks the current model", () => {
    expect(modelLabel("gpt-4o", "gpt-4o")).toBe("gpt-4o  (current)");
  });
  it("combines window and current marker", () => {
    expect(modelLabel("gpt-4o", "gpt-4o", { "gpt-4o": 128_000 })).toBe("gpt-4o  · 128K  (current)");
  });
  it("omits the window when unknown", () => {
    expect(modelLabel("mystery", "")).toBe("mystery");
  });
  it("can show a diagnostic Claude-to-GPT label without changing the selected id", () => {
    expect(modelLabel("claude-opus-5", "", { "claude-opus-5": 1_100_000 }, "claude-opus-5 → gpt-5.6-sol"))
      .toBe("claude-opus-5 → gpt-5.6-sol  · 1.1M");
  });
});

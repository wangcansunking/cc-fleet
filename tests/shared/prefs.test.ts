import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readChatModel, writeChatModel, shouldShowChange, markChangeShown, readClaudeMapEnabled, writeClaudeMapEnabled } from "../../src/shared/prefs.js";

describe("prefs", () => {
  it("round-trips the chat model", () => {
    const d = mkdtempSync(join(tmpdir(), "m-"));
    expect(readChatModel(d)).toBeNull();
    writeChatModel(d, "gpt-4o");
    expect(readChatModel(d)).toBe("gpt-4o");
  });
  it("preserves other prefs keys on write", () => {
    const d = mkdtempSync(join(tmpdir(), "m-"));
    writeFileSync(join(d, "prefs.json"), JSON.stringify({ other: 1 }));
    writeChatModel(d, "claude-sonnet-4");
    const raw = JSON.parse(readFileSync(join(d, "prefs.json"), "utf8"));
    expect(raw.other).toBe(1);
    expect(raw.chatModel).toBe("claude-sonnet-4");
  });
  it("change banner shows maxShows times then stops, per id", () => {
    const d = mkdtempSync(join(tmpdir(), "m-"));
    expect(shouldShowChange(d, "v1", 3)).toBe(true);
    for (let i = 0; i < 3; i++) markChangeShown(d, "v1");
    expect(shouldShowChange(d, "v1", 3)).toBe(false); // suppressed after 3
    expect(shouldShowChange(d, "v2", 3)).toBe(true);  // new id re-announces
  });

  it("defaults the Claude compatibility map off and round-trips an explicit toggle", () => {
    const d = mkdtempSync(join(tmpdir(), "m-"));
    expect(readClaudeMapEnabled(d)).toBe(false);
    writeClaudeMapEnabled(d, true);
    expect(readClaudeMapEnabled(d)).toBe(true);
    writeClaudeMapEnabled(d, false);
    expect(readClaudeMapEnabled(d)).toBe(false);
  });

  it("fails closed for corrupt/non-boolean map preferences and preserves other prefs", () => {
    const d = mkdtempSync(join(tmpdir(), "m-"));
    writeFileSync(join(d, "prefs.json"), JSON.stringify({ chatModel: "gpt-5.6-sol", claudeMapEnabled: "yes", other: 1 }));
    expect(readClaudeMapEnabled(d)).toBe(false);
    writeClaudeMapEnabled(d, true);
    const raw = JSON.parse(readFileSync(join(d, "prefs.json"), "utf8"));
    expect(raw).toMatchObject({ chatModel: "gpt-5.6-sol", claudeMapEnabled: true, other: 1 });

    writeFileSync(join(d, "prefs.json"), "{bad");
    expect(readClaudeMapEnabled(d)).toBe(false);
  });
});

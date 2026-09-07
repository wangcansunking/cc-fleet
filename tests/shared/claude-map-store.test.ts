import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClaudeMapStoreError,
  readClaudeMapConfig,
  removeClaudeMapEntry,
  replaceClaudeMapConfig,
  resetClaudeMapEntries,
  setClaudeMapEnabled,
  upsertClaudeMapEntry,
} from "../../src/shared/claude-map-store.js";

const dir = () => mkdtempSync(join(tmpdir(), "cc-claude-map-"));
const path = (d: string) => join(d, "claude-map.json");

describe("Claude map store", () => {
  it("uses built-ins and the legacy enabled preference while the new file is absent", () => {
    const d = dir();
    writeFileSync(join(d, "prefs.json"), JSON.stringify({ claudeMapEnabled: true }));
    const state = readClaudeMapConfig(d);
    expect(state).toMatchObject({ enabled: true, entries: [], warning: null, source: "legacy" });
    expect(state.effectiveMappings).toHaveLength(5);
    expect(readFileSync(join(d, "prefs.json"), "utf8")).toContain("claudeMapEnabled");
  });

  it("normalizes aliases, trims backends, sorts entries, and writes deterministic 0600 JSON", () => {
    const d = dir();
    replaceClaudeMapConfig(d, {
      enabled: true,
      entries: [
        { alias: " claude-zeta-6[1m] ", backend: " grok-code-fast-2 " },
        { alias: "claude-alpha-6-1", disabled: true },
      ],
    });
    const raw = JSON.parse(readFileSync(path(d), "utf8"));
    expect(raw).toEqual({
      version: 1,
      enabled: true,
      entries: [
        { alias: "claude-alpha-6-1", disabled: true },
        { alias: "claude-zeta-6", backend: "grok-code-fast-2" },
      ],
    });
    expect(readClaudeMapConfig(d)).toMatchObject({ enabled: true, entries: raw.entries, warning: null, source: "file" });
    if (process.platform !== "win32") expect(statSync(path(d)).mode & 0o777).toBe(0o600);
  });

  it.each([
    [{ alias: "gpt-opus-6", backend: "gpt-5" }, /claude-/i],
    [{ alias: "claude-Opus-6", backend: "gpt-5" }, /alias/i],
    [{ alias: "claude-opus", backend: "gpt-5" }, /alias/i],
    [{ alias: "claude-opus-6", backend: "" }, /backend/i],
    [{ alias: "claude-opus-6", backend: "bad model" }, /backend/i],
    [{ alias: "claude-opus-6", backend: "claude-opus-6" }, /differ/i],
  ])("rejects invalid entry %j without writing", (entry, pattern) => {
    const d = dir();
    expect(() => replaceClaudeMapConfig(d, { enabled: true, entries: [entry as any] })).toThrow(pattern);
    expect(() => readFileSync(path(d), "utf8")).toThrow();
  });

  it("rejects duplicate aliases after normalization as one document", () => {
    const d = dir();
    expect(() => replaceClaudeMapConfig(d, {
      enabled: true,
      entries: [
        { alias: "claude-opus-6", backend: "gpt-5" },
        { alias: " claude-opus-6[1m] ", disabled: true },
      ],
    })).toThrow(/duplicate/i);
  });

  it("refuses to replace a malformed existing store automatically", () => {
    const d = dir();
    writeFileSync(path(d), "{bad");
    expect(() => replaceClaudeMapConfig(d, { enabled: true, entries: [] })).toThrow(/invalid JSON/i);
    expect(readFileSync(path(d), "utf8")).toBe("{bad");
  });

  it("supports toggle, upsert, disable, remove fallback, and reset without touching legacy prefs", () => {
    const d = dir();
    writeFileSync(join(d, "prefs.json"), JSON.stringify({ claudeMapEnabled: true, other: 1 }));
    setClaudeMapEnabled(d, false);
    upsertClaudeMapEntry(d, { alias: "claude-opus-5", backend: "gemini-3-pro" });
    upsertClaudeMapEntry(d, { alias: "claude-fable-6-1", backend: "grok-code-fast-2" });
    upsertClaudeMapEntry(d, { alias: "claude-haiku-4-5", disabled: true });
    let state = readClaudeMapConfig(d);
    expect(state.enabled).toBe(false);
    expect(state.entries).toHaveLength(3);
    expect(state.effectiveMappings.find((x) => x.alias === "claude-opus-5")?.backend).toBe("gemini-3-pro");

    removeClaudeMapEntry(d, "claude-opus-5[1m]");
    state = readClaudeMapConfig(d);
    expect(state.effectiveMappings.find((x) => x.alias === "claude-opus-5")?.backend).toBe("gpt-5.6-sol");
    expect(() => removeClaudeMapEntry(d, "claude-opus-5")).toThrowError(ClaudeMapStoreError);

    resetClaudeMapEntries(d);
    state = readClaudeMapConfig(d);
    expect(state.enabled).toBe(false);
    expect(state.entries).toEqual([]);
    expect(state.effectiveMappings).toHaveLength(5);
    expect(JSON.parse(readFileSync(join(d, "prefs.json"), "utf8"))).toEqual({ claudeMapEnabled: true, other: 1 });
  });

  it.each([
    ["{bad", /invalid JSON/i],
    [JSON.stringify({ version: 99, enabled: true, entries: [] }), /version/i],
    [JSON.stringify({ version: 1, enabled: true, entries: [{ alias: "claude-opus-6", backend: "gpt-5" }, { alias: "claude-opus-6[1m]", disabled: true }] }), /duplicate/i],
  ])("fails closed for a corrupt whole store and preserves its built-ins for management", (contents, warning) => {
    const d = dir();
    writeFileSync(join(d, "prefs.json"), JSON.stringify({ claudeMapEnabled: true }));
    writeFileSync(path(d), contents);
    const state = readClaudeMapConfig(d);
    expect(state.enabled).toBe(false);
    expect(state.entries).toEqual([]);
    expect(state.effectiveMappings).toHaveLength(5);
    expect(state.warning).toMatch(warning);
    expect(state.source).toBe("invalid");
  });
});

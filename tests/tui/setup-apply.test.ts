import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchCopilotModels, fetchModelLimits } from "../../src/providers/copilot/models.js";
import { applyClaude, applyCodex, resetClaude, resetCodex, codexPath, CLAUDE_ENV_KEYS, CODEX_ENV_KEYS } from "../../src/tui/setup/apply.js";
import { dataDir } from "../../src/shared/paths.js";
import { vi } from "vitest";

// Regression: codexPath used to re-join the data-dir literal by hand instead of calling dataDir().
// When the data dir was renamed, global codex.env kept being written to the OLD directory — silently,
// because nothing asserted the two agreed. Pin them together so they can never drift again.
describe("codexPath", () => {
  it("puts global codex.env inside the one true data dir", () => {
    const home = mkdtempSync(join(tmpdir(), "cr-"));
    expect(codexPath("global", { home })).toBe(join(dataDir(home), "codex.env"));
  });
  it("keeps project scope on the local .env, not the data dir", () => {
    const home = mkdtempSync(join(tmpdir(), "cr-"));
    const cwd = mkdtempSync(join(tmpdir(), "cr-p-"));
    expect(codexPath("project", { home, cwd })).toBe(join(cwd, ".env"));
  });
});

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

describe("fetchCopilotModels", () => {
  it("returns ids from the live list", async () => {
    const f = vi.fn(async () => json({ data: [{ id: "gpt-4o" }, { id: "claude-opus-4-8" }] }));
    expect(await fetchCopilotModels("cop", f as unknown as typeof fetch)).toEqual(["gpt-4o", "claude-opus-4-8"]);
  });
  it("falls back when endpoint fails", async () => {
    const f = vi.fn(async () => json({}, 500));
    const out = await fetchCopilotModels("cop", f as unknown as typeof fetch);
    expect(out).toContain("gpt-4o");
    expect(out.length).toBeGreaterThan(1);
  });
  it("falls back (does not hang) when the endpoint stalls past the timeout", async () => {
    // a fetch that only rejects when its AbortSignal fires — i.e. never resolves on its own
    const hanging = ((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch;
    const out = await fetchCopilotModels("cop", hanging, 20);
    expect(out).toContain("gpt-4o");
  });
});

describe("fetchModelLimits", () => {
  it("maps model id -> context window (prefers the headline window, e.g. 1M)", async () => {
    const f = vi.fn(async () => json({ data: [
      { id: "gpt-4o", capabilities: { limits: { max_prompt_tokens: 128000 } } },
      { id: "claude-opus-4-8", capabilities: { limits: { max_context_window_tokens: 200000 } } },
      { id: "claude-opus-4.8", capabilities: { limits: { max_prompt_tokens: 936000, max_context_window_tokens: 1000000 } } },
    ] }));
    const map = await fetchModelLimits("cop", f as unknown as typeof fetch);
    expect(map["gpt-4o"]).toBe(128000);          // falls back to prompt tokens when no ctx window
    expect(map["claude-opus-4-8"]).toBe(200000);
    expect(map["claude-opus-4.8"]).toBe(1000000); // headline 1M window, not the 936K prompt budget
  });
  it("returns an empty map when the endpoint fails", async () => {
    const f = vi.fn(async () => json({}, 500));
    expect(await fetchModelLimits("cop", f as unknown as typeof fetch)).toEqual({});
  });
});

describe("applyClaude", () => {
  it("creates settings.json with merged env (project scope)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "proj-"));
    const r = applyClaude("project", { ANTHROPIC_BASE_URL: "http://x", ANTHROPIC_API_KEY: "k" }, { cwd });
    expect(r.path).toBe(join(cwd, ".claude", "settings.json"));
    expect(r.changed).toEqual(["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY"]);
    const s = JSON.parse(readFileSync(r.path, "utf8"));
    expect(s.env.ANTHROPIC_BASE_URL).toBe("http://x");
  });
  it("merges non-destructively into existing settings", () => {
    const cwd = mkdtempSync(join(tmpdir(), "proj-"));
    mkdirSync(join(cwd, ".claude"));
    writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify({ theme: "dark", env: { KEEP: "1" } }));
    const r = applyClaude("project", { ANTHROPIC_BASE_URL: "http://x" }, { cwd });
    const s = JSON.parse(readFileSync(r.path, "utf8"));
    expect(s.theme).toBe("dark");       // preserved
    expect(s.env.KEEP).toBe("1");        // preserved
    expect(s.env.ANTHROPIC_BASE_URL).toBe("http://x"); // added
    expect(r.changed).toEqual(["ANTHROPIC_BASE_URL"]);
  });
  it("strips a conflicting ANTHROPIC_AUTH_TOKEN so Claude Code stops warning 'both set'", () => {
    const cwd = mkdtempSync(join(tmpdir(), "proj-"));
    mkdirSync(join(cwd, ".claude"));
    writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "stale", KEEP: "1" } }));
    const r = applyClaude("project", { ANTHROPIC_API_KEY: "k" }, { cwd });
    const s = JSON.parse(readFileSync(r.path, "utf8"));
    expect(s.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined(); // removed
    expect(s.env.ANTHROPIC_API_KEY).toBe("k");
    expect(s.env.KEEP).toBe("1");                        // unrelated keys preserved
  });
});

describe("applyCodex", () => {
  it("writes/merges .env line-wise without clobbering other lines", () => {
    const cwd = mkdtempSync(join(tmpdir(), "proj-"));
    writeFileSync(join(cwd, ".env"), "EXISTING=1\nOPENAI_BASE_URL=old\n");
    const r = applyCodex("project", { OPENAI_BASE_URL: "http://x/v1", OPENAI_API_KEY: "k" }, { cwd });
    const txt = readFileSync(join(cwd, ".env"), "utf8");
    expect(txt).toContain("EXISTING=1");          // preserved
    expect(txt).toContain("OPENAI_BASE_URL=http://x/v1"); // replaced
    expect(txt).toContain("OPENAI_API_KEY=k");     // added
    expect(r.changed).toContain("OPENAI_BASE_URL");
    expect(r.changed).toContain("OPENAI_API_KEY");
  });
});

describe("resetClaude", () => {
  it("removes copilot-reverse's env keys but preserves other settings and env keys", () => {
    const cwd = mkdtempSync(join(tmpdir(), "proj-"));
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    const copilotReverseEnv = Object.fromEntries(CLAUDE_ENV_KEYS.map((k) => [k, "x"]));
    writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify({ theme: "dark", env: { KEEP: "1", ...copilotReverseEnv } }));
    const r = resetClaude("project", CLAUDE_ENV_KEYS, { cwd });
    const s = JSON.parse(readFileSync(r.path, "utf8"));
    expect(s.theme).toBe("dark");                 // preserved
    expect(s.env.KEEP).toBe("1");                 // preserved
    expect(s.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(s.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
    expect(r.changed.sort()).toEqual([...CLAUDE_ENV_KEYS].sort());
  });
  it("is a no-op when settings.json does not exist", () => {
    const cwd = mkdtempSync(join(tmpdir(), "proj-"));
    const r = resetClaude("project", CLAUDE_ENV_KEYS, { cwd });
    expect(r.changed).toEqual([]);
  });
});

describe("resetCodex", () => {
  it("removes copilot-reverse's env lines but preserves other lines", () => {
    const cwd = mkdtempSync(join(tmpdir(), "proj-"));
    writeFileSync(join(cwd, ".env"), "EXISTING=1\nOPENAI_BASE_URL=http://x/v1\nOPENAI_API_KEY=k\nOPENAI_MODEL=gpt-4o\n");
    const r = resetCodex("project", CODEX_ENV_KEYS, { cwd });
    const txt = readFileSync(join(cwd, ".env"), "utf8");
    expect(txt).toContain("EXISTING=1");          // preserved
    expect(txt).not.toContain("OPENAI_BASE_URL");
    expect(txt).not.toContain("OPENAI_API_KEY");
    expect(r.changed.sort()).toEqual([...CODEX_ENV_KEYS].sort());
  });
});

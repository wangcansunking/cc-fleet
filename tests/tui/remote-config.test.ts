import { describe, it, expect } from "vitest";
import { remoteClaudeBlock, remoteCodexBlock, remoteConfigBlocks } from "../../src/tui/setup/remote-config.js";

// The LAN URL + key a user would see after switching /network to LAN.
const lanUrl = "http://172.22.80.1:7991";
const key = "ajEz8atdL9qk2Eo9FXQnq4eZRbB7y1ZhFS0BjsY77b8";

describe("remoteClaudeBlock", () => {
  it("renders a settings.json block with the LAN base URL and the key in ANTHROPIC_API_KEY", () => {
    const b = remoteClaudeBlock({ lanUrl, key, claudeModel: "claude-opus-4-8[1m]" });
    expect(b.client).toBe("claude");
    expect(b.path).toMatch(/settings\.json$/);
    const text = b.lines.join("\n");
    // Valid JSON that a user can paste verbatim.
    const parsed = JSON.parse(text);
    expect(parsed.env.ANTHROPIC_BASE_URL).toBe("http://172.22.80.1:7991/anthropic");
    expect(parsed.env.ANTHROPIC_API_KEY).toBe(key);          // key in the AUTH slot, not the URL
    expect(parsed.env.ANTHROPIC_MODEL).toBe("claude-opus-4-8[1m]");
  });

  it("canonicalizes a dotted/dashed claude model to the [1m] picker id (matches local setup)", () => {
    const b = remoteClaudeBlock({ lanUrl, key, claudeModel: "claude-opus-4.8" });
    expect(JSON.parse(b.lines.join("\n")).env.ANTHROPIC_MODEL).toBe("claude-opus-4-8[1m]");
  });

  it("falls back to a sensible default model when none is configured", () => {
    const b = remoteClaudeBlock({ lanUrl, key });
    expect(JSON.parse(b.lines.join("\n")).env.ANTHROPIC_MODEL).toBe("claude-opus-4-8[1m]");
  });

  it("never leaks the key into a base-url line", () => {
    const b = remoteClaudeBlock({ lanUrl, key });
    const urlLine = b.lines.find((l) => l.includes("ANTHROPIC_BASE_URL"));
    expect(urlLine).toBeDefined();
    expect(urlLine).not.toContain(key);
  });

  it("includes CLAUDE_CODE_AUTO_COMPACT_WINDOW when the context window is known (matches local setup)", () => {
    const b = remoteClaudeBlock({ lanUrl, key, claudeModel: "claude-opus-4-8[1m]", claudeContextWindow: 1_000_000 });
    expect(JSON.parse(b.lines.join("\n")).env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("1000000");
  });

  it("omits the auto-compact window when unknown (same as a local run before limits load)", () => {
    const b = remoteClaudeBlock({ lanUrl, key, claudeModel: "claude-opus-4-8[1m]" });
    expect(JSON.parse(b.lines.join("\n")).env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
  });
});

describe("remoteCodexBlock", () => {
  it("renders a config.toml provider block with the key in experimental_bearer_token", () => {
    const b = remoteCodexBlock({ lanUrl, key, codexModel: "gpt-5.5" });
    expect(b.client).toBe("codex");
    expect(b.path).toMatch(/config\.toml$/);
    const text = b.lines.join("\n");
    expect(text).toContain('base_url = "http://172.22.80.1:7991/openai"');
    expect(text).toContain('experimental_bearer_token = "' + key + '"');
    expect(text).toContain('wire_api = "responses"');
    expect(text).toContain('requires_openai_auth = false');
    expect(text).toContain('model = "gpt-5.5"');
    expect(text).toContain("[model_providers.copilot-reverse]");
  });

  it("falls back to a sensible default model when none is configured", () => {
    const b = remoteCodexBlock({ lanUrl, key });
    expect(b.lines.join("\n")).toContain('model = "gpt-5.5"');
  });

  it("never leaks the key into the base_url line", () => {
    const b = remoteCodexBlock({ lanUrl, key });
    const urlLine = b.lines.find((l) => l.includes("base_url"));
    expect(urlLine).toBeDefined();
    expect(urlLine).not.toContain(key);
  });

  it("includes model_context_window when the window is known (matches local applyCodexToml)", () => {
    const b = remoteCodexBlock({ lanUrl, key, codexModel: "gpt-5.5", codexContextWindow: 272_000 });
    expect(b.lines.join("\n")).toContain("model_context_window = 272000");
  });

  it("omits model_context_window when unknown", () => {
    const b = remoteCodexBlock({ lanUrl, key, codexModel: "gpt-5.5" });
    expect(b.lines.join("\n")).not.toContain("model_context_window");
  });
});

describe("remoteConfigBlocks", () => {
  it("returns both clients, claude first then codex", () => {
    const blocks = remoteConfigBlocks({ lanUrl, key, claudeModel: "claude-opus-4-8[1m]", codexModel: "gpt-5.5" });
    expect(blocks.map((b) => b.client)).toEqual(["claude", "codex"]);
  });
});

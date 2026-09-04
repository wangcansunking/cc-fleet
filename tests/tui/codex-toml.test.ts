import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCodexToml, codexTomlPath } from "../../src/tui/setup/codex-toml.js";

const tmp = () => mkdtempSync(join(tmpdir(), "codex-"));

describe("applyCodexToml", () => {
  it("writes a fresh config.toml with model, provider, and context window", () => {
    const home = tmp();
    const r = applyCodexToml({ home, baseUrl: "http://127.0.0.1:7991/v1", model: "gpt-5.5", contextWindow: 1_050_000 });
    expect(r.path).toBe(codexTomlPath(home));
    const toml = readFileSync(r.path, "utf8");
    expect(toml).toContain('model = "gpt-5.5"');
    expect(toml).toContain('model_provider = "copilot-reverse"');
    expect(toml).toContain("model_context_window = 1050000");
    expect(toml).toContain("[model_providers.copilot-reverse]");
    expect(toml).toContain('base_url = "http://127.0.0.1:7991/v1"');
    expect(toml).toContain('wire_api = "responses"');
    // Auth: a static bearer token inlined so Codex uses our local proxy instead of falling back to
    // the OpenAI login flow. The worker ignores the key value.
    expect(toml).toContain('requires_openai_auth = false');
    expect(toml).toContain('experimental_bearer_token = "copilot-reverse-local"');
  });

  it("places top-level keys BEFORE any table (TOML: a bare key after [table] belongs to that table)", () => {
    const home = tmp();
    mkdirSync(join(home, ".codex"), { recursive: true });
    // Pre-existing config that has tables (like a real ~/.codex/config.toml with [marketplaces] etc).
    writeFileSync(codexTomlPath(home), '[windows]\nsandbox = "unelevated"\n\n[tui.x]\na = 1\n');
    applyCodexToml({ home, baseUrl: "http://127.0.0.1:7991/openai", model: "gpt-5.5", contextWindow: 1_050_000 });
    const toml = readFileSync(codexTomlPath(home), "utf8");
    const lines = toml.split("\n");
    const providerLine = lines.findIndex((l) => /^model_provider\s*=/.test(l));
    const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
    // model_provider must be a TRUE top-level key — appear before the first [table], else Codex
    // parses it into that table and falls back to provider "openai".
    expect(providerLine).toBeGreaterThanOrEqual(0);
    expect(firstTable).toBeGreaterThanOrEqual(0);
    expect(providerLine).toBeLessThan(firstTable);
    // pre-existing table content is still preserved
    expect(toml).toContain('sandbox = "unelevated"');
  });

  it("de-duplicates managed keys left in the table region by a previous buggy write", () => {
    const home = tmp();
    mkdirSync(join(home, ".codex"), { recursive: true });
    // Simulate the old broken output: managed keys sitting AFTER a table (TOML-nested).
    writeFileSync(codexTomlPath(home), '[windows]\nsandbox = "x"\n\nmodel = "old"\nmodel_provider = "old-prov"\n');
    applyCodexToml({ home, baseUrl: "http://x/openai", model: "gpt-5.5" });
    const toml = readFileSync(codexTomlPath(home), "utf8");
    expect(toml.match(/^model_provider = /gm)?.length).toBe(1);   // exactly one, at the top
    expect(toml.match(/^model = /gm)?.length).toBe(1);
    expect(toml).not.toContain('"old-prov"');                      // stale value gone
  });

  it("preserves unrelated existing keys and is idempotent", () => {
    const home = tmp();
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(codexTomlPath(home), 'approval_policy = "on-request"\nmodel = "old-model"\n');
    applyCodexToml({ home, baseUrl: "http://127.0.0.1:7991/v1", model: "gpt-5.5", contextWindow: 1_050_000 });
    const once = readFileSync(codexTomlPath(home), "utf8");
    expect(once).toContain('approval_policy = "on-request"'); // unrelated key preserved
    expect(once).toContain('model = "gpt-5.5"');               // replaced, not duplicated
    expect(once.match(/^model = /gm)?.length).toBe(1);
    // running again yields the same file (idempotent)
    applyCodexToml({ home, baseUrl: "http://127.0.0.1:7991/v1", model: "gpt-5.5", contextWindow: 1_050_000 });
    expect(readFileSync(codexTomlPath(home), "utf8")).toBe(once);
  });

  it("omits the context window when unknown", () => {
    const home = tmp();
    applyCodexToml({ home, baseUrl: "http://x/v1", model: "gpt-4o" });
    expect(readFileSync(codexTomlPath(home), "utf8")).not.toContain("model_context_window");
  });
});

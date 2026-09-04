import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyClaude, applyCodex } from "../../src/tui/setup/apply.js";
import { readClientStatus } from "../../src/tui/setup/status.js";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

describe("readClientStatus", () => {
  it("reports per-scope (user/project) config presence + pinned model from the real files", () => {
    const home = tmp("home-"), cwd = tmp("proj-");
    expect(readClientStatus({ home, cwd }).claude).toMatchObject({ user: false, project: false });

    applyClaude("project", { ANTHROPIC_BASE_URL: "http://127.0.0.1:7991", ANTHROPIC_API_KEY: "k", ANTHROPIC_MODEL: "claude-opus-4.8[1m]" }, { home, cwd });
    expect(readClientStatus({ home, cwd }).claude).toMatchObject({ user: false, project: true, projectModel: "claude-opus-4.8[1m]" });

    applyCodex("global", { OPENAI_BASE_URL: "http://127.0.0.1:7991/v1", OPENAI_API_KEY: "k", OPENAI_MODEL: "gpt-5.4" }, { home, cwd });
    const s = readClientStatus({ home, cwd });
    expect(s.codex).toMatchObject({ user: true, project: false, userModel: "gpt-5.4" });
  });

  it("ignores a non-copilot-reverse base url (a user's own Anthropic endpoint)", () => {
    const home = tmp("home-"), cwd = tmp("proj-");
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" } }));
    expect(readClientStatus({ home, cwd }).claude.project).toBe(false);
  });
});

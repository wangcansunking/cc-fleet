import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyManagedClients, restoreManagedClients } from "../../src/control/agent/client-config.js";

const root = () => mkdtempSync(join(tmpdir(), "cc-client-config-"));
const desired = (key = "fleet-key", claude = "claude-opus-5[1m]", codex = "gpt-5.6-sol") => ({
  baseUrl: "https://fleet-7992.devtunnels.ms",
  apiKey: key,
  keyRevision: key === "fleet-key" ? 1 : 2,
  claude: { model: claude, contextWindow: 1_000_000 },
  codex: { model: codex, contextWindow: 1_000_000 },
});

describe("node managed Claude/Codex client config", () => {
  it("snapshots exact originals once and non-destructively configures both clients", () => {
    const home = root(), agents = root();
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ theme: "dark", env: { KEEP: "yes" } }));
    writeFileSync(join(home, ".codex", "config.toml"), "approval_policy = \"on-request\"\n[history]\npersistence = \"save-all\"\n");

    const result = applyManagedClients(agents, home, desired());
    expect(result.claude.status).toBe("changed");
    expect(result.codex.status).toBe("changed");
    expect(result.needsRestart).toBe(true);

    const claude = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    expect(claude.theme).toBe("dark");
    expect(claude.env.KEEP).toBe("yes");
    expect(claude.env.ANTHROPIC_BASE_URL).toBe("https://fleet-7992.devtunnels.ms/anthropic");
    expect(claude.env.ANTHROPIC_API_KEY).toBe("fleet-key");
    const codex = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    expect(codex).toContain('approval_policy = "on-request"');
    expect(codex).toContain('base_url = "https://fleet-7992.devtunnels.ms/openai"');
    expect(codex).toContain('experimental_bearer_token = "fleet-key"');
  });

  it("records non-existence and restore removes only files that did not exist before", () => {
    const home = root(), agents = root();
    applyManagedClients(agents, home, desired());
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(true);
    expect(existsSync(join(home, ".codex", "config.toml"))).toBe(true);
    const restored = restoreManagedClients(agents, home);
    expect(restored.ok).toBe(true);
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
    expect(existsSync(join(home, ".codex", "config.toml"))).toBe(false);
  });

  it("restore reproduces exact original bytes after key and model rotations", () => {
    const home = root(), agents = root();
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(join(home, ".codex"), { recursive: true });
    const c1 = "{\n  \"custom\": true\n}\n";
    const c2 = "model = \"original\"\n[custom]\nkeep = true\n";
    writeFileSync(join(home, ".claude", "settings.json"), c1);
    writeFileSync(join(home, ".codex", "config.toml"), c2);
    applyManagedClients(agents, home, desired());
    applyManagedClients(agents, home, desired("new-key", "claude-sonnet-5[1m]", "gpt-5.6-terra"));
    restoreManagedClients(agents, home);
    expect(readFileSync(join(home, ".claude", "settings.json"), "utf8")).toBe(c1);
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toBe(c2);
  });

  it("reports unchanged on an identical repeat and changed on key/model rotation", () => {
    const home = root(), agents = root();
    expect(applyManagedClients(agents, home, desired()).needsRestart).toBe(true);
    const same = applyManagedClients(agents, home, desired());
    expect(same.claude.status).toBe("unchanged");
    expect(same.codex.status).toBe("unchanged");
    expect(same.needsRestart).toBe(false);
    const rotated = applyManagedClients(agents, home, desired("new-key", "claude-sonnet-5[1m]", "gpt-5.6-terra"));
    expect(rotated.claude.status).toBe("changed");
    expect(rotated.codex.status).toBe("changed");
    expect(rotated.keyRevision).toBe(2);
  });

  it("returns explicit per-client errors instead of claiming success", () => {
    const home = root(), agents = root();
    writeFileSync(join(home, ".claude"), "not a directory");
    const result = applyManagedClients(agents, home, desired());
    expect(result.claude.status).toBe("error");
    expect(result.claude.error).toBeTruthy();
    expect(result.codex.status).toBe("changed");
  });
});

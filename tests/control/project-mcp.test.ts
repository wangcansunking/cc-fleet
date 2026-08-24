import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { project } from "../../src/control/agent/project.js";
import { fleetDir, localDir, manifestPath } from "../../src/control/agent/store.js";
import type { McpRunner } from "../../src/control/agent/mcp.js";

const dirs = () => ({ agents: mkdtempSync(join(tmpdir(), "agents-")), claude: mkdtempSync(join(tmpdir(), "claude-")) });

function putMcp(root: string, id: string, config: unknown) {
  mkdirSync(join(root, "mcp"), { recursive: true });
  writeFileSync(join(root, "mcp", `${id}.json`), typeof config === "string" ? config : JSON.stringify(config));
}
function fakeClaude(available = true) {
  const calls: string[][] = [];
  const runner: McpRunner = { available: () => available, run: (a) => { calls.push(a); return { ok: true, stdout: "", stderr: "" }; } };
  return { runner, calls };
}
const manifest = (agents: string) => JSON.parse(readFileSync(manifestPath(agents), "utf8"));

describe("projection — MCP", () => {
  it("adds a fleet MCP server through the claude CLI and records it", () => {
    const { agents, claude } = dirs();
    putMcp(fleetDir(agents), "sentry", { type: "http", url: "https://s" });
    const { runner, calls } = fakeClaude();
    const r = project(agents, claude, { mcpRunner: runner });
    expect(r.mcp.added).toEqual(["sentry"]);
    expect(calls.some((c) => c[1] === "add-json" && c[2] === "sentry")).toBe(true);
    // Recorded, because the manifest is the ONLY way a later run can know this one is ours to remove.
    expect(manifest(agents).mcpServers).toEqual(["sentry"]);
  });

  it("lets a local MCP config override the fleet one of the same id", () => {
    const { agents, claude } = dirs();
    putMcp(fleetDir(agents), "db", { url: "fleet" });
    putMcp(localDir(agents), "db", { url: "local" });
    const { runner, calls } = fakeClaude();
    project(agents, claude, { mcpRunner: runner });
    const add = calls.find((c) => c[1] === "add-json")!;
    expect(JSON.parse(add[3])).toEqual({ url: "local" });
  });

  it("removes a server once the profile stops declaring it", () => {
    const { agents, claude } = dirs();
    putMcp(fleetDir(agents), "temp", { url: "x" });
    const first = fakeClaude();
    project(agents, claude, { mcpRunner: first.runner });

    mkdirSync(join(fleetDir(agents), "mcp"), { recursive: true });
    require("node:fs").rmSync(join(fleetDir(agents), "mcp", "temp.json"));
    const second = fakeClaude();
    const r = project(agents, claude, { mcpRunner: second.runner });
    expect(r.mcp.removed).toEqual(["temp"]);
    expect(manifest(agents).mcpServers).toEqual([]);
  });

  it("skips MCP entirely when the claude CLI is missing, and says so", () => {
    // A machine without the CLI silently having no MCP is exactly the kind of fleet-wide
    // inconsistency this tool exists to prevent, so it is reported rather than tolerated quietly.
    const { agents, claude } = dirs();
    putMcp(fleetDir(agents), "sentry", { url: "x" });
    const { runner, calls } = fakeClaude(false);
    const r = project(agents, claude, { mcpRunner: runner });
    expect(r.mcp.skipped).toBe(true);
    expect(r.mcp.added).toEqual([]);
    expect(r.mcp.warnings.join(" ")).toMatch(/claude CLI not found/);
    expect(calls).toEqual([]);
  });

  it("reports an unparseable config instead of failing the whole projection", () => {
    const { agents, claude } = dirs();
    putMcp(fleetDir(agents), "broken", "{ not json");
    mkdirSync(join(fleetDir(agents), "skills", "s"), { recursive: true });
    writeFileSync(join(fleetDir(agents), "skills", "s", "SKILL.md"), "x");
    const { runner } = fakeClaude();
    const r = project(agents, claude, { mcpRunner: runner });
    expect(r.mcp.warnings.join(" ")).toMatch(/not valid JSON/);
    expect(r.written).toContain("skills/s/SKILL.md"); // the rest still projected
  });

  it("does not touch a server it never added", () => {
    const { agents, claude } = dirs();
    const { runner, calls } = fakeClaude();
    project(agents, claude, { mcpRunner: runner });
    expect(calls.filter((c) => c[1] === "remove")).toEqual([]);
  });
});

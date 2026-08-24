import { describe, it, expect, vi } from "vitest";
import { syncMcpServers, type McpRunner, type CommandResult } from "../../src/control/agent/mcp.js";

const okResult: CommandResult = { ok: true, stdout: "", stderr: "" };
const failResult = (msg: string): CommandResult => ({ ok: false, stdout: "", stderr: msg });

/** Records every invocation so tests can assert on the exact CLI contract, not just the outcome. */
function fakeClaude(opts: { available?: boolean; fail?: (args: string[]) => string | null } = {}) {
  const calls: string[][] = [];
  const runner: McpRunner = {
    available: () => opts.available !== false,
    run: (args) => {
      calls.push(args);
      const failure = opts.fail?.(args);
      return failure ? failResult(failure) : okResult;
    },
  };
  return { runner, calls };
}
const desired = (entries: Record<string, Record<string, unknown>>) => new Map(Object.entries(entries));

describe("MCP sync — the CLI contract", () => {
  it("adds a server through `claude mcp add-json --scope user`", () => {
    const { runner, calls } = fakeClaude();
    const r = syncMcpServers({ desired: desired({ sentry: { type: "http", url: "https://x" } }), previouslyAdded: [] }, runner);
    expect(r.added).toEqual(["sentry"]);
    expect(calls).toContainEqual(["mcp", "add-json", "sentry", JSON.stringify({ type: "http", url: "https://x" }), "--scope", "user"]);
  });

  it("never touches ~/.claude.json itself", () => {
    // The whole design of this module. That file holds the user's OAuth session; a bug in our JSON
    // handling would cost them their login. Only Claude Code may write it.
    const { runner, calls } = fakeClaude();
    syncMcpServers({ desired: desired({ a: { type: "stdio", command: "x" } }), previouslyAdded: [] }, runner);
    expect(calls.every((c) => c[0] === "mcp" || c[0] === "--version")).toBe(true);
  });

  it("removes a server it previously added once the profile drops it", () => {
    const { runner, calls } = fakeClaude();
    const r = syncMcpServers({ desired: desired({}), previouslyAdded: ["gone"] }, runner);
    expect(r.removed).toEqual(["gone"]);
    expect(calls).toContainEqual(["mcp", "remove", "gone", "--scope", "user"]);
  });

  it("leaves a server the user configured by hand completely alone", () => {
    // We cannot read ~/.claude.json, so the manifest is the ONLY thing distinguishing ours from
    // theirs. Anything not in it is not ours to delete.
    const { runner, calls } = fakeClaude();
    syncMcpServers({ desired: desired({}), previouslyAdded: [] }, runner);
    expect(calls.filter((c) => c[1] === "remove")).toEqual([]);
  });

  it("replaces a changed config rather than colliding with the existing entry", () => {
    const { runner, calls } = fakeClaude();
    syncMcpServers({ desired: desired({ sentry: { url: "https://new" } }), previouslyAdded: ["sentry"] }, runner);
    const ops = calls.filter((c) => c[0] === "mcp").map((c) => c[1]);
    expect(ops).toEqual(["remove", "add-json"]); // remove-then-add, in that order
  });

  it("is stable across repeated runs with no change", () => {
    const { runner } = fakeClaude();
    const input = { desired: desired({ a: { x: 1 } }), previouslyAdded: ["a"] };
    expect(syncMcpServers(input, runner).managed).toEqual(["a"]);
    expect(syncMcpServers(input, runner).managed).toEqual(["a"]);
  });
});

describe("MCP sync — when claude is not installed", () => {
  it("skips rather than failing, and says so", () => {
    // Reported as a skip, never as success: a green tick would tell the operator the fleet is
    // consistent when this machine silently has no MCP at all.
    const { runner, calls } = fakeClaude({ available: false });
    const r = syncMcpServers({ desired: desired({ a: {} }), previouslyAdded: [] }, runner);
    expect(r.skipped).toBe(true);
    expect(r.added).toEqual([]);
    expect(r.warnings.join(" ")).toMatch(/claude CLI not found/);
    expect(calls).toEqual([]);
  });

  it("preserves what it believed it managed, so a later run can still clean up", () => {
    const { runner } = fakeClaude({ available: false });
    const r = syncMcpServers({ desired: desired({}), previouslyAdded: ["a", "b"] }, runner);
    expect(r.managed).toEqual(["a", "b"]);
  });

  it("stays quiet when there is nothing to apply anyway", () => {
    const { runner } = fakeClaude({ available: false });
    expect(syncMcpServers({ desired: desired({}), previouslyAdded: [] }, runner).warnings).toEqual([]);
  });
});

describe("MCP sync — failures", () => {
  it("reports a failed add and does NOT record it as managed", () => {
    // Recording a failed add would make every later run try to "remove" a server that never existed,
    // reporting a spurious failure forever.
    const { runner } = fakeClaude({ fail: (a) => (a[1] === "add-json" ? "boom" : null) });
    const r = syncMcpServers({ desired: desired({ bad: {} }), previouslyAdded: [] }, runner);
    expect(r.added).toEqual([]);
    expect(r.managed).toEqual([]);
    expect(r.warnings.join(" ")).toMatch(/could not add MCP server bad/);
  });

  it("keeps going after one server fails", () => {
    const { runner } = fakeClaude({ fail: (a) => (a[2] === "bad" && a[1] === "add-json" ? "boom" : null) });
    const r = syncMcpServers({ desired: desired({ bad: {}, good: {} }), previouslyAdded: [] }, runner);
    expect(r.added).toEqual(["good"]);
  });

  it("reports a failed remove without pretending it worked", () => {
    const { runner } = fakeClaude({ fail: (a) => (a[1] === "remove" ? "nope" : null) });
    const r = syncMcpServers({ desired: desired({}), previouslyAdded: ["stuck"] }, runner);
    expect(r.removed).toEqual([]);
    expect(r.warnings.join(" ")).toMatch(/could not remove MCP server stuck/);
  });

  it("truncates a noisy CLI error to one readable line", () => {
    const { runner } = fakeClaude({ fail: () => "line one\nline two\nline three" });
    const r = syncMcpServers({ desired: desired({ a: {} }), previouslyAdded: [] }, runner);
    expect(r.warnings[0]).toContain("line one");
    expect(r.warnings[0]).not.toContain("line two");
  });
});

import { spawnSync } from "node:child_process";

// MCP projection.
//
// The one rule that shapes this entire file: cc-fleet NEVER reads or writes ~/.claude.json.
//
// User-scope MCP servers live nowhere else (verified against Claude Code 2.1.220 — settings.json has
// no mcpServers key), and that same file holds the user's OAuth session, per-project state and
// caches. A read-modify-write against it would mean a bug in our JSON handling can cost someone
// their login. So we shell out to Claude Code's own CLI and let the file's owner mutate it.
//
// The price is a dependency: a node without the `claude` binary cannot receive MCP servers. That is
// reported as a skip — never as success — following the same policy design §10 already set for
// marketplaces.

export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}
export interface McpRunner {
  available(): boolean;
  run(args: string[], stdin?: string): CommandResult;
}

// Real runner: invokes the `claude` CLI. `shell: false` throughout — a server name or config that
// reached a shell would be an injection point, and these values come off the network.
export function claudeRunner(bin = process.env.CLAUDE_BIN ?? "claude"): McpRunner {
  const exec = (args: string[]): CommandResult => {
    const r = spawnSync(bin, args, { encoding: "utf8", shell: false, timeout: 60_000 });
    return {
      ok: !r.error && r.status === 0,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? (r.error ? String(r.error.message) : ""),
    };
  };
  return {
    available: () => exec(["--version"]).ok,
    run: exec,
  };
}

export interface McpSyncInput {
  /** id -> opaque config object, straight from the profile. */
  desired: Map<string, Record<string, unknown>>;
  /** Server ids cc-fleet added last time, from the manifest. */
  previouslyAdded: string[];
}
export interface McpSyncResult {
  added: string[];
  removed: string[];
  /** Ids now under cc-fleet's management — persist this, it is what makes removal safe. */
  managed: string[];
  warnings: string[];
  skipped: boolean;
}

export function syncMcpServers(input: McpSyncInput, runner: McpRunner): McpSyncResult {
  const desiredIds = [...input.desired.keys()].sort();

  if (!runner.available()) {
    // Report honestly and change nothing. A green tick here would tell the operator the fleet is
    // consistent when one machine silently has no MCP at all.
    return {
      added: [], removed: [], managed: input.previouslyAdded, skipped: true,
      warnings: desiredIds.length
        ? [`claude CLI not found — ${desiredIds.length} MCP server(s) not applied on this machine`]
        : [],
    };
  }

  const warnings: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];

  // Remove only what WE added. An MCP server the user configured by hand is not ours to delete —
  // full takeover applies to cc-fleet's own footprint here, not to the whole of Claude Code's config,
  // precisely because we cannot see that file to tell the difference any other way.
  for (const id of input.previouslyAdded) {
    if (input.desired.has(id)) continue;
    const r = runner.run(["mcp", "remove", id, "--scope", "user"]);
    if (r.ok) removed.push(id);
    else warnings.push(`could not remove MCP server ${id}: ${firstLine(r.stderr || r.stdout)}`);
  }

  // add-json is idempotent from our side: remove-then-add, so a changed config actually takes effect
  // rather than colliding with the existing entry.
  for (const id of desiredIds) {
    const config = JSON.stringify(input.desired.get(id));
    if (input.previouslyAdded.includes(id)) runner.run(["mcp", "remove", id, "--scope", "user"]);
    const r = runner.run(["mcp", "add-json", id, config, "--scope", "user"]);
    if (r.ok) added.push(id);
    else warnings.push(`could not add MCP server ${id}: ${firstLine(r.stderr || r.stdout)}`);
  }

  // Managed = what we successfully put there. A failed add must NOT be recorded, or the next run
  // would try to "remove" a server that was never created and report a spurious failure forever.
  return { added, removed, managed: added.sort(), warnings, skipped: false };
}

function firstLine(s: string): string {
  return (s || "unknown error").trim().split("\n")[0].slice(0, 200);
}

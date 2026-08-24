import { homedir } from "node:os";
import { join } from "node:path";

// The tool-agnostic store (docs/design.md §3).
//
// cc-fleet stops writing into any one agent tool's directory and keeps its own canonical copy here,
// then PROJECTS that into each tool's native location (see project.ts). Three things fall out of the
// extra layer that could not exist without it:
//
//   1. `local/` — a place on the node that the hub never touches, so a machine can author its own
//      skills without full takeover eating them. Without this, "the hub decides" and "I can add a
//      skill here" are mutually exclusive.
//   2. One copy feeding several tools. Storing under ~/.claude/ would be admitting only Claude Code
//      exists.
//   3. Rules as many files instead of one blob, so "ship this rule to these machines" is expressible.

export function agentsHome(home: string = homedir()): string {
  return process.env.AGENTS_HOME ?? join(home, ".agents");
}
/** Hub-managed. Full takeover: anything not in the profile is deleted. */
export function fleetDir(agents: string): string {
  return join(agents, "fleet");
}
/** Node-owned. cc-fleet never deletes or rewrites anything under here. */
export function localDir(agents: string): string {
  return join(agents, "local");
}
/** Backups belong to the STORE, not to any tool — hence here rather than under ~/.claude. */
export function backupsDir(agents: string): string {
  return join(agents, ".cc-fleet", "backups");
}
export function manifestPath(agents: string): string {
  return join(agents, ".cc-fleet", "projected.json");
}

export const SKILLS = "skills";
export const RULES = "rules";

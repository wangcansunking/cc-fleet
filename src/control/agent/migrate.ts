import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { localDir, SKILLS } from "./store.js";

// One-time migration from the M1 layout, where cc-fleet managed `~/.claude/skills/` directly.
//
// On such a machine that directory holds TWO things with no marker telling them apart: skills the
// hub pushed, and skills the person put there. After M2 the directory becomes a projection target
// under full takeover, so without this the second kind would simply vanish on first apply.

export interface MigrationResult {
  /** Skill ids moved into ~/.agents/local/skills/. */
  moved: string[];
  ran: boolean;
}

/**
 * Move pre-existing skills the incoming profile does NOT claim into the node's own half of the store.
 *
 * The `desiredIds` filter is the load-bearing part. Moving everything would turn every hub-managed
 * skill into a LOCAL one — and local wins projection, so the node would permanently shadow the
 * hub's version with a frozen copy from the day it upgraded. A well-meaning migration would have
 * produced silent, undiagnosable drift across the fleet.
 *
 * Runs only when the store does not exist yet, and is a no-op afterwards.
 */
export function migrateLegacyLayout(agents: string, claudeHome: string, desiredIds: Set<string>): MigrationResult {
  if (existsSync(agents)) return { moved: [], ran: false };

  const legacy = join(claudeHome, SKILLS);
  if (!existsSync(legacy)) { mkdirSync(agents, { recursive: true }); return { moved: [], ran: true }; }

  const dest = join(localDir(agents), SKILLS);
  const moved: string[] = [];
  for (const id of readdirSync(legacy)) {
    const src = join(legacy, id);
    if (!statSync(src).isDirectory()) continue;
    if (desiredIds.has(id)) continue; // the hub owns this one — leave it to be reprojected
    mkdirSync(dest, { recursive: true });
    cpSync(src, join(dest, id), { recursive: true });
    rmSync(src, { recursive: true, force: true });
    moved.push(id);
  }
  mkdirSync(agents, { recursive: true });
  return { moved: moved.sort(), ran: true };
}

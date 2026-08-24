import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { backupsDir } from "./store.js";

// The safety net for full-takeover apply and projection (docs/design.md §3).
//
// A complete copy of every tree cc-fleet is about to mutate, taken immediately before it mutates
// them, so a bad push is always recoverable locally without the hub. Backups live under
// `~/.agents/.cc-fleet/` — outside every tree they protect, because a safety net inside the blast
// radius is not a safety net.
export const KEEP_BACKUPS = 10;

export { backupsDir };

// Backup directory names must (a) be legal on Windows, where ':' is forbidden in a path, and
// (b) sort lexicographically in chronological order, so "newest" is a plain string compare.
function stampFor(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

export function listBackups(agents: string): string[] {
  const root = backupsDir(agents);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => statSync(join(root, name)).isDirectory())
    .sort()
    .reverse()
    .map((name) => join(root, name));
}

// Copy each existing source tree into one timestamped backup, keyed by the source's basename.
// Returns the backup path, or null when there was nothing anywhere to preserve — a snapshot of
// nothing is noise that would consume a rollback slot.
export function snapshot(agents: string, sources: string[], now: Date = new Date()): string | null {
  const live = sources.filter((s) => existsSync(s) && (statSync(s).isFile() || readdirSync(s).length > 0));
  if (!live.length) return null;

  const root = backupsDir(agents);
  mkdirSync(root, { recursive: true });
  // Two snapshots can land in the same millisecond (a reconnect storm, or simply a fast test).
  // Suffix rather than overwrite: clobbering the previous snapshot would lose a distinct pre-state.
  const base = stampFor(now);
  let dir = join(root, base);
  for (let n = 1; existsSync(dir); n++) dir = join(root, `${base}_${n}`);

  for (const src of live) {
    const dest = join(dir, basename(src));
    cpSync(src, dest, { recursive: true });
  }
  return dir;
}

export function pruneBackups(agents: string, keep: number = KEEP_BACKUPS): void {
  for (const dir of listBackups(agents).slice(keep)) rmSync(dir, { recursive: true, force: true });
}

// Replace a tree wholesale from the newest backup that contains it. Returns the backup restored
// from, or null when there is none. This is a REPLACE, not a merge: the point of a rollback is to
// reproduce the earlier state exactly, and a merge would leave behind whatever the bad push added.
export function restoreLatest(agents: string, target: string): string | null {
  const name = basename(target);
  const found = listBackups(agents).find((b) => existsSync(join(b, name)));
  if (!found) return null;
  rmSync(target, { recursive: true, force: true });
  cpSync(join(found, name), target, { recursive: true });
  return found;
}

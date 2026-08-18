import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

// The safety net for full-takeover apply (docs/design.md §8): a complete copy of skills/ taken
// immediately before any mutation, so a bad push is always recoverable locally without the hub.
//
// Backups live OUTSIDE skills/ — under `<claudeHome>/.cc-fleet/backups/` — precisely because apply
// deletes everything under skills/ that the profile doesn't declare. A safety net inside the blast
// radius is not a safety net.
export const KEEP_BACKUPS = 10;

export function backupsDir(claudeHome: string): string {
  return join(claudeHome, ".cc-fleet", "backups");
}
function skillsDir(claudeHome: string): string {
  return join(claudeHome, "skills");
}

// Backup directory names must (a) be legal on Windows, where ':' is forbidden in a path, and
// (b) sort lexicographically in chronological order, so "newest" is a plain string compare with no
// stat() calls. A sanitized ISO-8601 stamp satisfies both.
function stampFor(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

// Every existing backup, newest first.
export function listBackups(claudeHome: string): string[] {
  const root = backupsDir(claudeHome);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => statSync(join(root, name)).isDirectory())
    .sort()
    .reverse()
    .map((name) => join(root, name));
}

// Copy the current skills/ tree into a fresh backup. Returns the backup path, or null when there is
// nothing to preserve (no skills/ yet, or it is empty) — a snapshot of nothing is noise that would
// consume a rollback slot.
export function snapshotSkills(claudeHome: string, now: Date = new Date()): string | null {
  const src = skillsDir(claudeHome);
  if (!existsSync(src) || readdirSync(src).length === 0) return null;
  const root = backupsDir(claudeHome);
  mkdirSync(root, { recursive: true });
  // Two snapshots can land in the same millisecond (reconnect storm, or simply a fast test). Suffix
  // rather than overwrite: silently clobbering the previous snapshot would lose a distinct pre-state.
  const base = stampFor(now);
  let dir = join(root, base);
  for (let n = 1; existsSync(dir); n++) dir = join(root, `${base}_${n}`);
  cpSync(src, join(dir, "skills"), { recursive: true });
  return dir;
}

// Delete all but the `keep` newest backups.
export function pruneBackups(claudeHome: string, keep: number = KEEP_BACKUPS): void {
  for (const dir of listBackups(claudeHome).slice(keep)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Replace skills/ wholesale with the newest backup. Returns the backup restored from, or null when
// there is none. This is a REPLACE, not a merge: the point of a rollback is to reproduce the earlier
// state exactly, and a merge would leave behind whatever the bad push added.
//
// Nothing outside skills/ is touched, mirroring apply's own blast radius.
export function restoreLatest(claudeHome: string): string | null {
  const latest = listBackups(claudeHome)[0];
  if (!latest) return null;
  const dest = skillsDir(claudeHome);
  rmSync(dest, { recursive: true, force: true });
  const saved = join(latest, "skills");
  // A snapshot always contains a skills/ dir, but tolerate a hand-mangled backup by restoring to an
  // empty skills/ rather than throwing — the user is already in a recovery path.
  if (existsSync(saved)) cpSync(saved, dest, { recursive: true });
  else mkdirSync(dest, { recursive: true });
  return latest;
}

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import type { DesiredState } from "../proto/index.js";
import { snapshotSkills, pruneBackups, KEEP_BACKUPS } from "./backup.js";

// Full-takeover apply of `<claudeHome>/skills/` (docs/design.md §8).
//
// Scope is deliberately narrow: this function owns skills/ and nothing else. Identity (.claude.json),
// session history (projects/), memory, CLAUDE.md and commands/ are explicitly off-limits — "the hub
// decides the config" must never mean "the hub can erase your account and your history".

export type ApplyResult =
  | { ok: true; written: string[]; deleted: string[]; warnings: string[]; changed: boolean }
  | { ok: false; error: string };

export interface ApplyOptions {
  backup?: boolean;    // default true; the CLI/tests can opt out
  keep?: number;       // backups to retain
  now?: () => Date;    // clock, for deterministic backup names in tests
}

// Relative POSIX paths, as they appear in results and on the wire.
function rel(...parts: string[]): string {
  return parts.join("/");
}

// Is `candidate` contained by `root` (or equal to it)? Compared on normalized absolute paths so that
// `..`, mixed separators and redundant segments cannot smuggle a write outside the managed tree.
function contains(root: string, candidate: string): boolean {
  const r = root.endsWith(sep) ? root : root + sep;
  return candidate.startsWith(r);
}

// Validate the whole batch BEFORE touching disk.
//
// This channel is effectively remote code execution (design §9): a skill is instructions the agent
// will later run. So containment is enforced on the NODE, not delegated to a trusted hub — and a
// single bad entry rejects the entire batch, because a partially-applied profile leaves a state
// neither side can reason about.
function validate(skillsRoot: string, state: DesiredState): { ok: true; files: Map<string, string> } | { ok: false; error: string } {
  const files = new Map<string, string>(); // relative posix path -> content
  const seenIds = new Set<string>();
  for (const skill of state.skills) {
    const id = skill.id;
    if (!id || id === "." || id === ".." || id.includes("/") || id.includes("\\")) {
      return { ok: false, error: `invalid skill id ${JSON.stringify(id)}: must be a single path segment` };
    }
    if (seenIds.has(id)) return { ok: false, error: `duplicate skill id ${JSON.stringify(id)}` };
    seenIds.add(id);
    const skillRoot = join(skillsRoot, id);
    for (const file of skill.files) {
      const p = file.path;
      if (!p || p === "." || p === "..") {
        return { ok: false, error: `invalid path ${JSON.stringify(p)} in skill ${id}` };
      }
      // Reject POSIX-absolute and Windows drive/UNC forms outright. join() would otherwise quietly
      // treat some of these as relative on the "wrong" platform, so the check must be explicit rather
      // than inferred from the resolved path.
      if (p.startsWith("/") || p.startsWith("\\") || /^[a-zA-Z]:/.test(p)) {
        return { ok: false, error: `invalid path ${JSON.stringify(p)} in skill ${id}: must be relative` };
      }
      const abs = join(skillRoot, p);
      if (!contains(skillRoot, abs)) {
        return { ok: false, error: `invalid path ${JSON.stringify(p)} in skill ${id}: escapes skills/${id}/` };
      }
      const key = rel(id, ...p.split(/[\\/]/).filter((s) => s.length > 0));
      if (files.has(key)) return { ok: false, error: `duplicate path ${JSON.stringify(key)}` };
      files.set(key, file.content);
    }
  }
  return { ok: true, files };
}

// Every file currently under skills/, as relative posix paths.
function walk(root: string, prefix = ""): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const abs = join(root, name);
    const relPath = prefix ? rel(prefix, name) : name;
    if (statSync(abs).isDirectory()) out.push(...walk(abs, relPath));
    else out.push(relPath);
  }
  return out;
}

// Delete directories that became empty after the deletion pass, bottom-up. skills/ itself is kept:
// its absence would be indistinguishable from "cc-fleet never ran here".
function pruneEmptyDirs(root: string): void {
  if (!existsSync(root)) return;
  for (const name of readdirSync(root)) {
    const abs = join(root, name);
    if (!statSync(abs).isDirectory()) continue;
    pruneEmptyDirs(abs);
    if (readdirSync(abs).length === 0) rmSync(abs, { recursive: true, force: true });
  }
}

export function applySkills(claudeHome: string, state: DesiredState, opts: ApplyOptions = {}): ApplyResult {
  const skillsRoot = join(claudeHome, "skills");
  const valid = validate(skillsRoot, state);
  if (!valid.ok) return valid;

  const desired = valid.files;
  const existing = walk(skillsRoot);

  // Compute the full diff before mutating, so `changed` is honest and the backup decision below can
  // be made without having already destroyed the thing worth backing up.
  const toWrite = [...desired.entries()].filter(([path, content]) => {
    const abs = join(skillsRoot, ...path.split("/"));
    if (!existsSync(abs)) return true;
    try { return readFileSync(abs, "utf8") !== content; }
    catch { return true; } // unreadable (permissions, a directory in its place) — rewrite it
  });
  const toDelete = existing.filter((path) => !desired.has(path));
  const changed = toWrite.length > 0 || toDelete.length > 0;

  if (!changed) return { ok: true, written: [], deleted: [], warnings: [], changed: false };

  // Snapshot only when something will actually change. The agent re-applies on every reconnect, so
  // snapshotting no-ops would flush the 10-slot rollback window with identical copies — losing the
  // real pre-change states exactly when a flapping link makes them most valuable.
  if (opts.backup !== false) {
    snapshotSkills(claudeHome, opts.now?.() ?? new Date());
    pruneBackups(claudeHome, opts.keep ?? KEEP_BACKUPS);
  }

  const warnings: string[] = [];
  for (const path of toDelete) {
    try { rmSync(join(skillsRoot, ...path.split("/")), { force: true }); }
    catch (e) { warnings.push(`could not delete ${path}: ${(e as Error).message}`); }
  }
  pruneEmptyDirs(skillsRoot);

  mkdirSync(skillsRoot, { recursive: true });
  for (const [path, content] of toWrite) {
    const abs = join(skillsRoot, ...path.split("/"));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }

  return {
    ok: true,
    written: toWrite.map(([path]) => path).sort(),
    deleted: [...toDelete].sort(),
    warnings,
    changed: true,
  };
}

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import type { DesiredState } from "../proto/index.js";
import { fleetDir, SKILLS, RULES } from "./store.js";
import { snapshot, pruneBackups, KEEP_BACKUPS } from "./backup.js";

// Full-takeover apply of `~/.agents/fleet/` (docs/design.md §3).
//
// Scope moved here from ~/.claude/skills in M2. The takeover semantics are unchanged — anything the
// profile does not declare is deleted — but the blast radius is now cc-fleet's OWN directory rather
// than a tool's, so `~/.agents/local/` can exist alongside it as a place the hub never touches.

export type ApplyResult =
  | { ok: true; written: string[]; deleted: string[]; warnings: string[]; changed: boolean }
  | { ok: false; error: string };

export interface ApplyOptions {
  backup?: boolean;
  keep?: number;
  now?: () => Date;
  /** Extra trees to include in the pre-apply snapshot — the projection targets. */
  alsoBackup?: string[];
}

const rel = (...parts: string[]): string => parts.join("/");

function contains(root: string, candidate: string): boolean {
  const r = root.endsWith(sep) ? root : root + sep;
  return candidate.startsWith(r);
}

// Validate the whole batch BEFORE touching disk.
//
// This channel is effectively remote code execution (design §9): a skill is instructions the agent
// will later run. Containment is enforced on the NODE, not delegated to a trusted hub — and a single
// bad entry rejects the entire batch, because a partially-applied profile leaves a state neither
// side can reason about.
function validate(root: string, state: DesiredState): { ok: true; files: Map<string, string> } | { ok: false; error: string } {
  const files = new Map<string, string>();

  const badId = (id: string, kind: string): string | null =>
    !id || id === "." || id === ".." || id.includes("/") || id.includes("\\")
      ? `invalid ${kind} id ${JSON.stringify(id)}: must be a single path segment`
      : null;

  const seenSkills = new Set<string>();
  for (const skill of state.skills) {
    const bad = badId(skill.id, "skill");
    if (bad) return { ok: false, error: bad };
    if (seenSkills.has(skill.id)) return { ok: false, error: `duplicate skill id ${JSON.stringify(skill.id)}` };
    seenSkills.add(skill.id);

    const skillRoot = join(root, SKILLS, skill.id);
    for (const file of skill.files) {
      const p = file.path;
      if (!p || p === "." || p === "..") return { ok: false, error: `invalid path ${JSON.stringify(p)} in skill ${skill.id}` };
      if (p.startsWith("/") || p.startsWith("\\") || /^[a-zA-Z]:/.test(p)) {
        return { ok: false, error: `invalid path ${JSON.stringify(p)} in skill ${skill.id}: must be relative` };
      }
      // Backslashes are refused on every platform: Windows reads `\` as a separator (so `..\x`
      // escapes) while Linux reads it as an ordinary filename character (so the same string stays
      // inside). One profile would otherwise produce two different layouts across a mixed fleet,
      // with the traversal guard holding on exactly one of them.
      if (p.includes("\\")) {
        return { ok: false, error: `invalid path ${JSON.stringify(p)} in skill ${skill.id}: use "/" separators (backslashes are platform-dependent)` };
      }
      if (!contains(skillRoot, join(skillRoot, p))) {
        return { ok: false, error: `invalid path ${JSON.stringify(p)} in skill ${skill.id}: escapes ${SKILLS}/${skill.id}/` };
      }
      const key = rel(SKILLS, skill.id, ...p.split("/").filter(Boolean));
      if (files.has(key)) return { ok: false, error: `duplicate path ${JSON.stringify(key)}` };
      files.set(key, file.content);
    }
  }

  const seenRules = new Set<string>();
  for (const rule of state.rules) {
    const bad = badId(rule.id, "rule");
    if (bad) return { ok: false, error: bad };
    if (seenRules.has(rule.id)) return { ok: false, error: `duplicate rule id ${JSON.stringify(rule.id)}` };
    seenRules.add(rule.id);
    files.set(rel(RULES, `${rule.id}.md`), rule.content);
  }

  return { ok: true, files };
}

export function walkFiles(root: string, prefix = ""): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const abs = join(root, name);
    const relPath = prefix ? rel(prefix, name) : name;
    if (statSync(abs).isDirectory()) out.push(...walkFiles(abs, relPath));
    else out.push(relPath);
  }
  return out;
}

// Delete directories left empty after the deletion pass. The root itself is kept: its absence would
// be indistinguishable from "cc-fleet never ran here".
export function pruneEmptyDirs(root: string): void {
  if (!existsSync(root)) return;
  for (const name of readdirSync(root)) {
    const abs = join(root, name);
    if (!statSync(abs).isDirectory()) continue;
    pruneEmptyDirs(abs);
    if (readdirSync(abs).length === 0) rmSync(abs, { recursive: true, force: true });
  }
}

export function applyFleet(agents: string, state: DesiredState, opts: ApplyOptions = {}): ApplyResult {
  const root = fleetDir(agents);
  const valid = validate(root, state);
  if (!valid.ok) return valid;

  const desired = valid.files;
  const existing = walkFiles(root);

  // Compute the full diff before mutating, so `changed` is honest and the backup decision can be made
  // without having already destroyed the thing worth backing up.
  const toWrite = [...desired.entries()].filter(([path, content]) => {
    const abs = join(root, ...path.split("/"));
    if (!existsSync(abs)) return true;
    try { return readFileSync(abs, "utf8") !== content; } catch { return true; }
  });
  const toDelete = existing.filter((path) => !desired.has(path));
  const changed = toWrite.length > 0 || toDelete.length > 0;

  if (!changed) return { ok: true, written: [], deleted: [], warnings: [], changed: false };

  // Snapshot only when something will actually change. The agent re-applies on every reconnect, so
  // snapshotting no-ops would flush the rollback window with identical copies — losing the real
  // pre-change states exactly when a flapping link makes them most valuable.
  if (opts.backup !== false) {
    snapshot(agents, [root, ...(opts.alsoBackup ?? [])], opts.now?.() ?? new Date());
    pruneBackups(agents, opts.keep ?? KEEP_BACKUPS);
  }

  const warnings: string[] = [];
  for (const path of toDelete) {
    try { rmSync(join(root, ...path.split("/")), { force: true }); }
    catch (e) { warnings.push(`could not delete ${path}: ${(e as Error).message}`); }
  }
  pruneEmptyDirs(root);

  mkdirSync(root, { recursive: true });
  for (const [path, content] of toWrite) {
    const abs = join(root, ...path.split("/"));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }

  return { ok: true, written: toWrite.map(([p]) => p).sort(), deleted: [...toDelete].sort(), warnings, changed: true };
}

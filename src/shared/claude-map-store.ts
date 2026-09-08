import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  effectiveClaudeMappings,
  type ClaudeMapUserEntry,
  type EffectiveClaudeMapping,
} from "../core/claude-model-map.js";
import { stripOneM } from "../core/model-canonical.js";
import { readClaudeMapEnabled } from "./prefs.js";

const FILE_NAME = "claude-map.json";
const MAX_ENTRIES = 256;
const MAX_ID_LENGTH = 200;
const ALIAS_RE = /^claude-[a-z0-9][a-z0-9.-]*(?:-[a-z0-9][a-z0-9.-]*)+$/;
const BACKEND_RE = /^[^\x00-\x20\x7f]+$/;

const rootSchema = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  entries: z.array(z.unknown()).max(MAX_ENTRIES),
}).strict();

export interface ClaudeMapConfigState {
  enabled: boolean;
  entries: ClaudeMapUserEntry[];
  effectiveMappings: EffectiveClaudeMapping[];
  warning: string | null;
  source: "file" | "legacy" | "default" | "invalid";
}

export interface ClaudeMapReplacement {
  enabled: boolean;
  entries: unknown[];
}

export class ClaudeMapStoreError extends Error {
  constructor(message: string, readonly code: "invalid_config" | "not_found" = "invalid_config") {
    super(message);
    this.name = "ClaudeMapStoreError";
  }
}

export function normalizeClaudeAlias(raw: unknown): string {
  if (typeof raw !== "string") throw new ClaudeMapStoreError("alias must be a string");
  const alias = stripOneM(raw.trim());
  if (!alias || alias.length > MAX_ID_LENGTH || !ALIAS_RE.test(alias)) {
    throw new ClaudeMapStoreError("alias must match claude-<family>-<version> using lowercase letters, digits, dots, and hyphens");
  }
  return alias;
}

export function normalizeClaudeBackend(raw: unknown, alias: string): string {
  if (typeof raw !== "string") throw new ClaudeMapStoreError("backend must be a string");
  const backend = raw.trim();
  if (!backend || backend.length > MAX_ID_LENGTH || !BACKEND_RE.test(backend)) {
    throw new ClaudeMapStoreError("backend must be a non-empty exact model ID without whitespace or control characters");
  }
  if (backend === alias) throw new ClaudeMapStoreError("backend must differ from alias");
  return backend;
}

export function normalizeClaudeMapEntries(rawEntries: unknown): ClaudeMapUserEntry[] {
  if (!Array.isArray(rawEntries)) throw new ClaudeMapStoreError("entries must be an array");
  if (rawEntries.length > MAX_ENTRIES) throw new ClaudeMapStoreError(`entries may contain at most ${MAX_ENTRIES} items`);
  const seen = new Set<string>();
  const entries: ClaudeMapUserEntry[] = [];
  for (const raw of rawEntries) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ClaudeMapStoreError("each entry must be an object");
    const value = raw as Record<string, unknown>;
    const keys = Object.keys(value).sort();
    const alias = normalizeClaudeAlias(value.alias);
    if (seen.has(alias)) throw new ClaudeMapStoreError(`duplicate alias: ${alias}`);
    seen.add(alias);
    if (value.disabled === true) {
      if (keys.join(",") !== "alias,disabled") throw new ClaudeMapStoreError(`disabled entry ${alias} may contain only alias and disabled`);
      entries.push({ alias, disabled: true });
      continue;
    }
    if (keys.join(",") !== "alias,backend") throw new ClaudeMapStoreError(`mapping entry ${alias} must contain exactly alias and backend`);
    entries.push({ alias, backend: normalizeClaudeBackend(value.backend, alias) });
  }
  return entries.sort((a, b) => a.alias.localeCompare(b.alias));
}

export function normalizeClaudeMapReplacement(raw: unknown): { enabled: boolean; entries: ClaudeMapUserEntry[] } {
  const parsed = z.object({ enabled: z.boolean(), entries: z.array(z.unknown()).max(MAX_ENTRIES) }).strict().safeParse(raw);
  if (!parsed.success) throw new ClaudeMapStoreError(parsed.error.issues[0]?.message ?? "invalid Claude map configuration");
  return { enabled: parsed.data.enabled, entries: normalizeClaudeMapEntries(parsed.data.entries) };
}

function pathFor(dir: string): string { return join(dir, FILE_NAME); }

function writeConfig(dir: string, enabled: boolean, entries: readonly ClaudeMapUserEntry[]): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const target = pathFor(dir);
  const tmp = join(dir, `.${FILE_NAME}.${process.pid}.tmp`);
  const data = { version: 1, enabled, entries };
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  try {
    renameSync(tmp, target);
    try { chmodSync(target, 0o600); } catch { /* Windows and restricted filesystems may not expose POSIX modes. */ }
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* best effort cleanup */ }
    throw error;
  }
}

function validState(enabled: boolean, entries: ClaudeMapUserEntry[], source: ClaudeMapConfigState["source"]): ClaudeMapConfigState {
  return { enabled, entries, effectiveMappings: effectiveClaudeMappings(entries), warning: null, source };
}

export function readClaudeMapConfig(dir: string): ClaudeMapConfigState {
  const path = pathFor(dir);
  if (!existsSync(path)) {
    const enabled = readClaudeMapEnabled(dir);
    return validState(enabled, [], enabled ? "legacy" : "default");
  }
  try {
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(path, "utf8")); }
    catch { throw new ClaudeMapStoreError("invalid JSON in claude-map.json"); }
    const root = rootSchema.safeParse(raw);
    if (!root.success) {
      const version = (raw as { version?: unknown } | null)?.version;
      if (version !== 1) throw new ClaudeMapStoreError(`unsupported claude-map.json version: ${String(version)}`);
      throw new ClaudeMapStoreError(root.error.issues[0]?.message ?? "invalid claude-map.json");
    }
    return validState(root.data.enabled, normalizeClaudeMapEntries(root.data.entries), "file");
  } catch (error) {
    const warning = error instanceof Error ? error.message : String(error);
    return {
      enabled: false,
      entries: [],
      effectiveMappings: effectiveClaudeMappings([]),
      warning: `Claude map disabled: ${warning}`,
      source: "invalid",
    };
  }
}

function readWritable(dir: string): ClaudeMapConfigState {
  const current = readClaudeMapConfig(dir);
  if (current.source === "invalid") throw new ClaudeMapStoreError(current.warning ?? "existing Claude map configuration is invalid");
  return current;
}

export function replaceClaudeMapConfig(dir: string, raw: unknown): ClaudeMapConfigState {
  const normalized = normalizeClaudeMapReplacement(raw);
  readWritable(dir); // refuse to erase a malformed/unknown-version store without explicit repair
  writeConfig(dir, normalized.enabled, normalized.entries);
  return validState(normalized.enabled, normalized.entries, "file");
}

export function setClaudeMapEnabled(dir: string, enabled: boolean): ClaudeMapConfigState {
  if (typeof enabled !== "boolean") throw new ClaudeMapStoreError("enabled must be a boolean");
  const current = readWritable(dir);
  writeConfig(dir, enabled, current.entries);
  return validState(enabled, current.entries, "file");
}

export function upsertClaudeMapEntry(dir: string, raw: unknown): ClaudeMapConfigState {
  const entry = normalizeClaudeMapEntries([raw])[0];
  const current = readWritable(dir);
  const entries = current.entries.filter((candidate) => candidate.alias !== entry.alias);
  entries.push(entry);
  entries.sort((a, b) => a.alias.localeCompare(b.alias));
  writeConfig(dir, current.enabled, entries);
  return validState(current.enabled, entries, "file");
}

export function removeClaudeMapEntry(dir: string, rawAlias: unknown): ClaudeMapConfigState {
  const alias = normalizeClaudeAlias(rawAlias);
  const current = readWritable(dir);
  const entries = current.entries.filter((entry) => entry.alias !== alias);
  if (entries.length === current.entries.length) throw new ClaudeMapStoreError(`no user entry for ${alias}`, "not_found");
  writeConfig(dir, current.enabled, entries);
  return validState(current.enabled, entries, "file");
}

export function resetClaudeMapEntries(dir: string): ClaudeMapConfigState {
  const current = readWritable(dir);
  writeConfig(dir, current.enabled, []);
  return validState(current.enabled, [], "file");
}

import { stripOneM } from "./model-canonical.js";

export interface ClaudeModelMapping {
  alias: string;
  backend: string;
}

export type ClaudeMapUserEntry =
  | ClaudeModelMapping
  | { alias: string; disabled: true };

export interface EffectiveClaudeMapping {
  alias: string;
  backend?: string;
  source: "builtin" | "user";
  disabled: boolean;
  hasOverride: boolean;
}

export type AvailableClaudeMapping = EffectiveClaudeMapping & { backend: string; disabled: false };

export interface ClaudeMappingRow {
  alias: string;
  backend?: string;
  source: "builtin" | "user";
  status: "available" | "unavailable" | "disabled";
  hasOverride: boolean;
}

export const BUILTIN_CLAUDE_MODEL_MAP: readonly ClaudeModelMapping[] = [
  { alias: "claude-haiku-4-5", backend: "gpt-5.4" },
  { alias: "claude-sonnet-4-6", backend: "gpt-5.5" },
  { alias: "claude-opus-4-8", backend: "gpt-5.6-luna" },
  { alias: "claude-opus-5", backend: "gpt-5.6-sol" },
  { alias: "claude-sonnet-5", backend: "gpt-5.6-terra" },
];

// Compatibility export for callers outside this repository. New code should inject an effective map.
export const CLAUDE_MODEL_MAP = BUILTIN_CLAUDE_MODEL_MAP;

export function effectiveClaudeMappings(userEntries: readonly ClaudeMapUserEntry[]): EffectiveClaudeMapping[] {
  const byAlias = new Map<string, EffectiveClaudeMapping>();
  for (const { alias, backend } of BUILTIN_CLAUDE_MODEL_MAP) {
    byAlias.set(alias, { alias, backend, source: "builtin", disabled: false, hasOverride: false });
  }
  for (const entry of userEntries) {
    if ("disabled" in entry) {
      byAlias.set(entry.alias, { alias: entry.alias, source: "user", disabled: true, hasOverride: true });
    } else {
      byAlias.set(entry.alias, { alias: entry.alias, backend: entry.backend, source: "user", disabled: false, hasOverride: true });
    }
  }
  return [...byAlias.values()].sort((a, b) => a.alias.localeCompare(b.alias));
}

function mappingsOrBuiltins(mappings?: readonly EffectiveClaudeMapping[]): readonly EffectiveClaudeMapping[] {
  return mappings ?? effectiveClaudeMappings([]);
}

export function availableClaudeMappings(mappings: readonly EffectiveClaudeMapping[], available: Iterable<string>): AvailableClaudeMapping[];
export function availableClaudeMappings(available: Iterable<string>): AvailableClaudeMapping[];
export function availableClaudeMappings(
  mappingsOrAvailable: readonly EffectiveClaudeMapping[] | Iterable<string>,
  maybeAvailable?: Iterable<string>,
): AvailableClaudeMapping[] {
  const mappings = maybeAvailable ? mappingsOrAvailable as readonly EffectiveClaudeMapping[] : effectiveClaudeMappings([]);
  const available = maybeAvailable ?? mappingsOrAvailable as Iterable<string>;
  const live = new Set(available);
  return mappings.filter((entry): entry is AvailableClaudeMapping => !entry.disabled && entry.backend !== undefined && live.has(entry.backend));
}

export function backendForClaudeAlias(mappings: readonly EffectiveClaudeMapping[], model: string, available: Iterable<string>): string | undefined;
export function backendForClaudeAlias(model: string, available: Iterable<string>): string | undefined;
export function backendForClaudeAlias(
  mappingsOrModel: readonly EffectiveClaudeMapping[] | string,
  modelOrAvailable: string | Iterable<string>,
  maybeAvailable?: Iterable<string>,
): string | undefined {
  const mappings = typeof mappingsOrModel === "string" ? effectiveClaudeMappings([]) : mappingsOrModel;
  const model = typeof mappingsOrModel === "string" ? mappingsOrModel : modelOrAvailable as string;
  const available = typeof mappingsOrModel === "string" ? modelOrAvailable as Iterable<string> : maybeAvailable ?? [];
  const alias = stripOneM(model);
  return availableClaudeMappings(mappings, available).find((entry) => entry.alias === alias)?.backend;
}

export function mappedModelIds(mappings: readonly EffectiveClaudeMapping[], available: string[]): string[];
export function mappedModelIds(available: string[]): string[];
export function mappedModelIds(
  mappingsOrAvailable: readonly EffectiveClaudeMapping[] | string[],
  maybeAvailable?: string[],
): string[] {
  const mappings = maybeAvailable ? mappingsOrAvailable as readonly EffectiveClaudeMapping[] : effectiveClaudeMappings([]);
  const available = maybeAvailable ?? mappingsOrAvailable as string[];
  const out = [...available];
  const seen = new Set(out);
  for (const { alias } of availableClaudeMappings(mappings, available)) {
    if (!seen.has(alias)) { out.push(alias); seen.add(alias); }
  }
  return out;
}

export function modelMapDisplay(mappings: readonly EffectiveClaudeMapping[], model: string, available: Iterable<string>): string;
export function modelMapDisplay(model: string, available: Iterable<string>): string;
export function modelMapDisplay(
  mappingsOrModel: readonly EffectiveClaudeMapping[] | string,
  modelOrAvailable: string | Iterable<string>,
  maybeAvailable?: Iterable<string>,
): string {
  const mappings = typeof mappingsOrModel === "string" ? effectiveClaudeMappings([]) : mappingsOrModel;
  const model = typeof mappingsOrModel === "string" ? mappingsOrModel : modelOrAvailable as string;
  const available = typeof mappingsOrModel === "string" ? modelOrAvailable as Iterable<string> : maybeAvailable ?? [];
  const backend = backendForClaudeAlias(mappings, model, available);
  return backend ? `${stripOneM(model)} → ${backend}` : model;
}

export function claudeMappingRows(mappings: readonly EffectiveClaudeMapping[], available: Iterable<string>): ClaudeMappingRow[] {
  const live = new Set(available);
  return mappings.map((entry) => ({
    alias: entry.alias,
    ...(entry.backend === undefined ? {} : { backend: entry.backend }),
    source: entry.source,
    status: entry.disabled ? "disabled" : live.has(entry.backend ?? "") ? "available" : "unavailable",
    hasOverride: entry.hasOverride,
  }));
}

export function claudeMapLines(
  mappings: readonly EffectiveClaudeMapping[] = mappingsOrBuiltins(),
  available?: Iterable<string>,
): string[] {
  if (available === undefined) {
    return mappings.map(({ alias, backend, disabled }) => `${alias} → ${disabled ? "disabled" : backend}`);
  }
  return claudeMappingRows(mappings, available).map((entry) =>
    `${entry.alias} → ${entry.status === "disabled" ? "disabled" : entry.backend} · ${entry.source} · ${entry.status}`,
  );
}

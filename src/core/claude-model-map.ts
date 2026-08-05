import { stripOneM } from "./model-canonical.js";

export interface ClaudeModelMapping {
  alias: string;
  backend: string;
}

export const CLAUDE_MODEL_MAP: readonly ClaudeModelMapping[] = [
  { alias: "claude-haiku-4-5", backend: "gpt-5.4" },
  { alias: "claude-sonnet-4-6", backend: "gpt-5.5" },
  { alias: "claude-opus-4-8", backend: "gpt-5.6-luna" },
  { alias: "claude-opus-5", backend: "gpt-5.6-sol" },
  { alias: "claude-sonnet-5", backend: "gpt-5.6-terra" },
];

export function availableClaudeMappings(available: Iterable<string>): ClaudeModelMapping[] {
  const live = new Set(available);
  return CLAUDE_MODEL_MAP.filter(({ backend }) => live.has(backend));
}

export function backendForClaudeAlias(model: string, available: Iterable<string>): string | undefined {
  const alias = stripOneM(model);
  return availableClaudeMappings(available).find((entry) => entry.alias === alias)?.backend;
}

export function mappedModelIds(available: string[]): string[] {
  const out = [...available];
  const seen = new Set(out);
  for (const { alias } of availableClaudeMappings(available)) {
    if (!seen.has(alias)) { out.push(alias); seen.add(alias); }
  }
  return out;
}

export function modelMapDisplay(model: string, available: Iterable<string>): string {
  const backend = backendForClaudeAlias(model, available);
  return backend ? `${stripOneM(model)} → ${backend}` : model;
}

export function claudeMapLines(): string[] {
  return CLAUDE_MODEL_MAP.map(({ alias, backend }) => `${alias} → ${backend}`);
}

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { ManagedClients } from "../proto/index.js";

const BACKUP_DIR = join(".cc-fleet", "client-backup");
const META = "meta.json";
interface BackupMeta { claudeExisted: boolean; codexExisted: boolean }

export interface ClientApplyStatus { status: "changed" | "unchanged" | "skipped" | "error"; error?: string }
export interface ManagedClientResult {
  claude: ClientApplyStatus;
  codex: ClientApplyStatus;
  needsRestart: boolean;
  keyRevision: number;
}

const claudePath = (home: string) => join(home, ".claude", "settings.json");
const codexPath = (home: string) => join(home, ".codex", "config.toml");
const backupDir = (agents: string) => join(agents, BACKUP_DIR);

function snapshotOnce(agents: string, home: string): void {
  const dir = backupDir(agents);
  if (existsSync(join(dir, META))) return;
  const claude = claudePath(home), codex = codexPath(home);
  mkdirSync(dir, { recursive: true });
  const meta: BackupMeta = { claudeExisted: existsSync(claude), codexExisted: existsSync(codex) };
  if (meta.claudeExisted) writeFileSync(join(dir, "claude-settings.json"), readFileSync(claude));
  if (meta.codexExisted) writeFileSync(join(dir, "codex-config.toml"), readFileSync(codex));
  writeFileSync(join(dir, META), JSON.stringify(meta, null, 2), { mode: 0o600 });
}

function canonicalClaude(model: string, contextWindow?: number): string {
  const bare = model.replace(/\[1m\]$/, "").replace(/claude-([a-z]+)-(\d+)\.(\d+)/, "claude-$1-$2-$3");
  const oneM = contextWindow != null && contextWindow > 800_000 && contextWindow < 1_500_000;
  return bare.startsWith("claude-") && (oneM || model.endsWith("[1m]")) ? `${bare}[1m]` : model;
}
function claudeEnv(baseUrl: string, apiKey: string, model: string, contextWindow?: number): Record<string, string> {
  const canonical = canonicalClaude(model, contextWindow);
  const family = /^claude-([a-z]+)-/.exec(canonical)?.[1];
  const custom = family && ["opus", "sonnet", "haiku", "fable"].includes(family)
    ? {
        [`ANTHROPIC_DEFAULT_${family.toUpperCase()}_MODEL`]: canonical,
        [`ANTHROPIC_DEFAULT_${family.toUpperCase()}_MODEL_NAME`]: canonical.replace(/\[1m\]$/, "") + (canonical.endsWith("[1m]") ? " (1M context)" : ""),
        [`ANTHROPIC_DEFAULT_${family.toUpperCase()}_MODEL_DESCRIPTION`]: `${canonical.replace(/\[1m\]$/, "")}${canonical.endsWith("[1m]") ? " · 1M context" : ""} · via cc-fleet`,
      }
    : {};
  return {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_API_KEY: apiKey,
    ANTHROPIC_MODEL: canonical,
    ...(contextWindow ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(contextWindow) } : {}),
    ...custom,
    CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "80",
    CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
  };
}
function applyClaude(home: string, env: Record<string, string>): void {
  const path = claudePath(home);
  mkdirSync(dirname(path), { recursive: true });
  let settings: Record<string, unknown> = {};
  if (existsSync(path)) {
    try { settings = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; } catch { settings = {}; }
  }
  const current = settings.env && typeof settings.env === "object" ? settings.env as Record<string, string> : {};
  delete current.ANTHROPIC_AUTH_TOKEN;
  delete current.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
  settings.env = { ...current, ...env };
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}
function applyCodex(home: string, baseUrl: string, model: string, contextWindow: number | undefined, apiKey: string): void {
  const path = codexPath(home);
  mkdirSync(dirname(path), { recursive: true });
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const top: string[] = [], tables: string[] = [];
  let inTable = false, inOurs = false;
  for (const line of existing.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) { inTable = true; inOurs = line.trim() === "[model_providers.cc-fleet]" || line.trim() === "[model_providers.copilot-reverse]"; }
    if (inOurs) continue;
    const key = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
    if (!inTable && key && ["model", "model_provider", "model_context_window"].includes(key)) continue;
    (inTable ? tables : top).push(line);
  }
  const body = [
    [`model = "${model}"`, 'model_provider = "cc-fleet"', ...(contextWindow ? [`model_context_window = ${contextWindow}`] : []), ...top.filter((x) => x.trim())].join("\n"),
    tables.join("\n").trim(),
    ["[model_providers.cc-fleet]", 'name = "cc-fleet"', `base_url = "${baseUrl}"`, 'wire_api = "responses"', "requires_openai_auth = false", `experimental_bearer_token = "${apiKey}"`].join("\n"),
  ].filter(Boolean).join("\n\n");
  writeFileSync(path, `${body}\n`);
}
function applyOne(fn: () => void, before: string | null, path: string): ClientApplyStatus {
  try {
    fn();
    const after = existsSync(path) ? readFileSync(path, "utf8") : null;
    return { status: before === after ? "unchanged" : "changed" };
  } catch (e) { return { status: "error", error: (e as Error).message }; }
}

export function applyManagedClients(agents: string, home: string = homedir(), desired: ManagedClients): ManagedClientResult {
  try { snapshotOnce(agents, home); }
  catch (e) {
    const error = `could not back up client config: ${(e as Error).message}`;
    return { claude: { status: "error", error }, codex: { status: "error", error }, needsRestart: false, keyRevision: desired.keyRevision };
  }
  const cp = claudePath(home), xp = codexPath(home);
  const beforeClaude = existsSync(cp) ? readFileSync(cp, "utf8") : null;
  const beforeCodex = existsSync(xp) ? readFileSync(xp, "utf8") : null;
  const base = desired.baseUrl.replace(/\/+$/, "");
  const claude = desired.claude
    ? applyOne(() => applyClaude(home, claudeEnv(`${base}/anthropic`, desired.apiKey, desired.claude!.model, desired.claude!.contextWindow)), beforeClaude, cp)
    : { status: "skipped" as const };
  const codex = desired.codex
    ? applyOne(() => applyCodex(home, `${base}/openai`, desired.codex!.model, desired.codex!.contextWindow, desired.apiKey), beforeCodex, xp)
    : { status: "skipped" as const };
  return { claude, codex, needsRestart: claude.status === "changed" || codex.status === "changed", keyRevision: desired.keyRevision };
}

export function restoreManagedClients(agents: string, home: string = homedir()): { ok: true } | { ok: false; error: string } {
  const dir = backupDir(agents);
  try {
    const meta = JSON.parse(readFileSync(join(dir, META), "utf8")) as BackupMeta;
    if (typeof meta.claudeExisted !== "boolean" || typeof meta.codexExisted !== "boolean") throw new Error("invalid client backup metadata");
    const cp = claudePath(home), xp = codexPath(home);
    if (meta.claudeExisted) { mkdirSync(dirname(cp), { recursive: true }); writeFileSync(cp, readFileSync(join(dir, "claude-settings.json"))); }
    else rmSync(cp, { force: true });
    if (meta.codexExisted) { mkdirSync(dirname(xp), { recursive: true }); writeFileSync(xp, readFileSync(join(dir, "codex-config.toml"))); }
    else rmSync(xp, { force: true });
    return { ok: true };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

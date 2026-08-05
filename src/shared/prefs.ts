import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Small user-preferences store (e.g. the chosen chat model, change-banner view counts), persisted
// across launches.
const file = (dir: string) => join(dir, "prefs.json");

function read(dir: string): Record<string, unknown> {
  if (!existsSync(file(dir))) return {};
  try { return JSON.parse(readFileSync(file(dir), "utf8")) as Record<string, unknown>; } catch { return {}; }
}
function write(dir: string, next: Record<string, unknown>): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file(dir), JSON.stringify(next));
}

export function readChatModel(dir: string): string | null {
  return (read(dir).chatModel as string | undefined) ?? null;
}

export function writeChatModel(dir: string, model: string): void {
  write(dir, { ...read(dir), chatModel: model });
}

// Opt-in Claude-name → GPT-backend compatibility map. Only a literal boolean true enables it; a
// missing/corrupt/old preference stays off so upgrades preserve the existing discovery + routing path.
export function readClaudeMapEnabled(dir: string): boolean {
  return read(dir).claudeMapEnabled === true;
}

export function writeClaudeMapEnabled(dir: string, enabled: boolean): void {
  write(dir, { ...read(dir), claudeMapEnabled: enabled });
}

// "What's new" banner: show a change a few times then stop. Counts are keyed by an id (e.g. version),
// so a new release re-shows; bumping the count is what decides whether the banner appears again.
const seenKey = (id: string) => `seen:${id}`;
export function shouldShowChange(dir: string, id: string, maxShows = 3): boolean {
  return ((read(dir)[seenKey(id)] as number | undefined) ?? 0) < maxShows;
}
export function markChangeShown(dir: string, id: string): void {
  const cur = read(dir);
  write(dir, { ...cur, [seenKey(id)]: ((cur[seenKey(id)] as number | undefined) ?? 0) + 1 });
}

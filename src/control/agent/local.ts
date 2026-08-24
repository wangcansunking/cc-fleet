import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { localDir, SKILLS, RULES, MCP } from "./store.js";
import { walkFiles } from "./apply.js";
import type { PushItem } from "../proto/index.js";

// Reading the node's own half of the store, for the two directions M3 adds:
//   - inventory: ids only, sent continuously, so the hub can show what exists without taking it
//   - readItem:  full content, produced ONLY for an explicit `cc-fleet push`
//
// Keeping these as separate functions is the point. Nothing that runs automatically has access to
// content; curiosity is not consent.

export interface LocalInventory {
  skills: string[];
  rules: string[];
  mcpServers: string[];
}

const idsOfDirs = (root: string, sub: string): string[] => {
  const dir = join(root, sub);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => statSync(join(dir, n)).isDirectory()).sort();
};
const idsOfFiles = (root: string, sub: string, ext: string): string[] => {
  const dir = join(root, sub);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith(ext) && statSync(join(dir, n)).isFile())
    .map((n) => n.slice(0, -ext.length))
    .sort();
};

export function localInventory(agents: string): LocalInventory {
  const local = localDir(agents);
  return {
    skills: idsOfDirs(local, SKILLS),
    rules: idsOfFiles(local, RULES, ".md"),
    mcpServers: idsOfFiles(local, MCP, ".json"),
  };
}

export type ReadItemResult = { ok: true; item: PushItem } | { ok: false; error: string };

/** Load one local item in full, ready to be pushed. Only ever called from an explicit push. */
export function readLocalItem(agents: string, kind: PushItem["kind"], id: string): ReadItemResult {
  const local = localDir(agents);
  if (!id || id.includes("/") || id.includes("\\")) return { ok: false, error: `invalid id ${JSON.stringify(id)}` };

  if (kind === "skill") {
    const dir = join(local, SKILLS, id);
    if (!existsSync(dir)) return { ok: false, error: `no local skill ${JSON.stringify(id)} in ${join(local, SKILLS)}` };
    const files = walkFiles(dir).map((rel) => ({ path: rel, content: readFileSync(join(dir, ...rel.split("/")), "utf8") }));
    if (!files.length) return { ok: false, error: `local skill ${JSON.stringify(id)} has no files` };
    return { ok: true, item: { kind, id, files } };
  }
  if (kind === "rule") {
    const p = join(local, RULES, `${id}.md`);
    if (!existsSync(p)) return { ok: false, error: `no local rule ${JSON.stringify(id)} in ${join(local, RULES)}` };
    return { ok: true, item: { kind, id, content: readFileSync(p, "utf8") } };
  }
  const p = join(local, MCP, `${id}.json`);
  if (!existsSync(p)) return { ok: false, error: `no local mcp server ${JSON.stringify(id)} in ${join(local, MCP)}` };
  try {
    return { ok: true, item: { kind, id, config: JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown> } };
  } catch (e) {
    return { ok: false, error: `local mcp config ${id} is not valid JSON: ${(e as Error).message}` };
  }
}

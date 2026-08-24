import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { PushItem } from "../proto/index.js";
import { parseProfile } from "../proto/index.js";

// Adoption: move an item out of the pending inbox and into the profile (docs/design.md §5).
//
// This is the first and only place cc-fleet WRITES the profile — until now it has been a file only
// humans edit. That makes two things load-bearing: the write must not clobber a concurrent hand
// edit, and the version must be bumped, or nodes will never notice the change.

export type AdoptResult =
  | { ok: true; version: number; group: string; replaced: boolean }
  | { ok: false; error: string };

export function adoptIntoProfile(profilePath: string, group: string, item: PushItem): AdoptResult {
  if (!existsSync(profilePath)) return { ok: false, error: `profile not found: ${profilePath}` };

  let raw: unknown;
  try { raw = JSON.parse(readFileSync(profilePath, "utf8")); }
  catch (e) { return { ok: false, error: `profile is not valid JSON: ${(e as Error).message}` }; }

  // Validate the CURRENT file before touching it. Adopting into a profile that is already broken
  // would bury the operator's real problem under a second one.
  const parsed = parseProfile(raw);
  if (!parsed.ok) return { ok: false, error: `profile is invalid, fix it first: ${parsed.error}` };
  if (!(group in parsed.profile.groups)) {
    return { ok: false, error: `unknown group ${JSON.stringify(group)} — profile has: ${Object.keys(parsed.profile.groups).join(", ")}` };
  }

  // Edit the RAW object, not the parsed one: zod fills in defaults, so writing the parsed shape back
  // would silently materialise fields the human never wrote and reformat their file.
  const doc = raw as Record<string, any>;
  const target = doc.groups[group];
  const bucket = item.kind === "skill" ? "skills" : item.kind === "rule" ? "rules" : "mcpServers";
  if (!Array.isArray(target[bucket])) target[bucket] = [];

  const entry =
    item.kind === "skill" ? { id: item.id, files: item.files }
    : item.kind === "rule" ? { id: item.id, content: item.content }
    : { id: item.id, config: item.config };

  const existingIndex = target[bucket].findIndex((x: { id?: string }) => x?.id === item.id);
  const replaced = existingIndex >= 0;
  if (replaced) target[bucket][existingIndex] = entry;
  else target[bucket].push(entry);

  // Nodes compare versions, so an adoption that forgot this would sit in the profile doing nothing.
  const version = Number(doc.version) + 1;
  doc.version = version;

  // Re-validate what we are about to write. If adoption would produce a profile the hub itself would
  // refuse to serve, fail now rather than writing it and going quiet.
  const after = parseProfile(doc);
  if (!after.ok) return { ok: false, error: `adoption would produce an invalid profile: ${after.error}` };

  // Atomic: the hub watches this path, and a half-written profile is exactly what the store's
  // last-good-profile guard exists to survive — no reason to hand it one on purpose.
  const tmp = `${profilePath}.adopt.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
  renameSync(tmp, profilePath);

  return { ok: true, version, group, replaced };
}

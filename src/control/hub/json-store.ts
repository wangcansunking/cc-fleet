import { existsSync, mkdirSync, renameSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

// Small durable-JSON helpers shared by the hub's on-disk records (devices, device-auth).
//
// They live in their own module rather than inside whichever record happened to need them first, so
// that deleting a feature does not take the storage primitives with it.

// Atomic JSON write: a half-written registry would cost every device its enrolment. Write a sibling
// temp file, then rename — rename is atomic on both POSIX and Windows (same volume).
export function writeJsonAtomic(dir: string, name: string, data: unknown): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const target = join(dir, name);
  const tmp = join(dir, `.${name}.tmp`);
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  try { renameSync(tmp, target); }
  catch (e) { try { unlinkSync(tmp); } catch { /* ignore */ } throw e; }
}

export function readJson<T>(dir: string, name: string, fallback: T): T {
  const target = join(dir, name);
  if (!existsSync(target)) return fallback;
  try { return JSON.parse(readFileSync(target, "utf8")) as T; } catch { return fallback; }
}

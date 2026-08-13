import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./paths.js";

export const CRASH_LOG_NAME = "crash.log";
// Cap the log so a high-frequency error source can't fill the disk: at the limit we roll the file to
// `crash.log.1` (one generation kept) and start fresh. Sized small — this is a diagnostics tail, not
// an archive.
export const CRASH_LOG_MAX_BYTES = 1_000_000;

function rollIfTooBig(path: string): void {
  try {
    if (statSync(path).size >= CRASH_LOG_MAX_BYTES) renameSync(path, `${path}.1`);
  } catch { /* file absent or stat/rename raced — nothing to roll */ }
}

// Append one diagnostics line to ~/.cc-fleet/crash.log. Best-effort and never throws: logging
// must never itself crash a backstop or a swallowed-error path. Rotates at CRASH_LOG_MAX_BYTES. The
// dir is injectable for tests; production uses the real data dir.
export function appendCrashLog(kind: string, err: unknown, dir: string = dataDir()): void {
  const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
  try {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, CRASH_LOG_NAME);
    rollIfTooBig(path);
    appendFileSync(path, `[${new Date().toISOString()}] ${kind}: ${detail}\n`);
  } catch { /* logging is best-effort */ }
}

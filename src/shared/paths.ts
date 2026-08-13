import { homedir } from "node:os";
import { join } from "node:path";

// Data dir is DELIBERATELY distinct from copilot-reverse's `~/.copilot-reverse`. cc-fleet is a
// superset successor, not a drop-in replacement: a machine may still have copilot-reverse installed,
// and two products sharing one dir would fight over the same GitHub token, network.json and db.
// Cost of the split: a hub that already ran copilot-reverse must re-login once. M1 adds a first-run
// import of the legacy token so that cost goes away.
export function dataDir(home: string = homedir()): string {
  return join(home, ".cc-fleet");
}
export function dbPath(home?: string): string {
  return join(dataDir(home), "cc-fleet.db");
}
export function configPath(home?: string): string {
  return join(dataDir(home), "config.json");
}

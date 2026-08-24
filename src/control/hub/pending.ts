import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PushItem } from "../proto/index.js";

// The hub's inbox for things nodes have offered (docs/design.md §5).
//
// A pushed item lands HERE, not in the profile. Adoption is a separate, human act — auto-adopting
// would let any node broadcast executable instructions to the entire fleet, which is §9's RCE risk
// running upstream and considerably harder to notice than a hub operator editing a profile.

const DIR = "pending";

export interface PendingEntry {
  deviceId: string;
  item: PushItem;
  receivedAt: number;
}

const pendingDir = (dataDir: string): string => join(dataDir, DIR);

// One flat file per (device, kind, id). The filename is sanitised and the parts are also stored
// INSIDE the file, so a hostile id can at worst produce an oddly-named file — never a path that
// escapes the inbox, and never a lost association between an item and the device that sent it.
const safe = (s: string): string => s.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
const fileFor = (dataDir: string, deviceId: string, kind: string, id: string): string =>
  join(pendingDir(dataDir), `${safe(deviceId)}__${safe(kind)}__${safe(id)}.json`);

export class PendingQueue {
  constructor(private readonly dataDir: string, private readonly now: () => number = Date.now) {}

  // Returns false when the item is malformed. A push is data from a machine that may itself be
  // compromised, so it is validated before being written anywhere.
  offer(deviceId: string, item: PushItem): boolean {
    if (!deviceId || !item?.id) return false;
    if (item.id.includes("/") || item.id.includes("\\") || item.id === "." || item.id === "..") return false;
    if (item.kind === "skill") {
      if (!item.files.length) return false;
      // The same containment rule the agent applies on the way down. Catching it here means the hub
      // operator never sees an item in the inbox that could not have been adopted anyway.
      for (const f of item.files) {
        if (!f.path || f.path.includes("\\") || f.path.startsWith("/") || /^[a-zA-Z]:/.test(f.path)) return false;
        if (f.path.split("/").includes("..")) return false;
      }
    }
    const dir = pendingDir(this.dataDir);
    mkdirSync(dir, { recursive: true });
    const entry: PendingEntry = { deviceId, item, receivedAt: this.now() };
    const target = fileFor(this.dataDir, deviceId, item.kind, item.id);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify(entry, null, 2), { mode: 0o600 });
    renameSync(tmp, target); // atomic: a half-written entry must never be adoptable
    return true;
  }

  list(): PendingEntry[] {
    const dir = pendingDir(this.dataDir);
    if (!existsSync(dir)) return [];
    const out: PendingEntry[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const e = JSON.parse(readFileSync(join(dir, name), "utf8")) as PendingEntry;
        if (e?.deviceId && e?.item?.id) out.push(e);
      } catch { /* a corrupt entry is skipped, never fatal to the listing */ }
    }
    return out.sort((a, b) => a.receivedAt - b.receivedAt);
  }

  find(deviceId: string, kind: string, id: string): PendingEntry | null {
    const p = fileFor(this.dataDir, deviceId, kind, id);
    if (!existsSync(p)) return null;
    try { return JSON.parse(readFileSync(p, "utf8")) as PendingEntry; } catch { return null; }
  }

  /** Returns false for something that was not there, rather than reporting a success that did nothing. */
  drop(deviceId: string, kind: string, id: string): boolean {
    const p = fileFor(this.dataDir, deviceId, kind, id);
    if (!existsSync(p)) return false;
    rmSync(p, { force: true });
    return true;
  }
}

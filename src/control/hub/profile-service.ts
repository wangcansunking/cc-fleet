import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { desiredStateFor, parseProfile, type ClientChoice, type DesiredState, type Profile, type PushItem } from "../proto/index.js";

const DRAFT_FILE = "profile.draft.json";
const LOCK_FILE = "profile.lock.json";
const HISTORY_DIR = "profile-history";
const KEEP_HISTORY = 20;

export type ProfileFailure = { ok: false; code: "invalid_profile" | "revision_conflict" | "not_found"; error: string };
export type LiveProfile = { ok: true; profile: Profile; revision: string } | ProfileFailure;
export type DraftProfile = {
  exists: boolean;
  valid?: boolean;
  profile?: Profile;
  baseRevision?: string;
  revision?: string;
  error?: string;
};
export interface ItemDiff { added: string[]; removed: string[]; changed: string[] }
export interface DeviceDiff {
  deviceId: string;
  beforeAssigned: boolean;
  afterAssigned: boolean;
  skills: ItemDiff;
  rules: ItemDiff;
  mcpServers: ItemDiff;
  clients: {
    claude?: { before?: string; after?: string };
    codex?: { before?: string; after?: string };
  };
}
export interface HistoryEntry { id: string; version: number; savedAt: number }

interface DraftFile { baseRevision: string; profile: unknown }
export interface ProfileServiceHooks { beforeReplace?: () => void }

function revisionOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
function stamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}
function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}
function conditionalReplace(path: string, text: string, expectedRevision: string, beforeCommit?: () => void): boolean {
  const candidate = `${path}.candidate`;
  const guard = `${path}.guard`;
  rmSync(candidate, { force: true });
  rmSync(guard, { force: true });
  try {
    // Pin the exact inode BEFORE preparing the candidate. Editors that rename a new file into place
    // leave guard on the old inode; in-place writers change guard's bytes. Re-checking both identity
    // and bytes immediately before rename catches both forms without a stale-snapshot overwrite.
    linkSync(path, guard);
    writeFileSync(candidate, text, { mode: 0o600 });
    beforeCommit?.();
    const guarded = readFileSync(guard, "utf8");
    const live = readFileSync(path, "utf8");
    const sameInode = statSync(guard).ino === statSync(path).ino;
    if (!sameInode || revisionOf(guarded) !== expectedRevision || revisionOf(live) !== expectedRevision) return false;
    renameSync(candidate, path);
    return true;
  } finally {
    try { unlinkSync(guard); } catch { /* absent guard */ }
    rmSync(candidate, { force: true });
  }
}
function ids<T extends { id: string }>(items: T[] | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const item of items ?? []) out.set(item.id, JSON.stringify(item));
  return out;
}
function itemDiff<T extends { id: string }>(before: T[] | undefined, after: T[] | undefined): ItemDiff {
  const a = ids(before), b = ids(after);
  return {
    added: [...b.keys()].filter((id) => !a.has(id)).sort(),
    removed: [...a.keys()].filter((id) => !b.has(id)).sort(),
    changed: [...a.keys()].filter((id) => b.has(id) && a.get(id) !== b.get(id)).sort(),
  };
}
function clientModel(state: DesiredState | null, key: "claude" | "codex"): string | undefined {
  return state?.clients?.[key]?.model;
}
function clientDiff(before: ClientChoice | undefined, after: ClientChoice | undefined): { before?: string; after?: string } | undefined {
  if (JSON.stringify(before) === JSON.stringify(after)) return undefined;
  return { before: before?.model, after: after?.model };
}

export class ProfileService {
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly dataDir: string,
    private readonly profilePath: string,
    private readonly now: () => Date = () => new Date(),
    private readonly hooks: ProfileServiceHooks = {},
  ) {}

  private serial<T>(operation: () => Promise<T> | T): Promise<T> {
    const run = this.mutationQueue.then(operation, operation);
    this.mutationQueue = run.then(() => {}, () => {});
    return run;
  }

  private beginMutation(expectedRevision: string): LiveProfile {
    mkdirSync(this.dataDir, { recursive: true });
    const path = join(this.dataDir, LOCK_FILE);
    try {
      writeFileSync(path, JSON.stringify({ expectedRevision, createdAt: Date.now() }), { mode: 0o600, flag: "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") {
        return { ok: false, code: "revision_conflict", error: "another profile mutation is in progress" };
      }
      throw e;
    }
    const live = this.readLive();
    if (!live.ok) { this.endMutation(); return live; }
    if (live.revision !== expectedRevision) {
      this.endMutation();
      return { ok: false, code: "revision_conflict", error: "live profile changed; reload before mutating" };
    }
    return live;
  }

  private endMutation(): void {
    rmSync(join(this.dataDir, LOCK_FILE), { force: true });
  }

  private cleanupStaleLock(): void {
    const path = join(this.dataDir, LOCK_FILE);
    if (!existsSync(path)) return;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as { createdAt?: number };
      if (typeof raw.createdAt === "number" && Date.now() - raw.createdAt < 60_000) return;
    } catch { /* malformed locks are stale */ }
    rmSync(path, { force: true });
  }

  readLive(): LiveProfile {
    if (!existsSync(this.profilePath)) return { ok: false, code: "not_found", error: `profile not found: ${this.profilePath}` };
    let text: string;
    try { text = readFileSync(this.profilePath, "utf8"); }
    catch (e) { return { ok: false, code: "not_found", error: `profile unreadable: ${(e as Error).message}` }; }
    let raw: unknown;
    try { raw = JSON.parse(text); }
    catch (e) { return { ok: false, code: "invalid_profile", error: `profile is not valid JSON: ${(e as Error).message}` }; }
    const parsed = parseProfile(raw);
    if (!parsed.ok) return { ok: false, code: "invalid_profile", error: parsed.error };
    return { ok: true, profile: parsed.profile, revision: revisionOf(text) };
  }

  readDraft(): DraftProfile {
    const path = join(this.dataDir, DRAFT_FILE);
    if (!existsSync(path)) return { exists: false };
    try {
      const text = readFileSync(path, "utf8");
      const raw = JSON.parse(text) as DraftFile;
      const parsed = parseProfile(raw.profile);
      if (!parsed.ok) return { exists: true, valid: false, baseRevision: raw.baseRevision, error: parsed.error };
      return { exists: true, valid: true, baseRevision: raw.baseRevision, profile: parsed.profile, revision: revisionOf(text) };
    } catch (e) {
      return { exists: true, valid: false, error: (e as Error).message };
    }
  }

  saveDraft(raw: unknown, baseRevision: string): { ok: true; revision: string } | ProfileFailure {
    const live = this.readLive();
    if (!live.ok) return live;
    if (live.revision !== baseRevision) return { ok: false, code: "revision_conflict", error: "live profile changed; reload before saving this draft" };
    const parsed = parseProfile(raw);
    if (!parsed.ok) return { ok: false, code: "invalid_profile", error: parsed.error };
    mkdirSync(this.dataDir, { recursive: true });
    const text = `${JSON.stringify({ baseRevision, profile: raw }, null, 2)}\n`;
    atomicWrite(join(this.dataDir, DRAFT_FILE), text);
    return { ok: true, revision: revisionOf(text) };
  }

  previewDraft(): { ok: true; devices: DeviceDiff[] } | ProfileFailure {
    const live = this.readLive();
    if (!live.ok) return live;
    const draft = this.readDraft();
    if (!draft.exists || !draft.valid || !draft.profile) return { ok: false, code: "not_found", error: draft.error ?? "no valid draft" };
    const names = new Set([
      ...Object.keys(live.profile.assignments), ...Object.keys(draft.profile.assignments),
      ...Object.keys(live.profile.devices), ...Object.keys(draft.profile.devices),
    ]);
    const devices = [...names].sort().map((deviceId): DeviceDiff => {
      const before = desiredStateFor(live.profile, deviceId);
      const after = desiredStateFor(draft.profile!, deviceId);
      return {
        deviceId, beforeAssigned: before !== null, afterAssigned: after !== null,
        skills: itemDiff(before?.skills, after?.skills),
        rules: itemDiff(before?.rules, after?.rules),
        mcpServers: itemDiff(before?.mcpServers, after?.mcpServers),
        clients: {
          ...(clientDiff(before?.clients?.claude, after?.clients?.claude) ? { claude: clientDiff(before?.clients?.claude, after?.clients?.claude) } : {}),
          ...(clientDiff(before?.clients?.codex, after?.clients?.codex) ? { codex: clientDiff(before?.clients?.codex, after?.clients?.codex) } : {}),
        },
      };
    });
    return { ok: true, devices };
  }

  publishDraft(expectedRevision: string): Promise<{ ok: true; version: number; revision: string } | ProfileFailure> {
    return this.serial(() => {
      this.cleanupStaleLock();
      const live = this.beginMutation(expectedRevision);
      if (!live.ok) return live;
      try {
        const draft = this.readDraft();
        if (!draft.exists || !draft.valid || !draft.profile) return { ok: false, code: "not_found", error: draft.error ?? "no valid draft" } as ProfileFailure;
        if (draft.baseRevision !== expectedRevision) return { ok: false, code: "revision_conflict", error: "draft was based on an older live profile" } as ProfileFailure;
        return this.publishProfile(draft.profile, live, true);
      } finally { this.endMutation(); }
    });
  }

  adopt(group: string, item: PushItem, expectedRevision: string): Promise<{ ok: true; version: number; revision: string; replaced: boolean } | ProfileFailure> {
    return this.serial(() => this.withMutation(expectedRevision, (live) => {
      if (!(group in live.profile.groups)) return { ok: false, code: "invalid_profile", error: `unknown group ${group}` } as ProfileFailure;
      const next = structuredClone(live.profile) as Profile;
      const target = next.groups[group];
      const bucket = item.kind === "skill" ? target.skills : item.kind === "rule" ? target.rules : target.mcpServers;
      const entry: any = item.kind === "skill" ? { id: item.id, files: item.files }
        : item.kind === "rule" ? { id: item.id, content: item.content }
          : { id: item.id, config: item.config };
      const index = bucket.findIndex((x) => x.id === item.id);
      const replaced = index >= 0;
      if (replaced) (bucket as any[])[index] = entry; else (bucket as any[]).push(entry);
      const published = this.publishProfile(next, live, false);
      return published.ok ? { ...published, replaced } : published;
    }));
  }

  private withMutation<T>(expectedRevision: string, operation: (live: Extract<LiveProfile, { ok: true }>) => T): T | ProfileFailure {
    this.cleanupStaleLock();
    const live = this.beginMutation(expectedRevision);
    if (!live.ok) return live;
    try { return operation(live); }
    finally { this.endMutation(); }
  }

  listHistory(): HistoryEntry[] {
    const dir = join(this.dataDir, HISTORY_DIR);
    if (!existsSync(dir)) return [];
    const out: HistoryEntry[] = [];
    for (const id of readdirSync(dir).filter((x) => x.endsWith(".json")).sort().reverse()) {
      const path = join(dir, id);
      try {
        const raw = JSON.parse(readFileSync(path, "utf8")) as { version?: number };
        out.push({ id, version: Number(raw.version) || 0, savedAt: statSync(path).mtimeMs });
      } catch { /* corrupt history is not rollbackable */ }
    }
    return out;
  }

  rollback(historyId: string, expectedRevision: string): Promise<{ ok: true; version: number; revision: string } | ProfileFailure> {
    return this.serial(() => {
      if (!/^[A-Za-z0-9._-]+\.json$/.test(historyId)) return { ok: false, code: "not_found", error: "invalid history id" } as ProfileFailure;
      this.cleanupStaleLock();
      const live = this.beginMutation(expectedRevision);
      if (!live.ok) return live;
      try {
        const path = join(this.dataDir, HISTORY_DIR, historyId);
        if (!existsSync(path)) return { ok: false, code: "not_found", error: "profile history entry not found" } as ProfileFailure;
        let raw: unknown;
        try { raw = JSON.parse(readFileSync(path, "utf8")); }
        catch { return { ok: false, code: "invalid_profile", error: "profile history entry is corrupt" } as ProfileFailure; }
        const parsed = parseProfile(raw);
        if (!parsed.ok) return { ok: false, code: "invalid_profile", error: parsed.error } as ProfileFailure;
        return this.publishProfile(parsed.profile, live, false);
      } finally { this.endMutation(); }
    });
  }

  private publishProfile(profile: Profile, live: Extract<LiveProfile, { ok: true }>, clearDraft: boolean) {
    const next = { ...profile, version: live.profile.version + 1 };
    const valid = parseProfile(next);
    if (!valid.ok) return { ok: false as const, code: "invalid_profile" as const, error: valid.error };
    const text = `${JSON.stringify(next, null, 2)}\n`;
    const replaced = conditionalReplace(this.profilePath, text, live.revision, this.hooks.beforeReplace);
    if (!replaced) {
      return { ok: false as const, code: "revision_conflict" as const, error: "live profile changed during mutation; nothing was overwritten" };
    }
    const historyDir = join(this.dataDir, HISTORY_DIR);
    mkdirSync(historyDir, { recursive: true });
    let history = join(historyDir, `${stamp(this.now())}-v${live.profile.version}.json`);
    for (let n = 2; existsSync(history); n++) history = join(historyDir, `${stamp(this.now())}-v${live.profile.version}-${n}.json`);
    atomicWrite(history, `${JSON.stringify(live.profile, null, 2)}\n`);
    if (clearDraft) rmSync(join(this.dataDir, DRAFT_FILE), { force: true });
    for (const old of this.listHistory().slice(KEEP_HISTORY)) rmSync(join(historyDir, old.id), { force: true });
    return { ok: true as const, version: next.version, revision: revisionOf(text) };
  }
}

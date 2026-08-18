import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { parseProfile, type Profile } from "../proto/index.js";

export type LoadResult = { ok: true; profile: Profile } | { ok: false; error: string };

export interface ProfileStoreOptions {
  // fs.watch fires more than once for a single logical save (editors write-then-rename, and some
  // platforms emit both "rename" and "change"). Coalesce the burst so one edit is one broadcast.
  debounceMs?: number;
}

// The hub's source of truth: a hand-written profile.json (docs/design.md §11 — the graphical editor
// is M4).
//
// The load-bearing behaviour here is that a BAD profile never becomes the served state. Apply is
// full-takeover, so broadcasting a half-saved or typo'd profile would delete managed files on every
// node. On any failure the store keeps serving the last profile that parsed, and reports why.
export class ProfileStore {
  private profile: Profile | null = null;
  private lastText: string | null = null;
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private closed = false;
  private readonly handlers = new Set<(p: Profile) => void>();
  private readonly debounceMs: number;

  constructor(private readonly path: string, opts: ProfileStoreOptions = {}) {
    this.debounceMs = opts.debounceMs ?? 200;
  }

  // The last profile that parsed, or null if none ever has.
  current(): Profile | null {
    return this.profile;
  }

  load(): LoadResult {
    if (!existsSync(this.path)) return { ok: false, error: `profile not found: ${this.path}` };
    let text: string;
    try { text = readFileSync(this.path, "utf8"); }
    catch (e) { return { ok: false, error: `profile unreadable: ${(e as Error).message}` }; }
    let raw: unknown;
    try { raw = JSON.parse(text); }
    catch (e) { return { ok: false, error: `profile is not valid JSON: ${(e as Error).message}` }; }
    const parsed = parseProfile(raw);
    if (!parsed.ok) return parsed;
    this.profile = parsed.profile;
    this.lastText = text;
    return { ok: true, profile: parsed.profile };
  }

  onChange(handler: (p: Profile) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  // Watch the file for edits. Watching the FILE (not the directory) is enough for the M1 workflow
  // (`$EDITOR ~/.cc-fleet/profile.json`), and a rename-based save still surfaces as an event on most
  // platforms; the debounce below absorbs the duplicates.
  watch(): void {
    if (this.watcher || this.closed || !existsSync(this.path)) return;
    this.watcher = watch(this.path, () => this.schedule());
    // A watcher error (file replaced, volume unmounted) must not take down the hub process.
    this.watcher.on("error", () => { this.watcher?.close(); this.watcher = null; });
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.closed) return;
      const before = this.lastText;
      const r = this.load();
      // Notify only on a successful load of genuinely NEW content.
      //
      // Two guards, for two different failures. A failed reload leaves `current()` untouched, so
      // subscribers never see a regression to a partial state. And a reload whose bytes are identical
      // to the last one is not a change at all — fs.watch fires repeatedly for a single logical save
      // (write-then-rename; some platforms emit both "rename" and "change"), and those bursts can
      // straddle the debounce window, so without this a plain `touch` fans a pointless apply out to
      // every node in the fleet.
      if (!r.ok || this.lastText === before) return;
      for (const h of [...this.handlers]) {
        try { h(r.profile); } catch { /* a bad subscriber must not stop the others */ }
      }
    }, this.debounceMs);
    this.timer.unref?.(); // never hold the process open on a pending debounce
  }

  close(): void {
    this.closed = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.watcher?.close();
    this.watcher = null;
    this.handlers.clear();
  }
}

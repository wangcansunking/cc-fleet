import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONTROL_PORT, startControlHub } from "../../src/control/hub/index.js";
import { ProfileStore } from "../../src/control/hub/profile-store.js";

const dir = () => mkdtempSync(join(tmpdir(), "ccdata-"));
const good = {
  version: 1,
  groups: { full: { skills: [{ id: "s", files: [{ path: "SKILL.md", content: "x" }] }] } },
  assignments: { "laptop-home": "full" },
};
const write = (d: string, data: unknown) =>
  writeFileSync(join(d, "profile.json"), typeof data === "string" ? data : JSON.stringify(data));

describe("Control Hub listener", () => {
  it("defaults to the cc-fleet control port", async () => {
    const d = dir();
    const hub = await startControlHub({ dataDir: d, host: "127.0.0.1" });
    try {
      expect(DEFAULT_CONTROL_PORT).toBe(7992);
      expect(hub.port).toBe(7992);
    } finally {
      hub.close();
    }
  });

  it("keeps an explicit port override", async () => {
    const d = dir();
    const hub = await startControlHub({ dataDir: d, port: 0, host: "127.0.0.1" });
    try {
      expect(hub.port).not.toBe(7992);
      expect(hub.port).toBeGreaterThan(0);
    } finally {
      hub.close();
    }
  });
});

describe("ProfileStore", () => {
  it("loads and validates a profile from disk", () => {
    const d = dir();
    write(d, good);
    const store = new ProfileStore(join(d, "profile.json"));
    expect(store.load().ok).toBe(true);
    expect(store.current()?.version).toBe(1);
    store.close();
  });

  it("reports no profile (rather than throwing) when the file is absent", () => {
    const store = new ProfileStore(join(dir(), "profile.json"));
    const r = store.load();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/not found|no such/i);
    expect(store.current()).toBeNull();
    store.close();
  });

  it("keeps serving the last good profile when a later edit is invalid", () => {
    // A half-saved or typo'd profile must never become the broadcast desired state: apply is
    // full-takeover, so an "empty" profile would wipe every node.
    const d = dir();
    write(d, good);
    const store = new ProfileStore(join(d, "profile.json"));
    store.load();
    write(d, { version: 2, groups: {} }); // missing assignments
    const r = store.load();
    expect(r.ok).toBe(false);
    expect(store.current()?.version).toBe(1); // unchanged
    store.close();
  });

  it("keeps serving the last good profile when the file becomes unparseable JSON", () => {
    const d = dir();
    write(d, good);
    const store = new ProfileStore(join(d, "profile.json"));
    store.load();
    write(d, "{ not json");
    expect(store.load().ok).toBe(false);
    expect(store.current()?.version).toBe(1);
    store.close();
  });

  it("keeps serving the last good profile when the file is deleted", () => {
    const d = dir();
    write(d, good);
    const store = new ProfileStore(join(d, "profile.json"));
    store.load();
    rmSync(join(d, "profile.json"));
    expect(store.load().ok).toBe(false);
    expect(store.current()?.version).toBe(1);
    store.close();
  });

  it("notifies subscribers when a valid edit lands", async () => {
    const d = dir();
    write(d, good);
    const store = new ProfileStore(join(d, "profile.json"), { debounceMs: 5 });
    store.load();
    const seen = vi.fn();
    store.onChange(seen);
    store.watch();
    write(d, { ...good, version: 2 });
    await vi.waitFor(() => expect(seen).toHaveBeenCalled(), { timeout: 3000 });
    expect(store.current()?.version).toBe(2);
    store.close();
  });

  it("does not notify subscribers for an invalid edit", async () => {
    const d = dir();
    write(d, good);
    const store = new ProfileStore(join(d, "profile.json"), { debounceMs: 5 });
    store.load();
    const seen = vi.fn();
    store.onChange(seen);
    store.watch();
    write(d, "{ broken");
    await new Promise((r) => setTimeout(r, 200));
    expect(seen).not.toHaveBeenCalled();
    expect(store.current()?.version).toBe(1);
    store.close();
  });

  it("keeps noticing edits when the file is REPLACED, not written in place", async () => {
    // How every real editor saves: write a temp file, rename over the target. `sed -i` does it too.
    // Watching the FILE binds to an inode that the rename discards, so the hub would see the first
    // edit and then go permanently deaf — the fleet silently stops receiving changes, and nothing
    // anywhere reports an error. Found by the two-container docker e2e, which edits with sed.
    const d = dir();
    write(d, good);
    const store = new ProfileStore(join(d, "profile.json"), { debounceMs: 5 });
    store.load();
    const seen = vi.fn();
    store.onChange(seen);
    store.watch();

    const replace = (data: unknown) => {
      const tmp = join(d, "profile.next.json");
      writeFileSync(tmp, JSON.stringify(data));
      renameSync(tmp, join(d, "profile.json"));
    };

    replace({ ...good, version: 2 });
    await vi.waitFor(() => expect(store.current()?.version).toBe(2), { timeout: 3000 });

    // The second replace is the one that actually fails when the watch is bound to the old inode.
    replace({ ...good, version: 3 });
    await vi.waitFor(() => expect(store.current()?.version).toBe(3), { timeout: 3000 });

    replace({ ...good, version: 4 });
    await vi.waitFor(() => expect(store.current()?.version).toBe(4), { timeout: 3000 });
    store.close();
  });

  it("starts watching even when the profile does not exist yet", async () => {
    // A hub can boot before anyone writes a profile. Binding the watch to a missing file would mean
    // it never starts, and the first profile would need a hub restart to be noticed.
    const d = dir();
    const store = new ProfileStore(join(d, "profile.json"), { debounceMs: 5 });
    store.load(); // fails: no file
    const seen = vi.fn();
    store.onChange(seen);
    store.watch();
    write(d, good);
    await vi.waitFor(() => expect(seen).toHaveBeenCalled(), { timeout: 3000 });
    expect(store.current()?.version).toBe(1);
    store.close();
  });

  it("stops notifying after close", async () => {
    const d = dir();
    write(d, good);
    const store = new ProfileStore(join(d, "profile.json"), { debounceMs: 5 });
    store.load();
    const seen = vi.fn();
    store.onChange(seen);
    store.watch();
    store.close();
    write(d, { ...good, version: 3 });
    await new Promise((r) => setTimeout(r, 200));
    expect(seen).not.toHaveBeenCalled();
  });

  it("does not notify when a write leaves the content identical", async () => {
    // fs.watch fires more than once for a single logical save (write-then-rename, plus platforms that
    // emit both "rename" and "change"), and bursts can straddle the debounce window. Without a
    // content check, one `touch` fans a pointless broadcast out to the entire fleet.
    const d = dir();
    write(d, good);
    const store = new ProfileStore(join(d, "profile.json"), { debounceMs: 5 });
    store.load();
    const seen = vi.fn();
    store.onChange(seen);
    store.watch();
    write(d, good); // byte-identical rewrite
    await new Promise((r) => setTimeout(r, 200));
    expect(seen).not.toHaveBeenCalled();
    store.close();
  });

  it("still notifies when the content really changed after an identical write", async () => {
    const d = dir();
    write(d, good);
    const store = new ProfileStore(join(d, "profile.json"), { debounceMs: 5 });
    store.load();
    const seen = vi.fn();
    store.onChange(seen);
    store.watch();
    write(d, good);
    await new Promise((r) => setTimeout(r, 60));
    write(d, { ...good, version: 5 });
    await vi.waitFor(() => expect(seen).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(store.current()?.version).toBe(5);
    store.close();
  });
});


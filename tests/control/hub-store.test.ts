import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileStore } from "../../src/control/hub/profile-store.js";
import { readHubToken, ensureHubToken, isAuthorized } from "../../src/control/hub/auth.js";

const dir = () => mkdtempSync(join(tmpdir(), "ccdata-"));
const good = {
  version: 1,
  groups: { full: { skills: [{ id: "s", files: [{ path: "SKILL.md", content: "x" }] }] } },
  assignments: { "laptop-home": "full" },
};
const write = (d: string, data: unknown) =>
  writeFileSync(join(d, "profile.json"), typeof data === "string" ? data : JSON.stringify(data));

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

describe("hub auth", () => {
  it("has no token until one is minted", () => {
    expect(readHubToken(dir())).toBeNull();
  });

  it("mints and persists a token, and reuses it on the next call", () => {
    const d = dir();
    const first = ensureHubToken(d);
    expect(first.length).toBeGreaterThan(20);
    expect(ensureHubToken(d)).toBe(first);
    expect(readHubToken(d)).toBe(first);
  });

  it("lets FLEET_TOKEN override disk, matching how ACCESS_KEY works for the worker", () => {
    const d = dir();
    ensureHubToken(d);
    vi.stubEnv("FLEET_TOKEN", "from-env");
    expect(readHubToken(d)).toBe("from-env");
    vi.unstubAllEnvs();
  });

  it("fails closed: with no token configured, nothing is authorized", () => {
    // The control channel can rewrite what a machine executes. An unconfigured hub must refuse
    // everything rather than serve desired state to anyone who connects.
    const d = dir();
    expect(isAuthorized(d, "Bearer anything")).toBe(false);
    expect(isAuthorized(d, undefined)).toBe(false);
  });

  it("accepts only the exact bearer token", () => {
    const d = dir();
    const token = ensureHubToken(d);
    expect(isAuthorized(d, `Bearer ${token}`)).toBe(true);
    expect(isAuthorized(d, token)).toBe(false);          // scheme required
    expect(isAuthorized(d, `Bearer ${token}x`)).toBe(false);
    expect(isAuthorized(d, `Bearer ${token.slice(0, -1)}`)).toBe(false);
    expect(isAuthorized(d, "Bearer ")).toBe(false);
    expect(isAuthorized(d, undefined)).toBe(false);
  });
});

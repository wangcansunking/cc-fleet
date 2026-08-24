import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshot, listBackups, pruneBackups, restoreLatest, backupsDir } from "../../src/control/agent/backup.js";
import { applyFleet } from "../../src/control/agent/apply.js";
import { fleetDir } from "../../src/control/agent/store.js";
import type { DesiredState } from "../../src/control/proto/index.js";

const home = () => mkdtempSync(join(tmpdir(), "agents-"));
const skill = (id: string, files: Record<string, string>) => ({
  id, files: Object.entries(files).map(([path, content]) => ({ path, content })),
});
const state = (...skills: ReturnType<typeof skill>[]): DesiredState => ({ skills, rules: [] });
const seedFleet = (h: string, id: string, name: string, content: string) => {
  mkdirSync(join(fleetDir(h), "skills", id), { recursive: true });
  writeFileSync(join(fleetDir(h), "skills", id, name), content);
};
const read = (...p: string[]) => readFileSync(join(...p), "utf8");

describe("snapshot", () => {
  it("copies each source tree into one timestamped backup, keyed by its name", () => {
    const h = home();
    seedFleet(h, "a", "SKILL.md", "one");
    const other = mkdtempSync(join(tmpdir(), "claudeskills-"));
    writeFileSync(join(other, "x.md"), "two");
    const dir = snapshot(h, [fleetDir(h), other]);
    expect(dir).not.toBeNull();
    expect(read(dir!, "fleet", "skills", "a", "SKILL.md")).toBe("one");
    expect(read(dir!, join(other).split(/[\\/]/).pop()!, "x.md")).toBe("two");
  });

  it("returns null when none of the sources exist or hold anything", () => {
    const h = home();
    expect(snapshot(h, [fleetDir(h), join(h, "nope")])).toBeNull();
  });

  it("skips sources that do not exist rather than failing the whole snapshot", () => {
    const h = home();
    seedFleet(h, "a", "SKILL.md", "one");
    const dir = snapshot(h, [fleetDir(h), join(h, "absent")]);
    expect(dir).not.toBeNull();
    expect(existsSync(join(dir!, "absent"))).toBe(false);
  });

  it("uses filenames that are legal on Windows and sort chronologically", () => {
    // A raw ISO timestamp contains ':', which is illegal in a Windows path — a naive name would make
    // every backup throw on the platform this project is developed on.
    const h = home();
    seedFleet(h, "a", "SKILL.md", "x");
    const name = snapshot(h, [fleetDir(h)])!.split(/[\\/]/).pop()!;
    expect(name).not.toMatch(/[:*?"<>|]/);
    expect(name).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("never collides when two snapshots land in the same millisecond", () => {
    const h = home();
    seedFleet(h, "a", "SKILL.md", "x");
    expect(snapshot(h, [fleetDir(h)])).not.toBe(snapshot(h, [fleetDir(h)]));
    expect(listBackups(h)).toHaveLength(2);
  });
});

describe("pruneBackups", () => {
  it("keeps the newest N and deletes the rest", () => {
    const h = home();
    seedFleet(h, "a", "SKILL.md", "x");
    for (let i = 0; i < 13; i++) snapshot(h, [fleetDir(h)]);
    pruneBackups(h, 10);
    expect(listBackups(h)).toHaveLength(10);
  });

  it("lists backups newest-first", () => {
    const h = home();
    seedFleet(h, "a", "SKILL.md", "x");
    const first = snapshot(h, [fleetDir(h)])!;
    const second = snapshot(h, [fleetDir(h)])!;
    expect(listBackups(h)[0]).toBe(second);
    expect(listBackups(h)[1]).toBe(first);
  });

  it("is a no-op with no backups directory", () => {
    const h = home();
    expect(() => pruneBackups(h, 10)).not.toThrow();
    expect(listBackups(h)).toEqual([]);
  });
});

describe("apply + backup integration", () => {
  it("snapshots the PRE-apply state before mutating", () => {
    const h = home();
    seedFleet(h, "stale", "SKILL.md", "about to be deleted");
    applyFleet(h, state(skill("new", { "SKILL.md": "x" })));
    const backups = listBackups(h);
    expect(backups).toHaveLength(1);
    // The safety net is only worth anything if it holds what was destroyed.
    expect(read(backups[0], "fleet", "skills", "stale", "SKILL.md")).toBe("about to be deleted");
  });

  it("does NOT snapshot when the apply changes nothing", () => {
    // The agent re-applies on every reconnect; snapshotting no-ops would flush the 10-slot budget of
    // real pre-change states with identical copies, destroying the rollback window exactly when a
    // flapping connection makes it most valuable.
    const h = home();
    applyFleet(h, state(skill("s", { "SKILL.md": "x" })));
    const after = listBackups(h).length;
    applyFleet(h, state(skill("s", { "SKILL.md": "x" })));
    expect(listBackups(h)).toHaveLength(after);
  });

  it("does not snapshot when the apply is rejected", () => {
    const h = home();
    seedFleet(h, "a", "SKILL.md", "x");
    applyFleet(h, state(skill("bad", { "../out.md": "x" })));
    expect(listBackups(h)).toEqual([]);
  });

  it("keeps only the 10 most recent snapshots across many applies", () => {
    const h = home();
    for (let i = 0; i < 13; i++) applyFleet(h, state(skill("s", { "SKILL.md": `v${i}` })));
    expect(listBackups(h).length).toBeLessThanOrEqual(10);
  });

  it("can be told to skip backups", () => {
    const h = home();
    applyFleet(h, state(skill("s", { "SKILL.md": "x" })), { backup: false });
    expect(listBackups(h)).toEqual([]);
  });

  it("stores backups outside fleet/, so takeover cannot eat them", () => {
    const h = home();
    seedFleet(h, "a", "SKILL.md", "x");
    applyFleet(h, state(skill("b", { "SKILL.md": "y" })));
    expect(backupsDir(h).startsWith(fleetDir(h))).toBe(false);
    applyFleet(h, state(skill("c", { "SKILL.md": "z" })));
    expect(listBackups(h).length).toBeGreaterThanOrEqual(2); // survived a subsequent takeover
  });

  it("also captures the projection targets it is about to overwrite", () => {
    // apply mutates the store, but the SAME operation goes on to overwrite the tool's directory.
    // A backup of only half of that is not a rollback point.
    const h = home();
    const claudeSkills = mkdtempSync(join(tmpdir(), "claudeskills-"));
    writeFileSync(join(claudeSkills, "old.md"), "in the tool");
    applyFleet(h, state(skill("s", { "SKILL.md": "x" })), { alsoBackup: [claudeSkills] });
    const name = claudeSkills.split(/[\\/]/).pop()!;
    expect(read(listBackups(h)[0], name, "old.md")).toBe("in the tool");
  });
});

describe("restoreLatest", () => {
  it("restores a tree from the most recent snapshot that contains it", () => {
    const h = home();
    seedFleet(h, "original", "SKILL.md", "the good state");
    applyFleet(h, state(skill("pushed", { "SKILL.md": "the bad push" })));
    expect(existsSync(join(fleetDir(h), "skills", "original"))).toBe(false);

    expect(restoreLatest(h, fleetDir(h))).not.toBeNull();
    expect(read(fleetDir(h), "skills", "original", "SKILL.md")).toBe("the good state");
    expect(existsSync(join(fleetDir(h), "skills", "pushed"))).toBe(false); // replaced, not merged
  });

  it("returns null when there is nothing to restore", () => {
    const h = home();
    expect(restoreLatest(h, fleetDir(h))).toBeNull();
  });

  it("restores into a store whose tree was deleted entirely", () => {
    const h = home();
    seedFleet(h, "a", "SKILL.md", "x");
    snapshot(h, [fleetDir(h)]);
    applyFleet(h, state(), { backup: false }); // empties the store
    restoreLatest(h, fleetDir(h));
    expect(read(fleetDir(h), "skills", "a", "SKILL.md")).toBe("x");
  });

  it("leaves the node's own half untouched", () => {
    const h = home();
    mkdirSync(join(h, "local", "skills", "mine"), { recursive: true });
    writeFileSync(join(h, "local", "skills", "mine", "SKILL.md"), "my own");
    seedFleet(h, "a", "SKILL.md", "x");
    applyFleet(h, state(skill("b", { "SKILL.md": "y" })));
    restoreLatest(h, fleetDir(h));
    expect(read(h, "local", "skills", "mine", "SKILL.md")).toBe("my own");
  });
});

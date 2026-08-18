import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotSkills, listBackups, pruneBackups, restoreLatest, backupsDir } from "../../src/control/agent/backup.js";
import { applySkills } from "../../src/control/agent/apply.js";
import type { DesiredState } from "../../src/control/proto/index.js";

const home = () => mkdtempSync(join(tmpdir(), "cchome-"));
const skill = (id: string, files: Record<string, string>) => ({
  id, files: Object.entries(files).map(([path, content]) => ({ path, content })),
});
const state = (...skills: ReturnType<typeof skill>[]): DesiredState => ({ skills });
const seed = (h: string, id: string, name: string, content: string) => {
  mkdirSync(join(h, "skills", id), { recursive: true });
  writeFileSync(join(h, "skills", id, name), content);
};

describe("snapshotSkills", () => {
  it("copies the whole skills tree into a timestamped backup", () => {
    const h = home();
    seed(h, "a", "SKILL.md", "one");
    mkdirSync(join(h, "skills", "a", "refs"), { recursive: true });
    writeFileSync(join(h, "skills", "a", "refs", "x.md"), "two");
    const dir = snapshotSkills(h);
    expect(dir).not.toBeNull();
    expect(readFileSync(join(dir!, "skills", "a", "SKILL.md"), "utf8")).toBe("one");
    expect(readFileSync(join(dir!, "skills", "a", "refs", "x.md"), "utf8")).toBe("two");
  });

  it("returns null when there is nothing to back up", () => {
    expect(snapshotSkills(home())).toBeNull();
  });

  it("uses filenames that are legal on Windows and sort chronologically", () => {
    // A raw ISO timestamp contains ':', which is illegal in a Windows path — a naive name would make
    // every backup throw on the platform this project is developed on.
    const h = home();
    seed(h, "a", "SKILL.md", "x");
    const dir = snapshotSkills(h)!;
    const name = dir.split(/[\\/]/).pop()!;
    expect(name).not.toMatch(/[:*?"<>|]/);
    expect(name).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("never collides when two snapshots land in the same millisecond", () => {
    const h = home();
    seed(h, "a", "SKILL.md", "x");
    const first = snapshotSkills(h)!;
    const second = snapshotSkills(h)!;
    expect(second).not.toBe(first);
    expect(listBackups(h)).toHaveLength(2);
  });
});

describe("pruneBackups", () => {
  it("keeps the newest N and deletes the rest", () => {
    const h = home();
    seed(h, "a", "SKILL.md", "x");
    for (let i = 0; i < 13; i++) snapshotSkills(h);
    pruneBackups(h, 10);
    expect(listBackups(h)).toHaveLength(10);
  });

  it("lists backups newest-first", () => {
    const h = home();
    seed(h, "a", "SKILL.md", "x");
    const first = snapshotSkills(h)!;
    const second = snapshotSkills(h)!;
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
    seed(h, "stale", "SKILL.md", "about to be deleted");
    const r = applySkills(h, state(skill("new", { "SKILL.md": "x" })));
    expect(r.ok).toBe(true);
    const backups = listBackups(h);
    expect(backups).toHaveLength(1);
    // The safety net is only worth anything if it holds what was destroyed.
    expect(readFileSync(join(backups[0], "skills", "stale", "SKILL.md"), "utf8")).toBe("about to be deleted");
  });

  it("does NOT snapshot when the apply changes nothing", () => {
    // The agent re-applies on every reconnect; snapshotting no-ops would flush the 10-slot budget of
    // real pre-change states with identical copies, destroying the rollback window exactly when a
    // flapping connection makes it most valuable.
    const h = home();
    applySkills(h, state(skill("s", { "SKILL.md": "x" })));
    const after = listBackups(h).length;
    applySkills(h, state(skill("s", { "SKILL.md": "x" })));
    expect(listBackups(h)).toHaveLength(after);
  });

  it("does not snapshot when the apply is rejected", () => {
    const h = home();
    seed(h, "a", "SKILL.md", "x");
    applySkills(h, state(skill("bad", { "../out.md": "x" })));
    expect(listBackups(h)).toEqual([]);
  });

  it("keeps only the 10 most recent snapshots across many applies", () => {
    const h = home();
    for (let i = 0; i < 13; i++) applySkills(h, state(skill("s", { "SKILL.md": `v${i}` })));
    expect(listBackups(h).length).toBeLessThanOrEqual(10);
  });

  it("can be told to skip backups", () => {
    const h = home();
    applySkills(h, state(skill("s", { "SKILL.md": "x" })), { backup: false });
    expect(listBackups(h)).toEqual([]);
  });

  it("stores backups outside skills/, so they are not themselves deleted by full takeover", () => {
    const h = home();
    seed(h, "a", "SKILL.md", "x");
    applySkills(h, state(skill("b", { "SKILL.md": "y" })));
    expect(backupsDir(h).startsWith(join(h, "skills"))).toBe(false);
    applySkills(h, state(skill("c", { "SKILL.md": "z" })));
    expect(listBackups(h).length).toBeGreaterThanOrEqual(2); // survived a subsequent takeover
  });
});

describe("restoreLatest", () => {
  it("restores the most recent snapshot, replacing current skills/", () => {
    const h = home();
    seed(h, "original", "SKILL.md", "the good state");
    applySkills(h, state(skill("pushed", { "SKILL.md": "the bad push" })));
    expect(existsSync(join(h, "skills", "original"))).toBe(false);

    const from = restoreLatest(h);
    expect(from).not.toBeNull();
    expect(readFileSync(join(h, "skills", "original", "SKILL.md"), "utf8")).toBe("the good state");
    expect(existsSync(join(h, "skills", "pushed"))).toBe(false); // replaced, not merged
  });

  it("returns null when there is nothing to restore", () => {
    expect(restoreLatest(home())).toBeNull();
  });

  it("leaves the rest of the Claude home untouched", () => {
    const h = home();
    writeFileSync(join(h, "CLAUDE.md"), "my rules");
    seed(h, "a", "SKILL.md", "x");
    applySkills(h, state(skill("b", { "SKILL.md": "y" })));
    restoreLatest(h);
    expect(readFileSync(join(h, "CLAUDE.md"), "utf8")).toBe("my rules");
  });

  it("survives a restore into a home whose skills/ was deleted entirely", () => {
    const h = home();
    seed(h, "a", "SKILL.md", "x");
    snapshotSkills(h);
    applySkills(h, state(), { backup: false }); // empties skills/
    expect(readdirSync(join(h, "skills"))).toEqual([]);
    restoreLatest(h);
    expect(readFileSync(join(h, "skills", "a", "SKILL.md"), "utf8")).toBe("x");
  });
});

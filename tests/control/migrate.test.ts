import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateLegacyLayout } from "../../src/control/agent/migrate.js";
import { localDir } from "../../src/control/agent/store.js";

const claudeOnly = () => {
  const claude = mkdtempSync(join(tmpdir(), "claude-"));
  const agents = join(mkdtempSync(join(tmpdir(), "root-")), ".agents"); // deliberately absent
  return { agents, claude };
};
function legacySkill(claude: string, id: string, content = "x") {
  mkdirSync(join(claude, "skills", id), { recursive: true });
  writeFileSync(join(claude, "skills", id, "SKILL.md"), content);
}
const read = (...p: string[]) => readFileSync(join(...p), "utf8");

describe("legacy layout migration", () => {
  it("moves a skill the hub does not claim into the node's own half", () => {
    const { agents, claude } = claudeOnly();
    legacySkill(claude, "my-experiment", "hand written");
    const r = migrateLegacyLayout(agents, claude, new Set());
    expect(r.moved).toEqual(["my-experiment"]);
    expect(read(localDir(agents), "skills", "my-experiment", "SKILL.md")).toBe("hand written");
    expect(existsSync(join(claude, "skills", "my-experiment"))).toBe(false);
  });

  it("leaves a hub-managed skill where it is", () => {
    // The load-bearing case. Moving everything would turn every hub-managed skill into a LOCAL one —
    // and local wins projection, so the node would permanently shadow the hub's version with a frozen
    // copy from the day it upgraded. A well-meaning migration would create silent, fleet-wide drift.
    const { agents, claude } = claudeOnly();
    legacySkill(claude, "code-review", "pushed by the hub");
    const r = migrateLegacyLayout(agents, claude, new Set(["code-review"]));
    expect(r.moved).toEqual([]);
    expect(existsSync(join(localDir(agents), "skills", "code-review"))).toBe(false);
  });

  it("separates the two kinds in one pass", () => {
    const { agents, claude } = claudeOnly();
    legacySkill(claude, "managed");
    legacySkill(claude, "mine-a");
    legacySkill(claude, "mine-b");
    const r = migrateLegacyLayout(agents, claude, new Set(["managed"]));
    expect(r.moved).toEqual(["mine-a", "mine-b"]);
    expect(existsSync(join(claude, "skills", "managed"))).toBe(true);
  });

  it("runs only once — a later call is a no-op", () => {
    const { agents, claude } = claudeOnly();
    legacySkill(claude, "mine");
    expect(migrateLegacyLayout(agents, claude, new Set()).ran).toBe(true);
    legacySkill(claude, "added-later");
    const second = migrateLegacyLayout(agents, claude, new Set());
    expect(second.ran).toBe(false);
    expect(second.moved).toEqual([]);
    expect(existsSync(join(claude, "skills", "added-later"))).toBe(true); // untouched
  });

  it("handles a machine with no previous Claude Code state", () => {
    const { agents, claude } = claudeOnly();
    const r = migrateLegacyLayout(agents, claude, new Set());
    expect(r).toMatchObject({ ran: true, moved: [] });
    expect(existsSync(agents)).toBe(true);
  });

  it("ignores stray files that are not skill directories", () => {
    const { agents, claude } = claudeOnly();
    mkdirSync(join(claude, "skills"), { recursive: true });
    writeFileSync(join(claude, "skills", "README.md"), "not a skill");
    const r = migrateLegacyLayout(agents, claude, new Set());
    expect(r.moved).toEqual([]);
  });
});

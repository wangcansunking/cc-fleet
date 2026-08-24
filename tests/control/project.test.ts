import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { project } from "../../src/control/agent/project.js";
import { fleetDir, localDir, manifestPath } from "../../src/control/agent/store.js";

const dirs = () => ({ agents: mkdtempSync(join(tmpdir(), "agents-")), claude: mkdtempSync(join(tmpdir(), "claude-")) });

function putSkill(root: string, id: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, "skills", id, ...rel.split("/"));
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
}
function putRule(root: string, id: string, content: string) {
  mkdirSync(join(root, "rules"), { recursive: true });
  writeFileSync(join(root, "rules", `${id}.md`), content);
}
const read = (...p: string[]) => readFileSync(join(...p), "utf8");

describe("projection — skills", () => {
  it("copies a fleet skill into the tool's directory", () => {
    const { agents, claude } = dirs();
    putSkill(fleetDir(agents), "code-review", { "SKILL.md": "review" });
    const r = project(agents, claude);
    expect(read(claude, "skills", "code-review", "SKILL.md")).toBe("review");
    expect(r.written).toContain("skills/code-review/SKILL.md");
  });

  it("copies a local skill too — both halves reach the tool", () => {
    const { agents, claude } = dirs();
    putSkill(fleetDir(agents), "from-hub", { "SKILL.md": "a" });
    putSkill(localDir(agents), "mine", { "SKILL.md": "b" });
    project(agents, claude);
    expect(existsSync(join(claude, "skills", "from-hub", "SKILL.md"))).toBe(true);
    expect(read(claude, "skills", "mine", "SKILL.md")).toBe("b");
  });

  it("lets a local skill override the fleet copy of the same id, and reports the conflict", () => {
    // Same id means the same thing in two versions, so exactly one must win. Local wins: the person
    // at the machine knows more about it than a remote profile does. Reporting it is what keeps that
    // from becoming invisible drift.
    const { agents, claude } = dirs();
    putSkill(fleetDir(agents), "dup", { "SKILL.md": "fleet" });
    putSkill(localDir(agents), "dup", { "SKILL.md": "local" });
    const r = project(agents, claude);
    expect(read(claude, "skills", "dup", "SKILL.md")).toBe("local");
    expect(r.conflicts).toEqual(["dup"]);
  });

  it("replaces an overridden skill wholesale rather than merging file-by-file", () => {
    // Half of one version and half of another is a skill that exists in neither store and that
    // nobody wrote — the worst possible outcome of a conflict.
    const { agents, claude } = dirs();
    putSkill(fleetDir(agents), "dup", { "SKILL.md": "fleet", "extra.md": "fleet-only" });
    putSkill(localDir(agents), "dup", { "SKILL.md": "local" });
    project(agents, claude);
    expect(existsSync(join(claude, "skills", "dup", "extra.md"))).toBe(false);
  });

  it("preserves nested paths", () => {
    const { agents, claude } = dirs();
    putSkill(fleetDir(agents), "s", { "SKILL.md": "a", "refs/deep/n.md": "b" });
    project(agents, claude);
    expect(read(claude, "skills", "s", "refs", "deep", "n.md")).toBe("b");
  });
});

describe("projection — full takeover of the target", () => {
  it("deletes a file in the target that the store does not produce", () => {
    const { agents, claude } = dirs();
    mkdirSync(join(claude, "skills", "stale"), { recursive: true });
    writeFileSync(join(claude, "skills", "stale", "SKILL.md"), "hand-placed");
    putSkill(fleetDir(agents), "managed", { "SKILL.md": "x" });
    const r = project(agents, claude);
    expect(existsSync(join(claude, "skills", "stale"))).toBe(false);
    expect(r.removed).toContain("skills/stale/SKILL.md");
  });

  it("empties the target when the store is empty, but keeps the directory", () => {
    const { agents, claude } = dirs();
    mkdirSync(join(claude, "skills", "old"), { recursive: true });
    writeFileSync(join(claude, "skills", "old", "SKILL.md"), "x");
    project(agents, claude);
    expect(readdirSync(join(claude, "skills"))).toEqual([]);
    expect(existsSync(join(claude, "skills"))).toBe(true);
  });

  it("touches nothing outside its projection targets", () => {
    // Identity, history and memory are off-limits. A bug that widened the blast radius here would be
    // unrecoverable for the user.
    const { agents, claude } = dirs();
    mkdirSync(join(claude, "projects"), { recursive: true });
    mkdirSync(join(claude, "commands"), { recursive: true });
    writeFileSync(join(claude, "projects", "s.json"), "history");
    writeFileSync(join(claude, "commands", "mine.md"), "cmd");
    writeFileSync(join(claude, ".claude.json"), "creds");
    putSkill(fleetDir(agents), "s", { "SKILL.md": "x" });
    project(agents, claude);
    expect(read(claude, "projects", "s.json")).toBe("history");
    expect(read(claude, "commands", "mine.md")).toBe("cmd");
    expect(read(claude, ".claude.json")).toBe("creds");
  });

  it("is idempotent", () => {
    const { agents, claude } = dirs();
    putSkill(fleetDir(agents), "s", { "SKILL.md": "x" });
    const first = project(agents, claude);
    const second = project(agents, claude);
    expect(second.written).toEqual(first.written);
    expect(second.removed).toEqual([]);
  });
});

describe("projection — rules", () => {
  it("concatenates fleet rules before local ones, in filename order", () => {
    // Rules ACCUMULATE — unlike skills, they are independent constraints and both must apply. Local
    // goes last so the more specific guidance is read last.
    const { agents, claude } = dirs();
    putRule(fleetDir(agents), "b-second", "FLEET B");
    putRule(fleetDir(agents), "a-first", "FLEET A");
    putRule(localDir(agents), "mine", "LOCAL");
    project(agents, claude);
    const md = read(claude, "CLAUDE.md");
    expect(md.indexOf("FLEET A")).toBeLessThan(md.indexOf("FLEET B"));
    expect(md.indexOf("FLEET B")).toBeLessThan(md.indexOf("LOCAL"));
  });

  it("marks the file as generated and points at the real editing entry point", () => {
    const { agents, claude } = dirs();
    putRule(fleetDir(agents), "r", "text");
    project(agents, claude);
    const md = read(claude, "CLAUDE.md");
    expect(md).toMatch(/GENERATED BY cc-fleet/);
    expect(md).toMatch(/~\/\.agents\/local\/rules/);
  });

  it("labels each block with where it came from", () => {
    const { agents, claude } = dirs();
    putRule(fleetDir(agents), "commit", "rule text");
    project(agents, claude);
    expect(read(claude, "CLAUDE.md")).toContain("cc-fleet: fleet/rules/commit.md");
  });

  it("removes a CLAUDE.md it generated once the rules are gone", () => {
    const { agents, claude } = dirs();
    putRule(fleetDir(agents), "r", "text");
    project(agents, claude);
    require("node:fs").rmSync(join(fleetDir(agents), "rules"), { recursive: true, force: true });
    const r = project(agents, claude);
    expect(existsSync(join(claude, "CLAUDE.md"))).toBe(false);
    expect(r.removed).toContain("CLAUDE.md");
  });

  it("never deletes a CLAUDE.md it did not write", () => {
    // A hand-written CLAUDE.md that predates cc-fleet is not ours to delete, and the manifest is the
    // only thing that can tell the two apart.
    const { agents, claude } = dirs();
    writeFileSync(join(claude, "CLAUDE.md"), "the user's own rules");
    putSkill(fleetDir(agents), "s", { "SKILL.md": "x" }); // skills only, no rules
    project(agents, claude);
    expect(read(claude, "CLAUDE.md")).toBe("the user's own rules");
  });
});

describe("projection — manifest", () => {
  it("records what it produced", () => {
    const { agents, claude } = dirs();
    putSkill(fleetDir(agents), "s", { "SKILL.md": "x" });
    putRule(fleetDir(agents), "r", "y");
    project(agents, claude);
    const m = JSON.parse(read(manifestPath(agents)));
    expect(m.files).toContain("skills/s/SKILL.md");
    expect(m.files).toContain("CLAUDE.md");
    expect(m.version).toBe(1);
  });

  it("degrades to full takeover rather than crashing on a corrupt manifest", () => {
    const { agents, claude } = dirs();
    putSkill(fleetDir(agents), "s", { "SKILL.md": "x" });
    project(agents, claude);
    writeFileSync(manifestPath(agents), "{ broken");
    expect(() => project(agents, claude)).not.toThrow();
    expect(existsSync(join(claude, "skills", "s", "SKILL.md"))).toBe(true);
  });
});

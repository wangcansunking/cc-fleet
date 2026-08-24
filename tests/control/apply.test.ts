import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyFleet } from "../../src/control/agent/apply.js";
import type { DesiredState } from "../../src/control/proto/index.js";

const home = () => mkdtempSync(join(tmpdir(), "cchome-"));
const skillsDir = (h: string) => join(h, "fleet", "skills");
const state = (...skills: DesiredState["skills"]): DesiredState => ({ skills, rules: [], mcpServers: [] });
const skill = (id: string, files: Record<string, string>): DesiredState["skills"][number] => ({
  id,
  files: Object.entries(files).map(([path, content]) => ({ path, content })),
});
const read = (...p: string[]) => readFileSync(join(...p), "utf8");

describe("applyFleet — writing", () => {
  it("writes a skill's files under skills/<id>/ and creates the tree if absent", () => {
    const h = home();
    const r = applyFleet(h, state(skill("code-review", { "SKILL.md": "hello" })));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(read(skillsDir(h), "code-review", "SKILL.md")).toBe("hello");
    expect(r.written).toEqual(["skills/code-review/SKILL.md"]);
    expect(r.changed).toBe(true);
  });

  it("writes nested paths within a skill", () => {
    const h = home();
    applyFleet(h, state(skill("s", { "SKILL.md": "a", "refs/deep/note.md": "b" })));
    expect(read(skillsDir(h), "s", "refs", "deep", "note.md")).toBe("b");
  });

  it("is idempotent: re-applying identical content writes nothing and reports no change", () => {
    // Matters because the agent re-applies on every reconnect. A dishonest `changed` here would
    // spend the 10-slot backup budget on identical snapshots (see backup.test.ts).
    const h = home();
    applyFleet(h, state(skill("s", { "SKILL.md": "same" })));
    const again = applyFleet(h, state(skill("s", { "SKILL.md": "same" })));
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.written).toEqual([]);
    expect(again.deleted).toEqual([]);
    expect(again.changed).toBe(false);
  });

  it("rewrites a file whose content drifted", () => {
    const h = home();
    applyFleet(h, state(skill("s", { "SKILL.md": "v1" })));
    const r = applyFleet(h, state(skill("s", { "SKILL.md": "v2" })));
    expect(read(skillsDir(h), "s", "SKILL.md")).toBe("v2");
    if (!r.ok) return;
    expect(r.written).toEqual(["skills/s/SKILL.md"]);
  });
});

describe("applyFleet — full takeover (docs/design.md §8)", () => {
  it("deletes a file under skills/ that the profile does not declare", () => {
    const h = home();
    mkdirSync(join(skillsDir(h), "stale"), { recursive: true });
    writeFileSync(join(skillsDir(h), "stale", "SKILL.md"), "local experiment");
    const r = applyFleet(h, state(skill("managed", { "SKILL.md": "x" })));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(existsSync(join(skillsDir(h), "stale", "SKILL.md"))).toBe(false);
    expect(r.deleted).toEqual(["skills/stale/SKILL.md"]);
  });

  it("removes directories left empty by deletion, but keeps skills/ itself", () => {
    const h = home();
    mkdirSync(join(skillsDir(h), "stale", "nested"), { recursive: true });
    writeFileSync(join(skillsDir(h), "stale", "nested", "a.md"), "x");
    applyFleet(h, state(skill("kept", { "SKILL.md": "x" })));
    expect(existsSync(join(skillsDir(h), "stale"))).toBe(false);
    expect(existsSync(skillsDir(h))).toBe(true);
  });

  it("empties skills/ when the assigned group declares no skills", () => {
    // The store root (fleet/) is kept — its absence would be indistinguishable from "cc-fleet never
    // ran here" — but the now-empty skills/ subtree underneath it is pruned.
    const h = home();
    applyFleet(h, state(skill("s", { "SKILL.md": "x" })));
    const r = applyFleet(h, state());
    expect(r.ok).toBe(true);
    expect(existsSync(join(skillsDir(h), "s"))).toBe(false);
    expect(existsSync(join(h, "fleet"))).toBe(true);
  });

  it("touches nothing outside skills/", () => {
    // "Full takeover" is scoped. Identity, memory and session history are explicitly off-limits
    // (design §8) — a bug that widened the blast radius here would be unrecoverable for the user.
    const h = home();
    mkdirSync(join(h, "projects"), { recursive: true });
    mkdirSync(join(h, "commands"), { recursive: true });
    writeFileSync(join(h, "CLAUDE.md"), "my rules");
    writeFileSync(join(h, "commands", "mine.md"), "my command");
    writeFileSync(join(h, "projects", "session.json"), "history");
    writeFileSync(join(h, ".claude.json"), "creds");
    applyFleet(h, state(skill("s", { "SKILL.md": "x" })));
    expect(read(h, "CLAUDE.md")).toBe("my rules");
    expect(read(h, "commands", "mine.md")).toBe("my command");
    expect(read(h, "projects", "session.json")).toBe("history");
    expect(read(h, ".claude.json")).toBe("creds");
  });
});

describe("applyFleet — path containment", () => {
  // This channel is effectively remote code execution (design §9). A hostile or merely typo'd profile
  // must be refused by the AGENT; the hub being trusted is not a security property we can rely on.
  //
  // Every case here must fail the SAME WAY on every platform. A backslash is the trap: Windows reads
  // it as a separator (so `..\x` escapes and gets caught by containment) while Linux reads it as an
  // ordinary filename character (so the same string stays inside and is accepted). A rule that only
  // holds on the developer's OS is not a rule — hence backslashes are refused outright.
  const escapes: [string, DesiredState][] = [
    ["parent traversal", state(skill("s", { "../escaped.md": "x" }))],
    ["deep traversal", state(skill("s", { "a/../../escaped.md": "x" }))],
    ["posix absolute", state(skill("s", { "/etc/passwd": "x" }))],
    ["windows drive", state(skill("s", { "C:/Windows/evil.md": "x" }))],
    ["backslash traversal", state(skill("s", { "..\\escaped.md": "x" }))],
    ["backslash separator, no traversal", state(skill("s", { "refs\\note.md": "x" }))],
    ["id with separator", state(skill("../evil", { "SKILL.md": "x" }))],
    ["id with backslash", state(skill("..\\evil", { "SKILL.md": "x" }))],
    ["empty path", state(skill("s", { "": "x" }))],
    ["dot-only path", state(skill("s", { ".": "x" }))],
  ];
  for (const [label, bad] of escapes) {
    it(`rejects ${label} and writes nothing at all`, () => {
      const h = home();
      const r = applyFleet(h, bad);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error).toMatch(/path|id/i);
      expect(existsSync(skillsDir(h))).toBe(false); // rejected before ANY mutation
    });
  }

  it("refuses the whole apply when one skill in a valid batch escapes", () => {
    // Partial application would leave the node in a state neither the hub nor the user can reason
    // about, so a single bad entry aborts the batch.
    const h = home();
    const r = applyFleet(h, state(skill("good", { "SKILL.md": "x" }), skill("bad", { "../out.md": "x" })));
    expect(r.ok).toBe(false);
    expect(existsSync(join(skillsDir(h), "good"))).toBe(false);
  });

  it("does not delete pre-existing files when it rejects", () => {
    const h = home();
    mkdirSync(join(skillsDir(h), "existing"), { recursive: true });
    writeFileSync(join(skillsDir(h), "existing", "SKILL.md"), "keep me");
    const r = applyFleet(h, state(skill("s", { "../out.md": "x" })));
    expect(r.ok).toBe(false);
    expect(read(skillsDir(h), "existing", "SKILL.md")).toBe("keep me");
  });

  it("rejects a duplicate skill id instead of letting one silently win", () => {
    const h = home();
    const r = applyFleet(h, state(skill("dup", { "SKILL.md": "a" }), skill("dup", { "SKILL.md": "b" })));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/dup/);
  });
});

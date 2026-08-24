import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PendingQueue } from "../../src/control/hub/pending.js";
import { adoptIntoProfile } from "../../src/control/hub/adopt.js";
import { localInventory, readLocalItem } from "../../src/control/agent/local.js";
import { localDir } from "../../src/control/agent/store.js";
import type { PushItem } from "../../src/control/proto/index.js";

const dir = () => mkdtempSync(join(tmpdir(), "ccm3-"));
const skillItem = (id = "my-thing"): PushItem => ({ kind: "skill", id, files: [{ path: "SKILL.md", content: "mine" }] });

describe("pending queue", () => {
  it("stores an offered item and lists it", () => {
    const d = dir();
    const q = new PendingQueue(d);
    expect(q.offer("laptop-home", skillItem())).toBe(true);
    const [e] = q.list();
    expect(e).toMatchObject({ deviceId: "laptop-home", item: { kind: "skill", id: "my-thing" } });
  });

  it("keeps offers from different devices apart", () => {
    const d = dir();
    const q = new PendingQueue(d);
    q.offer("a", skillItem("same-id"));
    q.offer("b", skillItem("same-id"));
    expect(q.list()).toHaveLength(2);
    expect(q.find("a", "skill", "same-id")).not.toBeNull();
    expect(q.find("b", "skill", "same-id")).not.toBeNull();
  });

  it("lets a device replace its own earlier offer", () => {
    const d = dir();
    const q = new PendingQueue(d);
    q.offer("a", { kind: "rule", id: "r", content: "v1" });
    q.offer("a", { kind: "rule", id: "r", content: "v2" });
    expect(q.list()).toHaveLength(1);
    expect((q.find("a", "rule", "r")!.item as { content: string }).content).toBe("v2");
  });

  it("refuses an item whose id or paths could escape the inbox", () => {
    // A push comes from a machine that may itself be compromised. Rejecting here means the operator
    // never sees an entry that could not have been adopted safely anyway.
    const d = dir();
    const q = new PendingQueue(d);
    expect(q.offer("a", { kind: "skill", id: "../evil", files: [{ path: "x", content: "" }] })).toBe(false);
    expect(q.offer("a", { kind: "skill", id: "s", files: [{ path: "../out.md", content: "" }] })).toBe(false);
    expect(q.offer("a", { kind: "skill", id: "s", files: [{ path: "/etc/x", content: "" }] })).toBe(false);
    expect(q.offer("a", { kind: "skill", id: "s", files: [{ path: "a\\b", content: "" }] })).toBe(false);
    expect(q.list()).toEqual([]);
  });

  it("refuses a skill with no files", () => {
    expect(new PendingQueue(dir()).offer("a", { kind: "skill", id: "empty", files: [] })).toBe(false);
  });

  it("drops an entry, and reports honestly when there was none", () => {
    const d = dir();
    const q = new PendingQueue(d);
    q.offer("a", skillItem());
    expect(q.drop("a", "skill", "my-thing")).toBe(true);
    expect(q.drop("a", "skill", "my-thing")).toBe(false);
    expect(q.list()).toEqual([]);
  });

  it("survives a corrupt entry rather than losing the whole listing", () => {
    const d = dir();
    const q = new PendingQueue(d);
    q.offer("a", skillItem());
    writeFileSync(join(d, "pending", "junk.json"), "{ broken");
    expect(q.list()).toHaveLength(1);
  });

  it("leaves no temp file behind", () => {
    const d = dir();
    new PendingQueue(d).offer("a", skillItem());
    const names = require("node:fs").readdirSync(join(d, "pending"));
    expect(names.every((n: string) => !n.endsWith(".tmp"))).toBe(true);
  });
});

describe("adoption", () => {
  const profile = (over: Record<string, unknown> = {}) => ({
    version: 3,
    groups: { full: { skills: [], rules: [], mcpServers: [] }, minimal: { skills: [] } },
    assignments: { "laptop-home": "full" },
    ...over,
  });
  const writeProfile = (d: string, p: unknown) => {
    const path = join(d, "profile.json");
    writeFileSync(path, JSON.stringify(p, null, 2));
    return path;
  };
  const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));

  it("adds the item to the named group and bumps the version", () => {
    // The bump is not cosmetic: nodes compare versions, so an adoption that forgot it would sit in
    // the profile doing nothing.
    const d = dir();
    const p = writeProfile(d, profile());
    const r = adoptIntoProfile(p, "full", skillItem());
    expect(r).toMatchObject({ ok: true, version: 4, replaced: false });
    expect(read(p).groups.full.skills[0].id).toBe("my-thing");
  });

  it("replaces an item of the same id rather than duplicating it", () => {
    const d = dir();
    const p = writeProfile(d, profile({
      version: 1,
      groups: { full: { skills: [{ id: "my-thing", files: [{ path: "SKILL.md", content: "old" }] }] } },
      assignments: { a: "full" },
    }));
    const r = adoptIntoProfile(p, "full", skillItem());
    expect(r).toMatchObject({ ok: true, replaced: true });
    expect(read(p).groups.full.skills).toHaveLength(1);
    expect(read(p).groups.full.skills[0].files[0].content).toBe("mine");
  });

  it("creates the bucket when the group never had one", () => {
    const d = dir();
    const p = writeProfile(d, profile());
    adoptIntoProfile(p, "minimal", { kind: "rule", id: "r", content: "text" });
    expect(read(p).groups.minimal.rules[0].content).toBe("text");
  });

  it("refuses an unknown group and names the real ones", () => {
    const d = dir();
    const p = writeProfile(d, profile());
    const r = adoptIntoProfile(p, "nope", skillItem());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/unknown group/);
    expect(r.error).toMatch(/full/);
  });

  it("refuses to touch a profile that is already broken", () => {
    // Adopting into a broken profile would bury the operator's real problem under a second one.
    const d = dir();
    const p = join(d, "profile.json");
    writeFileSync(p, JSON.stringify({ version: 1, groups: {} }));
    const r = adoptIntoProfile(p, "full", skillItem());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/fix it first/);
  });

  it("does not rewrite fields the human never wrote", () => {
    // The parsed profile carries zod's defaults; writing that back would silently materialise fields
    // and reformat someone's hand-maintained file.
    const d = dir();
    const p = writeProfile(d, { version: 1, groups: { full: { skills: [] } }, assignments: { a: "full" } });
    adoptIntoProfile(p, "full", skillItem());
    expect(read(p).groups.full.rules).toBeUndefined();
    expect(read(p).devices).toBeUndefined();
  });

  it("leaves no temp file behind", () => {
    const d = dir();
    const p = writeProfile(d, profile());
    adoptIntoProfile(p, "full", skillItem());
    expect(existsSync(`${p}.adopt.tmp`)).toBe(false);
  });
});

describe("local inventory and item reading", () => {
  const seedSkill = (agents: string, id: string, content = "x") => {
    mkdirSync(join(localDir(agents), "skills", id), { recursive: true });
    writeFileSync(join(localDir(agents), "skills", id, "SKILL.md"), content);
  };

  it("lists ids only — never content", () => {
    // The distinction that makes continuous reporting acceptable: the hub learns something EXISTS,
    // not what it says. Content moves only on an explicit push.
    const agents = dir();
    seedSkill(agents, "b");
    seedSkill(agents, "a");
    mkdirSync(join(localDir(agents), "rules"), { recursive: true });
    writeFileSync(join(localDir(agents), "rules", "note.md"), "secret");
    const inv = localInventory(agents);
    expect(inv.skills).toEqual(["a", "b"]);
    expect(inv.rules).toEqual(["note"]);
    expect(JSON.stringify(inv)).not.toContain("secret");
  });

  it("is empty on a machine with no local half", () => {
    expect(localInventory(dir())).toEqual({ skills: [], rules: [], mcpServers: [] });
  });

  it("reads a full skill for pushing, including nested files", () => {
    const agents = dir();
    seedSkill(agents, "s");
    mkdirSync(join(localDir(agents), "skills", "s", "refs"), { recursive: true });
    writeFileSync(join(localDir(agents), "skills", "s", "refs", "n.md"), "nested");
    const r = readLocalItem(agents, "skill", "s");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if (r.item.kind !== "skill") return;
    expect(r.item.files.map((f) => f.path).sort()).toEqual(["SKILL.md", "refs/n.md"]);
  });

  it("refuses to read a FLEET item — only the node's own half can be offered", () => {
    const agents = dir();
    mkdirSync(join(agents, "fleet", "skills", "hub-owned"), { recursive: true });
    writeFileSync(join(agents, "fleet", "skills", "hub-owned", "SKILL.md"), "x");
    expect(readLocalItem(agents, "skill", "hub-owned").ok).toBe(false);
  });

  it("reports a missing item instead of pushing nothing", () => {
    const r = readLocalItem(dir(), "skill", "ghost");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/no local skill/);
  });

  it("refuses an id that could escape the local half", () => {
    expect(readLocalItem(dir(), "skill", "../fleet/skills/x").ok).toBe(false);
  });

  it("reports an unparseable local mcp config rather than pushing garbage", () => {
    const agents = dir();
    mkdirSync(join(localDir(agents), "mcp"), { recursive: true });
    writeFileSync(join(localDir(agents), "mcp", "bad.json"), "{ broken");
    const r = readLocalItem(agents, "mcp", "bad");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/not valid JSON/);
  });
});

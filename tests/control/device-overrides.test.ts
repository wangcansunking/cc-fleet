import { describe, it, expect } from "vitest";
import { parseProfile, desiredStateFor, type Profile } from "../../src/control/proto/index.js";

const raw = (over: Record<string, unknown> = {}) => ({
  version: 1,
  groups: {
    full: {
      skills: [{ id: "code-review", files: [{ path: "SKILL.md", content: "a" }] }],
      rules: [{ id: "commit", content: "r" }],
      mcpServers: [{ id: "sentry", config: { type: "http", url: "https://s" } }],
    },
    minimal: { skills: [], rules: [], mcpServers: [] },
    extras: {
      skills: [{ id: "deploy-runbook", files: [{ path: "SKILL.md", content: "d" }] }],
      rules: [],
      mcpServers: [{ id: "postgres", config: { type: "stdio", command: "pg" } }],
    },
  },
  assignments: { "laptop-home": "full", "vm-azure": "full" },
  ...over,
});
function profile(over: Record<string, unknown> = {}): Profile {
  const r = parseProfile(raw(over));
  if (!r.ok) throw new Error(r.error);
  return r.profile;
}
const ids = (xs: { id: string }[]) => xs.map((x) => x.id).sort();

describe("per-device overrides", () => {
  it("leaves a device with no override on its plain group", () => {
    const s = desiredStateFor(profile(), "laptop-home")!;
    expect(ids(s.skills)).toEqual(["code-review"]);
    expect(ids(s.mcpServers)).toEqual(["sentry"]);
  });

  it("adds an item defined in ANOTHER group without duplicating its definition", () => {
    // Otherwise "give this one machine the deploy runbook too" would mean copying the runbook into a
    // second group and keeping the two in sync by hand.
    const p = profile({ devices: { "vm-azure": { add: { skills: ["deploy-runbook"], mcpServers: ["postgres"] } } } });
    const s = desiredStateFor(p, "vm-azure")!;
    expect(ids(s.skills)).toEqual(["code-review", "deploy-runbook"]);
    expect(ids(s.mcpServers)).toEqual(["postgres", "sentry"]);
  });

  it("removes an item the group would otherwise give it", () => {
    const p = profile({ devices: { "vm-azure": { remove: { skills: ["code-review"], rules: ["commit"] } } } });
    const s = desiredStateFor(p, "vm-azure")!;
    expect(s.skills).toEqual([]);
    expect(s.rules).toEqual([]);
    expect(ids(s.mcpServers)).toEqual(["sentry"]); // untouched
  });

  it("applies remove AFTER add, so an id in both ends up absent", () => {
    // Either order is defensible; this one fails visibly (something missing) rather than invisibly
    // (something unexpectedly present on a machine).
    const p = profile({ devices: { "vm-azure": { add: { skills: ["deploy-runbook"] }, remove: { skills: ["deploy-runbook"] } } } });
    expect(ids(desiredStateFor(p, "vm-azure")!.skills)).toEqual(["code-review"]);
  });

  it("affects only the device it names", () => {
    const p = profile({ devices: { "vm-azure": { remove: { skills: ["code-review"] } } } });
    expect(ids(desiredStateFor(p, "laptop-home")!.skills)).toEqual(["code-review"]);
  });

  it("matches the device id case-insensitively, like assignments do", () => {
    const p = profile({ devices: { "VM-AZURE": { remove: { skills: ["code-review"] } } } });
    expect(desiredStateFor(p, "vm-azure")!.skills).toEqual([]);
  });

  it("ignores an add naming something that exists nowhere, rather than inventing it", () => {
    const p = profile({ devices: { "vm-azure": { add: { skills: ["does-not-exist"] } } } });
    expect(ids(desiredStateFor(p, "vm-azure")!.skills)).toEqual(["code-review"]);
  });

  it("ignores a remove naming something the device never had", () => {
    const p = profile({ devices: { "vm-azure": { remove: { skills: ["never-had-it"] } } } });
    expect(ids(desiredStateFor(p, "vm-azure")!.skills)).toEqual(["code-review"]);
  });

  it("never resurrects an UNASSIGNED device via an override", () => {
    // An override must not become a back door around the fail-safe: a machine nobody assigned stays
    // untouched, full stop.
    const p = profile({ devices: { stranger: { add: { skills: ["code-review"] } } } });
    expect(desiredStateFor(p, "stranger")).toBeNull();
  });
});

describe("profile schema — new fields stay optional", () => {
  it("still accepts a profile written before rules, mcp and devices existed", () => {
    const r = parseProfile({
      version: 1,
      groups: { full: { skills: [] } },
      assignments: { a: "full" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.profile.groups.full.rules).toEqual([]);
    expect(r.profile.groups.full.mcpServers).toEqual([]);
    expect(r.profile.devices).toEqual({});
  });

  it("passes an MCP config through verbatim rather than validating Claude Code's schema", () => {
    // Re-declaring that shape here would mean rejecting valid configs every time Claude Code gains
    // a field.
    const r = parseProfile(raw({
      groups: { full: { skills: [], rules: [], mcpServers: [{ id: "x", config: { anything: { nested: true }, n: 1 } }] } },
      assignments: { a: "full" },
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.profile.groups.full.mcpServers[0].config).toEqual({ anything: { nested: true }, n: 1 });
  });
});

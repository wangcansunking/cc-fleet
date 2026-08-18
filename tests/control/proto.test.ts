import { describe, it, expect } from "vitest";
import { PROTO_VERSION, parseProfile, desiredStateFor, parseNodeMessage, parseHubMessage } from "../../src/control/proto/index.js";

const skill = (id: string, content = "hi") => ({ id, files: [{ path: "SKILL.md", content }] });
const profile = (over: Record<string, unknown> = {}) => ({
  version: 1,
  groups: { full: { skills: [skill("code-review")] } },
  assignments: { "laptop-home": "full" },
  ...over,
});

describe("proto/profile schema", () => {
  it("accepts a minimal well-formed profile", () => {
    const r = parseProfile(profile());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.profile.version).toBe(1);
    expect(r.profile.groups.full.skills[0].id).toBe("code-review");
  });

  it("rejects a profile missing required fields rather than defaulting them", () => {
    // A half-specified profile must not silently become an empty desired state — that would
    // full-takeover-delete every skill on every node.
    expect(parseProfile({ groups: {}, assignments: {} }).ok).toBe(false);      // no version
    expect(parseProfile({ version: 1, assignments: {} }).ok).toBe(false);       // no groups
    expect(parseProfile({ version: 1, groups: {} }).ok).toBe(false);            // no assignments
    expect(parseProfile(null).ok).toBe(false);
    expect(parseProfile("nope").ok).toBe(false);
  });

  it("rejects wrong types and non-integer versions", () => {
    expect(parseProfile(profile({ version: "1" })).ok).toBe(false);
    expect(parseProfile(profile({ version: 1.5 })).ok).toBe(false);
    expect(parseProfile({ version: 1, groups: { full: { skills: "no" } }, assignments: {} }).ok).toBe(false);
    expect(parseProfile({ version: 1, groups: { full: { skills: [{ id: "x" }] } }, assignments: {} }).ok).toBe(false); // no files
  });

  it("reports why it rejected, so the hub can log something actionable", () => {
    const r = parseProfile({ version: 1, groups: {} });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/assignments/i);
  });

  it("rejects an assignment pointing at a group that does not exist", () => {
    // Otherwise the node silently gets `unassigned` and the user thinks it's a network fault.
    const r = parseProfile(profile({ assignments: { "laptop-home": "nope" } }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/nope/);
  });
});

describe("proto/desiredStateFor", () => {
  it("resolves a device to its assigned group's state", () => {
    const r = parseProfile(profile());
    if (!r.ok) throw new Error(r.error);
    expect(desiredStateFor(r.profile, "laptop-home")?.skills[0].id).toBe("code-review");
  });

  it("returns null for an unassigned device — never a default group", () => {
    // fail-safe: an unregistered machine must not be full-takeover-managed by accident.
    const r = parseProfile(profile());
    if (!r.ok) throw new Error(r.error);
    expect(desiredStateFor(r.profile, "some-random-box")).toBeNull();
  });

  it("matches device ids case-insensitively (hostnames are not case-stable across OSes)", () => {
    const r = parseProfile(profile());
    if (!r.ok) throw new Error(r.error);
    expect(desiredStateFor(r.profile, "LAPTOP-HOME")).not.toBeNull();
  });
});

describe("proto/messages", () => {
  it("round-trips a hello and an applied report", () => {
    const hello = parseNodeMessage({ t: "hello", proto: PROTO_VERSION, deviceId: "a", os: "win32", agentVersion: "0.1.0", appliedVersion: 0 });
    expect(hello.ok).toBe(true);
    const applied = parseNodeMessage({ t: "applied", proto: PROTO_VERSION, version: 1, ok: true, written: 3, deleted: 1, warnings: [] });
    expect(applied.ok).toBe(true);
  });

  it("parses hub apply and unassigned frames", () => {
    expect(parseHubMessage({ t: "apply", proto: PROTO_VERSION, version: 1, state: { skills: [skill("s")] } }).ok).toBe(true);
    expect(parseHubMessage({ t: "unassigned", proto: PROTO_VERSION }).ok).toBe(true);
  });

  it("refuses a mismatched protocol version instead of guessing compatibility", () => {
    const r = parseHubMessage({ t: "unassigned", proto: PROTO_VERSION + 1 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/protocol/i);
  });

  it("refuses unknown message kinds", () => {
    expect(parseNodeMessage({ t: "whoami", proto: PROTO_VERSION }).ok).toBe(false);
    expect(parseHubMessage({ t: "shutdown", proto: PROTO_VERSION }).ok).toBe(false);
  });
});

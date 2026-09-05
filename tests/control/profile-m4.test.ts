import { describe, it, expect } from "vitest";
import { parseProfile, desiredStateFor, PROTO_VERSION } from "../../src/control/proto/index.js";

const raw = (over: Record<string, unknown> = {}) => ({
  version: 4,
  clients: {
    claude: { model: "claude-opus-5[1m]", contextWindow: 1_000_000 },
    codex: { model: "gpt-5.6-sol", contextWindow: 1_000_000 },
  },
  groups: {
    full: { skills: [{ id: "base", files: [{ path: "SKILL.md", content: "x" }] }], rules: [], mcpServers: [] },
    extras: { skills: [{ id: "extra", files: [{ path: "SKILL.md", content: "e" }] }], rules: [], mcpServers: [] },
  },
  assignments: { laptop: "full", vm: "full" },
  ...over,
});

describe("M4 profile client defaults and per-device model overrides", () => {
  it("bumps the wire protocol for the new apply shape", () => {
    expect(PROTO_VERSION).toBe(2);
  });

  it("parses client defaults and resolves them with group state", () => {
    const parsed = parseProfile(raw());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(desiredStateFor(parsed.profile, "laptop")?.clients).toEqual({
      claude: { model: "claude-opus-5[1m]", contextWindow: 1_000_000 },
      codex: { model: "gpt-5.6-sol", contextWindow: 1_000_000 },
    });
  });

  it("overrides Claude and Codex independently for one device only", () => {
    const parsed = parseProfile(raw({
      devices: {
        vm: { override: { claude: { model: "claude-sonnet-5[1m]" }, codex: { model: "gpt-5.6-terra", contextWindow: 900_000 } } },
      },
    }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(desiredStateFor(parsed.profile, "vm")?.clients).toEqual({
      claude: { model: "claude-sonnet-5[1m]" },
      codex: { model: "gpt-5.6-terra", contextWindow: 900_000 },
    });
    expect(desiredStateFor(parsed.profile, "laptop")?.clients?.claude.model).toBe("claude-opus-5[1m]");
  });

  it("still accepts an old profile and resolves no client configuration", () => {
    const parsed = parseProfile({
      version: 1,
      groups: { full: { skills: [] } },
      assignments: { laptop: "full" },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(desiredStateFor(parsed.profile, "laptop")?.clients).toBeUndefined();
  });

  it.each([
    { clients: { claude: { model: "valid" } } },
    { clients: { codex: { model: "valid" } } },
    { clients: { claude: { model: "" }, codex: { model: "valid" } } },
    { clients: { claude: { model: "valid" }, codex: { model: "gpt", contextWindow: 0 } } },
    { devices: { vm: { override: { claude: { model: " " } } } } },
  ])("rejects malformed client config %#", (over) => {
    expect(parseProfile(raw(over)).ok).toBe(false);
  });

  it("never lets an override resurrect an unassigned device", () => {
    const parsed = parseProfile(raw({ devices: { stranger: { override: { claude: { model: "x" } } } } }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(desiredStateFor(parsed.profile, "stranger")).toBeNull();
  });
});

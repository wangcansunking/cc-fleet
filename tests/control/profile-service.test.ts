import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileService } from "../../src/control/hub/profile-service.js";

const dir = () => mkdtempSync(join(tmpdir(), "cc-profile-service-"));
const profile = (version = 1, content = "one") => ({
  version,
  clients: { claude: { model: "claude-opus-5[1m]" }, codex: { model: "gpt-5.6-sol" } },
  groups: { full: { skills: [{ id: "s", files: [{ path: "SKILL.md", content }] }], rules: [], mcpServers: [] } },
  assignments: { laptop: "full" },
});

function fixture() {
  const dataDir = dir();
  const path = join(dataDir, "profile.json");
  writeFileSync(path, JSON.stringify(profile(), null, 2));
  return { dataDir, path, service: new ProfileService(dataDir, path) };
}

describe("ProfileService draft -> preview -> publish", () => {
  it("saves a validated draft without changing live profile", () => {
    const { service, path } = fixture();
    const live = service.readLive();
    if (!live.ok) throw new Error(live.error);
    const draft = service.saveDraft(profile(999, "two"), live.revision);
    expect(draft.ok).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).groups.full.skills[0].files[0].content).toBe("one");
    expect(service.readDraft()).toMatchObject({ exists: true, valid: true, baseRevision: live.revision });
  });

  it("rejects an invalid draft without replacing a previously valid one", () => {
    const { service } = fixture();
    const live = service.readLive();
    if (!live.ok) throw new Error(live.error);
    expect(service.saveDraft(profile(2, "two"), live.revision).ok).toBe(true);
    const before = service.readDraft();
    const bad = service.saveDraft({ version: 2, groups: {} }, live.revision);
    expect(bad.ok).toBe(false);
    expect(service.readDraft()).toEqual(before);
  });

  it("rejects a stale draft save after a concurrent live edit", () => {
    const { service, path } = fixture();
    const live = service.readLive();
    if (!live.ok) throw new Error(live.error);
    writeFileSync(path, JSON.stringify(profile(2, "manual")));
    const result = service.saveDraft(profile(3, "dashboard"), live.revision);
    expect(result).toMatchObject({ ok: false, code: "revision_conflict" });
  });

  it("previews item and client changes by effective device without exposing file content", () => {
    const { service } = fixture();
    const live = service.readLive();
    if (!live.ok) throw new Error(live.error);
    const next = profile(2, "TOP SECRET CONTENT");
    next.groups.full.skills.push({ id: "new", files: [{ path: "SKILL.md", content: "OTHER SECRET" }] });
    next.clients.claude.model = "claude-sonnet-5[1m]";
    expect(service.saveDraft(next, live.revision).ok).toBe(true);
    const preview = service.previewDraft();
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.devices[0]).toMatchObject({
      deviceId: "laptop",
      skills: { added: ["new"], removed: [], changed: ["s"] },
      clients: { claude: { before: "claude-opus-5[1m]", after: "claude-sonnet-5[1m]" } },
    });
    expect(JSON.stringify(preview)).not.toContain("TOP SECRET");
    expect(JSON.stringify(preview)).not.toContain("OTHER SECRET");
  });

  it("publishes atomically with live.version + 1, ignoring the draft's version", async () => {
    const { service, path } = fixture();
    const live = service.readLive();
    if (!live.ok) throw new Error(live.error);
    expect(service.saveDraft(profile(999, "two"), live.revision).ok).toBe(true);
    const published = await service.publishDraft(live.revision);
    expect(published).toMatchObject({ ok: true, version: 2 });
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ version: 2 });
    expect(service.readDraft().exists).toBe(false);
    expect(service.listHistory()).toHaveLength(1);
  });

  it("refuses publish when live changed after the draft was created", async () => {
    const { service, path } = fixture();
    const live = service.readLive();
    if (!live.ok) throw new Error(live.error);
    expect(service.saveDraft(profile(2, "draft"), live.revision).ok).toBe(true);
    writeFileSync(path, JSON.stringify(profile(2, "manual")));
    expect(await service.publishDraft(live.revision)).toMatchObject({ ok: false, code: "revision_conflict" });
    expect(JSON.parse(readFileSync(path, "utf8")).groups.full.skills[0].files[0].content).toBe("manual");
  });

  it("serializes concurrent publishes so one wins and the other sees a revision conflict", async () => {
    const { service, path } = fixture();
    const live = service.readLive();
    if (!live.ok) throw new Error(live.error);
    expect(service.saveDraft(profile(2, "draft"), live.revision).ok).toBe(true);
    const [a, b] = await Promise.all([service.publishDraft(live.revision), service.publishDraft(live.revision)]);
    expect([a, b].filter((r) => r.ok)).toHaveLength(1);
    expect([a, b].filter((r) => !r.ok && r.code === "revision_conflict")).toHaveLength(1);
    expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(2);
  });

  it("rolls history forward as a new version, never backwards", async () => {
    const { service, path } = fixture();
    const first = service.readLive();
    if (!first.ok) throw new Error(first.error);
    service.saveDraft(profile(9, "two"), first.revision);
    const pub = await service.publishDraft(first.revision);
    if (!pub.ok) throw new Error(pub.error);
    const history = service.listHistory();
    const current = service.readLive();
    if (!current.ok) throw new Error(current.error);
    const rolled = await service.rollback(history[0].id, current.revision);
    expect(rolled).toMatchObject({ ok: true, version: 3 });
    const body = JSON.parse(readFileSync(path, "utf8"));
    expect(body.version).toBe(3);
    expect(body.groups.full.skills[0].files[0].content).toBe("one");
  });
});

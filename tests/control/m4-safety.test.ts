import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileService } from "../../src/control/hub/profile-service.js";
import { PendingQueue } from "../../src/control/hub/pending.js";
import { applyManagedClients } from "../../src/control/agent/client-config.js";

const root = () => mkdtempSync(join(tmpdir(), "cc-m4-safe-"));
const profile = (version = 1, content = "base") => ({
  version,
  clients: { claude: { model: "claude-opus-5[1m]" }, codex: { model: "gpt-5.6-sol" } },
  groups: { full: { skills: [{ id: "base", files: [{ path: "SKILL.md", content }] }], rules: [], mcpServers: [] } },
  assignments: { laptop: "full" },
});

describe("M4 profile mutation safety", () => {
  it("adopts atomically without touching or publishing the shared dashboard draft", async () => {
    const d = root(), path = join(d, "profile.json");
    writeFileSync(path, JSON.stringify(profile()));
    const service = new ProfileService(d, path);
    const live = service.readLive(); if (!live.ok) throw new Error(live.error);
    const dashboardDraft = profile(99, "dashboard draft");
    service.saveDraft(dashboardDraft, live.revision);
    const queue = new PendingQueue(d);
    queue.offer("laptop", { kind: "skill", id: "node-skill", files: [{ path: "SKILL.md", content: "node" }] });

    const adopted = await service.adopt("full", queue.find("laptop", "skill", "node-skill")!.item, live.revision);
    expect(adopted).toMatchObject({ ok: true, version: 2 });
    const current = JSON.parse(readFileSync(path, "utf8"));
    expect(current.groups.full.skills.map((s: any) => s.id)).toEqual(["base", "node-skill"]);
    expect(service.readDraft()).toMatchObject({ exists: true, valid: true, profile: dashboardDraft });
  });

  it("detects a manual edit made immediately before atomic replacement", async () => {
    const d = root(), path = join(d, "profile.json");
    writeFileSync(path, JSON.stringify(profile()));
    let mutateBeforeReplace: (() => void) | undefined;
    const service = new ProfileService(d, path, () => new Date(), { beforeReplace: () => mutateBeforeReplace?.() });
    const live = service.readLive(); if (!live.ok) throw new Error(live.error);
    service.saveDraft(profile(2, "dashboard"), live.revision);
    mutateBeforeReplace = () => writeFileSync(path, JSON.stringify(profile(2, "manual")));
    const published = await service.publishDraft(live.revision);
    expect(published).toMatchObject({ ok: false, code: "revision_conflict" });
    expect(JSON.parse(readFileSync(path, "utf8")).groups.full.skills[0].files[0].content).toBe("manual");
    expect(service.listHistory()).toEqual([]);
  });
});

describe("managed Codex config preserves unrelated tables", () => {
  it("does not strip model-shaped keys from a user's table", () => {
    const home = root(), agents = root();
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), '[custom_provider]\nmodel = "user-model"\nmodel_context_window = 123\n');
    applyManagedClients(agents, home, {
      baseUrl: "https://fleet.example", apiKey: "key", keyRevision: 1,
      claude: { model: "claude-opus-5[1m]" }, codex: { model: "gpt-5.6-sol" },
    });
    const result = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    expect(result).toContain('[custom_provider]\nmodel = "user-model"\nmodel_context_window = 123');
  });
});

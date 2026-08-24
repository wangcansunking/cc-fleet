import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startControlHub, type RunningHub } from "../src/control/hub/index.js";
import { connectHttp } from "../src/control/transport/http-agent.js";
import { startAgent } from "../src/control/agent/agent.js";
import { localDir } from "../src/control/agent/store.js";
import { readLocalItem } from "../src/control/agent/local.js";
import { adoptIntoProfile } from "../src/control/hub/adopt.js";
import { PROTO_VERSION } from "../src/control/proto/index.js";

// M3 end to end: a skill authored ON A NODE travels up to the hub, waits for a human, and then comes
// back down to the whole fleet as managed config.
//
// The property under test is not just "it arrives" but "it does not arrive until someone says so" —
// this direction carries instructions every machine may end up executing.

const DEVICE = "laptop-home";
const OTHER = "vm-azure";
const cleanups: (() => void)[] = [];
afterEach(() => { for (const c of cleanups.splice(0).reverse()) c(); });

const profile = (version: number) => ({
  version,
  groups: { full: { skills: [], rules: [], mcpServers: [] } },
  assignments: { [DEVICE]: "full", [OTHER]: "full" },
});

async function hub() {
  const dataDir = mkdtempSync(join(tmpdir(), "cchub-"));
  writeFileSync(join(dataDir, "profile.json"), JSON.stringify(profile(1), null, 2));
  const h = await startControlHub({ dataDir, port: 0, host: "127.0.0.1", keepAliveMs: 200, debounceMs: 20 });
  cleanups.push(() => h.close());
  return Object.assign(h, { dataDir });
}

interface Node { agents: string; claude: string }
const fresh = (): Node => ({
  agents: mkdtempSync(join(tmpdir(), "agents-")),
  claude: mkdtempSync(join(tmpdir(), "claude-")),
});

function connect(h: RunningHub, n: Node, deviceId: string) {
  const { deviceToken } = h.devices.enroll({ hostname: deviceId, os: "linux", agentVersion: "e2e" });
  const channel = connectHttp({ hubUrl: `http://127.0.0.1:${h.port}`, token: deviceToken, deviceId, retryMs: 20, maxRetryMs: 100 });
  const agent = startAgent({ agentsHome: n.agents, claudeHome: n.claude, channel, deviceId, agentVersion: "e2e" });
  cleanups.push(() => { agent.stop(); channel.close(); });
  return { channel, agent };
}

function authorLocally(n: Node, id: string, content: string) {
  mkdirSync(join(localDir(n.agents), "skills", id), { recursive: true });
  writeFileSync(join(localDir(n.agents), "skills", id, "SKILL.md"), content);
}
const read = (...p: string[]) => readFileSync(join(...p), "utf8");

describe("control M3 — node to hub and back", () => {
  it("carries a pushed skill to the hub's inbox — and no further", () => {
    // The load-bearing half. An item that reached the profile on its own would mean any node could
    // broadcast executable instructions to the fleet.
    return (async () => {
      const h = await hub();
      const n = fresh();
      authorLocally(n, "my-thing", "authored on the node");
      const { channel } = connect(h, n, DEVICE);

      await vi.waitFor(() => expect(h.hub.deviceIds()).toContain(DEVICE), { timeout: 10000 });
      const item = readLocalItem(n.agents, "skill", "my-thing");
      if (!item.ok) throw new Error(item.error);
      channel.send({ t: "push", proto: PROTO_VERSION, item: item.item });

      await vi.waitFor(() => expect(h.pending.list()).toHaveLength(1), { timeout: 10000 });
      expect(h.pending.list()[0]).toMatchObject({ deviceId: DEVICE, item: { id: "my-thing" } });
      // Still absent from the served profile: nothing has been adopted.
      expect(h.store.current()!.groups.full.skills).toEqual([]);
    })();
  }, 30000);

  it("reaches the whole fleet once a human adopts it", async () => {
    const h = await hub();
    const author = fresh();
    const other = fresh();
    authorLocally(author, "my-thing", "authored on the node");
    const { channel } = connect(h, author, DEVICE);
    connect(h, other, OTHER);

    await vi.waitFor(() => expect(h.hub.deviceIds().length).toBe(2), { timeout: 10000 });
    const item = readLocalItem(author.agents, "skill", "my-thing");
    if (!item.ok) throw new Error(item.error);
    channel.send({ t: "push", proto: PROTO_VERSION, item: item.item });
    await vi.waitFor(() => expect(h.pending.list()).toHaveLength(1), { timeout: 10000 });

    const adopted = adoptIntoProfile(join(h.dataDir, "profile.json"), "full", h.pending.list()[0].item);
    expect(adopted.ok).toBe(true);
    h.pending.drop(DEVICE, "skill", "my-thing");

    // The OTHER machine — which never had this skill — now gets it.
    await vi.waitFor(
      () => expect(read(other.claude, "skills", "my-thing", "SKILL.md")).toBe("authored on the node"),
      { timeout: 10000 },
    );
  }, 30000);

  it("tells the hub what a node has of its own, by id only", async () => {
    // Ids let the hub say "laptop-home has 2 local skills you have not adopted". Content would mean
    // the fleet quietly hoovering up whatever people write on their machines.
    const h = await hub();
    const n = fresh();
    authorLocally(n, "alpha", "secret alpha");
    authorLocally(n, "beta", "secret beta");
    connect(h, n, DEVICE);

    await vi.waitFor(() => {
      const inv = h.hub.inventoryOf(DEVICE);
      expect(inv?.skills).toEqual(["alpha", "beta"]);
    }, { timeout: 10000 });
    expect(JSON.stringify(h.hub.inventoryOf(DEVICE))).not.toContain("secret");
  }, 30000);

  it("reports a local skill that shadows a fleet one in the inventory", async () => {
    const h = await hub();
    const n = fresh();
    authorLocally(n, "shared", "local version");
    connect(h, n, DEVICE);
    await vi.waitFor(() => expect(h.hub.inventoryOf(DEVICE)).toBeDefined(), { timeout: 10000 });

    adoptIntoProfile(join(h.dataDir, "profile.json"), "full", {
      kind: "skill", id: "shared", files: [{ path: "SKILL.md", content: "fleet version" }],
    });
    await vi.waitFor(() => expect(h.hub.inventoryOf(DEVICE)?.conflicts).toEqual(["shared"]), { timeout: 10000 });
    // And the machine keeps running its own copy.
    expect(read(n.claude, "skills", "shared", "SKILL.md")).toBe("local version");
  }, 30000);

  it("refuses a push whose paths would escape, without storing anything", async () => {
    const h = await hub();
    const n = fresh();
    const { channel } = connect(h, n, DEVICE);
    await vi.waitFor(() => expect(h.hub.deviceIds()).toContain(DEVICE), { timeout: 10000 });

    channel.send({
      t: "push", proto: PROTO_VERSION,
      item: { kind: "skill", id: "evil", files: [{ path: "../escape.md", content: "x" }] },
    });
    await new Promise((r) => setTimeout(r, 400));
    expect(h.pending.list()).toEqual([]);
  }, 30000);

  it("keeps the node's copy after adoption — local is still the node's", async () => {
    const h = await hub();
    const n = fresh();
    authorLocally(n, "my-thing", "v1");
    const { channel } = connect(h, n, DEVICE);
    await vi.waitFor(() => expect(h.hub.deviceIds()).toContain(DEVICE), { timeout: 10000 });
    const item = readLocalItem(n.agents, "skill", "my-thing");
    if (!item.ok) throw new Error(item.error);
    channel.send({ t: "push", proto: PROTO_VERSION, item: item.item });
    await vi.waitFor(() => expect(h.pending.list()).toHaveLength(1), { timeout: 10000 });

    adoptIntoProfile(join(h.dataDir, "profile.json"), "full", item.item);
    await vi.waitFor(() => expect(h.store.current()!.version).toBeGreaterThan(1), { timeout: 5000 });
    // `local/` is the node's, and adoption is not permission to tidy it up.
    expect(read(localDir(n.agents), "skills", "my-thing", "SKILL.md")).toBe("v1");
  }, 30000);
});

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAgent } from "../../src/control/agent/agent.js";
import { memoryChannelPair, type Channel } from "../../src/control/channel.js";
import { PROTO_VERSION } from "../../src/control/proto/index.js";
import { fleetDir, localDir } from "../../src/control/agent/store.js";

const dirs = () => ({ agents: mkdtempSync(join(tmpdir(), "agents-")), claude: mkdtempSync(join(tmpdir(), "claude-")) });
const applyMsg = (version: number, skills: { id: string; files: { path: string; content: string }[] }[], rules: { id: string; content: string }[] = []) =>
  ({ t: "apply", proto: PROTO_VERSION, version, state: { skills, rules, mcpServers: [] } });
const oneSkill = (content: string) => [{ id: "s", files: [{ path: "SKILL.md", content }] }];
const read = (...p: string[]) => readFileSync(join(...p), "utf8");

function harness(agents: string, claude: string) {
  const [hubSide, nodeSide] = memoryChannelPair();
  const fromNode: unknown[] = [];
  hubSide.onMessage((m) => fromNode.push(m));
  const agent = startAgent({
    agentsHome: agents, claudeHome: claude, channel: nodeSide as Channel,
    deviceId: "laptop-home", agentVersion: "0.1.0",
  });
  return { hub: hubSide, agent, fromNode };
}

const storedSkill = (agents: string) => join(fleetDir(agents), "skills", "s", "SKILL.md");
const projectedSkill = (claude: string) => join(claude, "skills", "s", "SKILL.md");

describe("agent — store then project", () => {
  it("writes the hub's state into the store AND projects it into the tool", () => {
    const { agents, claude } = dirs();
    const { hub, agent } = harness(agents, claude);
    hub.send(applyMsg(1, oneSkill("hello")));
    return vi.waitFor(() => {
      expect(read(storedSkill(agents))).toBe("hello");
      expect(read(projectedSkill(claude))).toBe("hello");
      agent.stop();
    });
  });

  it("projects rules into a generated CLAUDE.md", () => {
    const { agents, claude } = dirs();
    const { hub, agent } = harness(agents, claude);
    hub.send(applyMsg(1, [], [{ id: "commit", content: "commit rule" }]));
    return vi.waitFor(() => {
      expect(read(claude, "CLAUDE.md")).toContain("commit rule");
      agent.stop();
    });
  });

  it("reports store and projection counts separately", () => {
    const { agents, claude } = dirs();
    const { hub, agent } = harness(agents, claude);
    hub.send(applyMsg(1, oneSkill("hello")));
    return vi.waitFor(() => {
      expect(agent.status()).toMatchObject({ state: "applied", version: 1, written: 1, projected: 1 });
      agent.stop();
    });
  });

  it("reports the outcome back to the hub", () => {
    const { agents, claude } = dirs();
    const { hub, agent, fromNode } = harness(agents, claude);
    hub.send(applyMsg(1, oneSkill("hello")));
    return vi.waitFor(() => {
      const report = fromNode.find((m) => (m as { t: string }).t === "applied") as Record<string, unknown>;
      expect(report).toMatchObject({ version: 1, ok: true, written: 1, deleted: 0 });
      agent.stop();
    });
  });
});

describe("agent — the node's own half is never touched", () => {
  it("leaves ~/.agents/local alone through a full takeover", () => {
    // The whole reason the store is layered: "the hub decides" and "I can add a skill here" have to
    // be able to coexist, and before M2 they could not.
    const { agents, claude } = dirs();
    mkdirSync(join(localDir(agents), "skills", "mine"), { recursive: true });
    writeFileSync(join(localDir(agents), "skills", "mine", "SKILL.md"), "my own");
    const { hub, agent } = harness(agents, claude);
    hub.send(applyMsg(1, oneSkill("hub")));
    return vi.waitFor(() => {
      expect(read(localDir(agents), "skills", "mine", "SKILL.md")).toBe("my own");
      expect(read(claude, "skills", "mine", "SKILL.md")).toBe("my own"); // and it reaches the tool
      agent.stop();
    });
  });

  it("surfaces a local skill that shadows a hub one, instead of hiding it", () => {
    const { agents, claude } = dirs();
    mkdirSync(join(localDir(agents), "skills", "s"), { recursive: true });
    writeFileSync(join(localDir(agents), "skills", "s", "SKILL.md"), "mine wins");
    const { hub, agent, fromNode } = harness(agents, claude);
    hub.send(applyMsg(1, oneSkill("hub version")));
    return vi.waitFor(() => {
      expect(read(projectedSkill(claude))).toBe("mine wins");
      expect(agent.status().conflicts).toEqual(["s"]);
      const report = fromNode.find((m) => (m as { t: string }).t === "applied") as { warnings: string[] };
      expect(report.warnings.join(" ")).toMatch(/overrides the fleet copy/);
      agent.stop();
    });
  });
});

describe("agent — semantics carried over from M1", () => {
  it("does nothing at all when the hub says the device is unassigned", () => {
    const { agents, claude } = dirs();
    mkdirSync(join(claude, "skills", "local"), { recursive: true });
    writeFileSync(join(claude, "skills", "local", "SKILL.md"), "my own skill");
    const { hub, agent } = harness(agents, claude);
    hub.send({ t: "unassigned", proto: PROTO_VERSION });
    return vi.waitFor(() => {
      expect(agent.status().state).toBe("unassigned");
      expect(read(claude, "skills", "local", "SKILL.md")).toBe("my own skill");
      agent.stop();
    });
  });

  it("re-applying corrects drift in both the store and the tool", () => {
    const { agents, claude } = dirs();
    const { hub, agent } = harness(agents, claude);
    hub.send(applyMsg(1, oneSkill("canonical")));
    return vi.waitFor(() => expect(existsSync(projectedSkill(claude))).toBe(true)).then(() => {
      writeFileSync(storedSkill(agents), "tampered");
      writeFileSync(projectedSkill(claude), "also tampered");
      hub.send(applyMsg(1, oneSkill("canonical")));
      return vi.waitFor(() => {
        expect(read(storedSkill(agents))).toBe("canonical");
        expect(read(projectedSkill(claude))).toBe("canonical");
        agent.stop();
      });
    });
  });

  it("reports a rejected apply as a failure instead of silently doing nothing", () => {
    const { agents, claude } = dirs();
    const { hub, agent, fromNode } = harness(agents, claude);
    hub.send(applyMsg(1, [{ id: "s", files: [{ path: "../escape.md", content: "x" }] }]));
    return vi.waitFor(() => {
      const report = fromNode.find((m) => (m as { ok?: boolean }).ok === false) as Record<string, unknown>;
      expect(report.error).toMatch(/path/i);
      expect(agent.status().state).toBe("error");
      expect(existsSync(join(agents, "escape.md"))).toBe(false);
      agent.stop();
    });
  });

  it("ignores malformed and wrong-protocol frames without crashing", async () => {
    const { agents, claude } = dirs();
    const { hub, agent } = harness(agents, claude);
    expect(() => hub.send({ t: "nonsense" })).not.toThrow();
    expect(() => hub.send(null)).not.toThrow();
    expect(() => hub.send({ t: "apply", proto: PROTO_VERSION + 1, version: 1, state: { skills: [], rules: [], mcpServers: [] } })).not.toThrow();
    await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(fleetDir(agents))).toBe(false);
    agent.stop();
  });

  it("keeps a backup of what it destroyed", () => {
    const { agents, claude } = dirs();
    mkdirSync(join(fleetDir(agents), "skills", "old"), { recursive: true });
    writeFileSync(join(fleetDir(agents), "skills", "old", "SKILL.md"), "precious");
    const { hub, agent } = harness(agents, claude);
    hub.send(applyMsg(1, oneSkill("new")));
    return vi.waitFor(() => {
      expect(existsSync(join(fleetDir(agents), "skills", "old"))).toBe(false);
      expect(existsSync(join(agents, ".cc-fleet", "backups"))).toBe(true);
      agent.stop();
    });
  });

  it("stops applying once stopped", async () => {
    const { agents, claude } = dirs();
    const { hub, agent } = harness(agents, claude);
    agent.stop();
    hub.send(applyMsg(1, oneSkill("x")));
    await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(fleetDir(agents))).toBe(false);
  });

  it("survives a home that disappears mid-flight, reporting the failure", () => {
    const { agents, claude } = dirs();
    const { hub, agent, fromNode } = harness(agents, claude);
    hub.send(applyMsg(1, oneSkill("x")));
    return vi.waitFor(() => expect(fromNode.some((m) => (m as { t: string }).t === "applied")).toBe(true)).then(() => {
      rmSync(agents, { recursive: true, force: true });
      rmSync(claude, { recursive: true, force: true });
      expect(() => hub.send(applyMsg(2, oneSkill("y")))).not.toThrow();
      agent.stop();
    });
  });
});

describe("agent — migration from the M1 layout", () => {
  it("rescues a hand-placed skill into local/ instead of deleting it", () => {
    const { claude } = dirs();
    const agents = join(mkdtempSync(join(tmpdir(), "root-")), ".agents"); // store does not exist yet
    mkdirSync(join(claude, "skills", "my-experiment"), { recursive: true });
    writeFileSync(join(claude, "skills", "my-experiment", "SKILL.md"), "hand written");

    const moved: string[][] = [];
    const [hubSide, nodeSide] = memoryChannelPair();
    const agent = startAgent({
      agentsHome: agents, claudeHome: claude, channel: nodeSide as Channel,
      deviceId: "d", agentVersion: "0.1.0", onMigrate: (ids) => moved.push(ids),
    });
    hubSide.send(applyMsg(1, oneSkill("from hub")));
    return vi.waitFor(() => {
      expect(moved).toEqual([["my-experiment"]]);
      expect(read(localDir(agents), "skills", "my-experiment", "SKILL.md")).toBe("hand written");
      expect(read(claude, "skills", "my-experiment", "SKILL.md")).toBe("hand written"); // reprojected
      agent.stop();
    });
  });
});

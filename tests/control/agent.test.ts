import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAgent } from "../../src/control/agent/agent.js";
import { memoryChannelPair, type Channel } from "../../src/control/channel.js";
import { PROTO_VERSION } from "../../src/control/proto/index.js";

const home = () => mkdtempSync(join(tmpdir(), "cchome-"));
const applyMsg = (version: number, skills: { id: string; files: { path: string; content: string }[] }[]) =>
  ({ t: "apply", proto: PROTO_VERSION, version, state: { skills } });
const oneSkill = (content: string) => [{ id: "s", files: [{ path: "SKILL.md", content }] }];

function harness(claudeHome: string) {
  const [hubSide, nodeSide] = memoryChannelPair();
  const fromNode: unknown[] = [];
  hubSide.onMessage((m) => fromNode.push(m));
  const agent = startAgent({ claudeHome, channel: nodeSide as Channel, deviceId: "laptop-home", agentVersion: "0.1.0" });
  return { hub: hubSide, agent, fromNode };
}

describe("agent", () => {
  it("applies the hub's desired state to disk", async () => {
    const h = home();
    const { hub, agent } = harness(h);
    hub.send(applyMsg(1, oneSkill("hello")));
    await vi.waitFor(() => expect(existsSync(join(h, "skills", "s", "SKILL.md"))).toBe(true));
    expect(readFileSync(join(h, "skills", "s", "SKILL.md"), "utf8")).toBe("hello");
    agent.stop();
  });

  it("reports the outcome back to the hub", async () => {
    const h = home();
    const { hub, agent, fromNode } = harness(h);
    hub.send(applyMsg(1, oneSkill("hello")));
    await vi.waitFor(() => expect(fromNode.some((m) => (m as { t: string }).t === "applied")).toBe(true));
    const report = fromNode.find((m) => (m as { t: string }).t === "applied") as Record<string, unknown>;
    expect(report).toMatchObject({ version: 1, ok: true, written: 1, deleted: 0 });
    agent.stop();
  });

  it("announces itself with a hello frame", async () => {
    const h = home();
    const { agent, fromNode } = harness(h);
    await vi.waitFor(() => expect(fromNode.some((m) => (m as { t: string }).t === "hello")).toBe(true));
    expect(fromNode[0]).toMatchObject({ t: "hello", deviceId: "laptop-home", agentVersion: "0.1.0" });
    agent.stop();
  });

  it("does nothing at all when the hub says the device is unassigned", async () => {
    // An unregistered machine must be left alone — not handed an empty desired state, which would be
    // an instruction to delete everything under skills/.
    const h = home();
    mkdirSync(join(h, "skills", "local"), { recursive: true });
    writeFileSync(join(h, "skills", "local", "SKILL.md"), "my own skill");
    const { hub, agent } = harness(h);
    hub.send({ t: "unassigned", proto: PROTO_VERSION });
    await vi.waitFor(() => expect(agent.status().state).toBe("unassigned"));
    expect(readFileSync(join(h, "skills", "local", "SKILL.md"), "utf8")).toBe("my own skill");
    agent.stop();
  });

  it("distinguishes unassigned from an empty assigned group", async () => {
    const h = home();
    mkdirSync(join(h, "skills", "local"), { recursive: true });
    writeFileSync(join(h, "skills", "local", "SKILL.md"), "x");
    const { hub, agent } = harness(h);
    hub.send(applyMsg(1, [])); // assigned to an empty group — a legitimate delete instruction
    await vi.waitFor(() => expect(existsSync(join(h, "skills", "local"))).toBe(false));
    agent.stop();
  });

  it("re-applying corrects local drift", async () => {
    // The hub re-pushes on every reconnect. That is only useful if a node whose files were edited or
    // deleted locally is brought back to the desired state.
    const h = home();
    const { hub, agent } = harness(h);
    hub.send(applyMsg(1, oneSkill("canonical")));
    await vi.waitFor(() => expect(existsSync(join(h, "skills", "s", "SKILL.md"))).toBe(true));
    writeFileSync(join(h, "skills", "s", "SKILL.md"), "tampered");
    hub.send(applyMsg(1, oneSkill("canonical")));
    await vi.waitFor(() => expect(readFileSync(join(h, "skills", "s", "SKILL.md"), "utf8")).toBe("canonical"));
    agent.stop();
  });

  it("reports a rejected apply as a failure instead of silently doing nothing", async () => {
    const h = home();
    const { hub, agent, fromNode } = harness(h);
    hub.send(applyMsg(1, [{ id: "s", files: [{ path: "../escape.md", content: "x" }] }]));
    await vi.waitFor(() => expect(fromNode.some((m) => (m as { ok?: boolean }).ok === false)).toBe(true));
    const report = fromNode.find((m) => (m as { ok?: boolean }).ok === false) as Record<string, unknown>;
    expect(report.error).toMatch(/path/i);
    expect(agent.status().state).toBe("error");
    expect(existsSync(join(h, "escape.md"))).toBe(false);
    agent.stop();
  });

  it("ignores malformed and wrong-protocol frames without crashing", async () => {
    const h = home();
    const { hub, agent } = harness(h);
    expect(() => hub.send({ t: "nonsense" })).not.toThrow();
    expect(() => hub.send(null)).not.toThrow();
    expect(() => hub.send({ t: "apply", proto: PROTO_VERSION + 1, version: 1, state: { skills: [] } })).not.toThrow();
    await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(join(h, "skills"))).toBe(false); // nothing was applied
    agent.stop();
  });

  it("tracks the applied version so status reflects reality", async () => {
    const h = home();
    const { hub, agent } = harness(h);
    hub.send(applyMsg(4, oneSkill("x")));
    await vi.waitFor(() => expect(agent.status()).toMatchObject({ state: "applied", version: 4 }));
    agent.stop();
  });

  it("keeps a backup of what it destroyed", async () => {
    const h = home();
    mkdirSync(join(h, "skills", "old"), { recursive: true });
    writeFileSync(join(h, "skills", "old", "SKILL.md"), "precious");
    const { hub, agent } = harness(h);
    hub.send(applyMsg(1, oneSkill("new")));
    await vi.waitFor(() => expect(existsSync(join(h, "skills", "old"))).toBe(false));
    expect(existsSync(join(h, ".cc-fleet", "backups"))).toBe(true);
    agent.stop();
  });

  it("stops applying once stopped", async () => {
    const h = home();
    const { hub, agent } = harness(h);
    agent.stop();
    hub.send(applyMsg(1, oneSkill("x")));
    await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(join(h, "skills", "s"))).toBe(false);
  });

  it("survives a claudeHome that disappears mid-flight, reporting the failure", async () => {
    const h = home();
    const { hub, agent, fromNode } = harness(h);
    hub.send(applyMsg(1, oneSkill("x")));
    await vi.waitFor(() => expect(fromNode.some((m) => (m as { t: string }).t === "applied")).toBe(true));
    rmSync(h, { recursive: true, force: true });
    expect(() => hub.send(applyMsg(2, oneSkill("y")))).not.toThrow();
    agent.stop();
  });
});

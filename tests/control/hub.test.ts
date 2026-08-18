import { describe, it, expect, vi } from "vitest";
import { Hub } from "../../src/control/hub/hub.js";
import { memoryChannelPair, type Peer, type Channel } from "../../src/control/channel.js";
import { PROTO_VERSION, parseProfile, type Profile } from "../../src/control/proto/index.js";

const raw = (over: Record<string, unknown> = {}) => ({
  version: 1,
  groups: {
    full: { skills: [{ id: "code-review", files: [{ path: "SKILL.md", content: "v1" }] }] },
    minimal: { skills: [] },
  },
  assignments: { "laptop-home": "full", "vm-azure": "minimal" },
  ...over,
});
function profile(over: Record<string, unknown> = {}): Profile {
  const r = parseProfile(raw(over));
  if (!r.ok) throw new Error(r.error);
  return r.profile;
}

// A Peer backed by an in-memory pair: `peer` is handed to the hub, `node` is the test's end.
function connect(deviceId: string): { peer: Peer; node: Channel; received: unknown[] } {
  const [hubSide, nodeSide] = memoryChannelPair();
  const received: unknown[] = [];
  nodeSide.onMessage((m) => received.push(m));
  return { peer: Object.assign(hubSide, { deviceId }) as Peer, node: nodeSide, received };
}

describe("Hub", () => {
  it("pushes the assigned desired state as soon as a peer connects", () => {
    // Connect-time push (not just change-time) is what makes a node that was offline during an edit
    // converge on reconnect instead of waiting for the next unrelated change.
    const hub = new Hub(() => profile());
    const { peer, received } = connect("laptop-home");
    hub.accept(peer);
    expect(received).toEqual([
      { t: "apply", proto: PROTO_VERSION, version: 1, state: profile().groups.full },
    ]);
  });

  it("tells an unassigned device it is unassigned, and sends it no state", () => {
    const hub = new Hub(() => profile());
    const { peer, received } = connect("some-random-box");
    hub.accept(peer);
    expect(received).toEqual([{ t: "unassigned", proto: PROTO_VERSION }]);
  });

  it("matches the device id case-insensitively", () => {
    const hub = new Hub(() => profile());
    const { peer, received } = connect("LAPTOP-HOME");
    hub.accept(peer);
    expect((received[0] as { t: string }).t).toBe("apply");
  });

  it("sends an empty state to a device assigned to an empty group", () => {
    // Distinct from `unassigned`: "you are managed, and the answer is nothing" legitimately means
    // full-takeover-delete, whereas `unassigned` means "do not touch this machine".
    const hub = new Hub(() => profile());
    const { peer, received } = connect("vm-azure");
    hub.accept(peer);
    expect(received).toEqual([{ t: "apply", proto: PROTO_VERSION, version: 1, state: { skills: [] } }]);
  });

  it("broadcasts to every connected peer when the profile changes", () => {
    let current = profile();
    const hub = new Hub(() => current);
    const a = connect("laptop-home");
    const b = connect("vm-azure");
    hub.accept(a.peer);
    hub.accept(b.peer);
    current = profile({ version: 2 });
    hub.publish();
    expect(a.received).toHaveLength(2);
    expect((a.received[1] as { version: number }).version).toBe(2);
    expect((b.received[1] as { version: number }).version).toBe(2);
  });

  it("re-evaluates assignment on publish, so a reassigned device switches groups", () => {
    let current = profile();
    const hub = new Hub(() => current);
    const a = connect("laptop-home");
    hub.accept(a.peer);
    current = profile({ assignments: { "laptop-home": "minimal" } });
    hub.publish();
    expect((a.received[1] as { state: { skills: unknown[] } }).state.skills).toEqual([]);
  });

  it("tells a device that lost its assignment to stand down", () => {
    let current = profile();
    const hub = new Hub(() => current);
    const a = connect("laptop-home");
    hub.accept(a.peer);
    current = profile({ assignments: {} });
    hub.publish();
    expect(a.received[1]).toEqual({ t: "unassigned", proto: PROTO_VERSION });
  });

  it("drops a peer when it closes and stops broadcasting to it", () => {
    let current = profile();
    const hub = new Hub(() => current);
    const a = connect("laptop-home");
    hub.accept(a.peer);
    expect(hub.deviceIds()).toEqual(["laptop-home"]);
    a.node.close();
    expect(hub.deviceIds()).toEqual([]);
    current = profile({ version: 2 });
    expect(() => hub.publish()).not.toThrow();
    expect(a.received).toHaveLength(1); // nothing after close
  });

  it("keeps broadcasting to healthy peers when one peer's send throws", () => {
    const hub = new Hub(() => profile());
    const bad = connect("laptop-home");
    bad.peer.send = () => { throw new Error("socket gone"); };
    const good = connect("vm-azure");
    hub.accept(bad.peer);
    hub.accept(good.peer);
    expect(() => hub.publish()).not.toThrow();
    expect(good.received.length).toBeGreaterThanOrEqual(1);
  });

  it("serves nothing at all while no profile has ever loaded", () => {
    // Fail-safe: an unconfigured hub must not tell nodes "your desired state is empty" — that is a
    // full-takeover delete instruction.
    const hub = new Hub(() => null);
    const { peer, received } = connect("laptop-home");
    hub.accept(peer);
    expect(received).toEqual([]);
  });

  it("records the last applied report per device", () => {
    const hub = new Hub(() => profile());
    const a = connect("laptop-home");
    hub.accept(a.peer);
    a.node.send({ t: "applied", proto: PROTO_VERSION, version: 1, ok: true, written: 1, deleted: 0, warnings: [] });
    expect(hub.lastApplied("laptop-home")).toMatchObject({ version: 1, ok: true, written: 1 });
  });

  it("ignores malformed node frames rather than crashing the hub", () => {
    const hub = new Hub(() => profile());
    const a = connect("laptop-home");
    hub.accept(a.peer);
    expect(() => a.node.send({ t: "garbage" })).not.toThrow();
    expect(() => a.node.send(null)).not.toThrow();
    expect(hub.lastApplied("laptop-home")).toBeUndefined();
  });

  it("surfaces a failed apply report so it is not mistaken for success", () => {
    const hub = new Hub(() => profile());
    const a = connect("laptop-home");
    const onReport = vi.fn();
    hub.onReport(onReport);
    hub.accept(a.peer);
    a.node.send({ t: "applied", proto: PROTO_VERSION, version: 1, ok: false, written: 0, deleted: 0, warnings: [], error: "escapes skills/" });
    expect(onReport).toHaveBeenCalledWith("laptop-home", expect.objectContaining({ ok: false, error: "escapes skills/" }));
  });
});

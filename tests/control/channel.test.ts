import { describe, it, expect, vi } from "vitest";
import { memoryChannelPair, type Channel } from "../../src/control/channel.js";

describe("channel (in-memory pair)", () => {
  it("delivers messages in both directions", () => {
    const [a, b] = memoryChannelPair();
    const seenByB: unknown[] = [];
    const seenByA: unknown[] = [];
    b.onMessage((m) => seenByB.push(m));
    a.onMessage((m) => seenByA.push(m));
    a.send({ hello: 1 });
    b.send({ world: 2 });
    expect(seenByB).toEqual([{ hello: 1 }]);
    expect(seenByA).toEqual([{ world: 2 }]);
  });

  it("stops delivering after unsubscribe", () => {
    const [a, b] = memoryChannelPair();
    const spy = vi.fn();
    const off = b.onMessage(spy);
    a.send(1);
    off();
    a.send(2);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("supports multiple independent subscribers", () => {
    const [a, b] = memoryChannelPair();
    const one = vi.fn(), two = vi.fn();
    b.onMessage(one);
    b.onMessage(two);
    a.send("x");
    expect(one).toHaveBeenCalledWith("x");
    expect(two).toHaveBeenCalledWith("x");
  });

  it("delivers nothing once closed, and closing twice is safe", () => {
    const [a, b] = memoryChannelPair();
    const spy = vi.fn();
    b.onMessage(spy);
    a.close();
    a.send("dropped");
    expect(spy).not.toHaveBeenCalled();
    expect(() => a.close()).not.toThrow();
  });

  it("notifies the peer's close handler when either side closes", () => {
    const [a, b] = memoryChannelPair();
    const spy = vi.fn();
    b.onClose(spy);
    a.close();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("isolates a throwing subscriber so one bad handler cannot kill delivery to the others", () => {
    // The hub broadcasts to every connected peer through this path; one dead socket must not
    // abort the loop and starve the remaining nodes.
    const [a, b] = memoryChannelPair();
    const good = vi.fn();
    b.onMessage(() => { throw new Error("boom"); });
    b.onMessage(good);
    expect(() => a.send("x")).not.toThrow();
    expect(good).toHaveBeenCalledWith("x");
  });

  it("conforms to the Channel shape (so transports are drop-in replaceable)", () => {
    const [a] = memoryChannelPair();
    const asChannel: Channel = a;
    expect(typeof asChannel.send).toBe("function");
    expect(typeof asChannel.onMessage).toBe("function");
    expect(typeof asChannel.onClose).toBe("function");
    expect(typeof asChannel.close).toBe("function");
  });
});

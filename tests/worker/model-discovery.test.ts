import { describe, expect, it } from "vitest";
import { discoveryBeforeReady } from "../../src/worker/model-discovery.js";

const deferred = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
};

describe("worker model discovery readiness", () => {
  it("waits for discovery before declaring a map-enabled worker ready", async () => {
    const gate = deferred();
    let ready = false;
    const waiting = discoveryBeforeReady(true, () => gate.promise).then(() => { ready = true; });
    await Promise.resolve();
    expect(ready).toBe(false);
    gate.release();
    await waiting;
    expect(ready).toBe(true);
  });

  it("keeps the existing non-blocking startup when the map is disabled", async () => {
    const gate = deferred();
    await discoveryBeforeReady(false, () => gate.promise);
    gate.release();
  });

  it("fails open to a ready worker when discovery itself fails", async () => {
    await expect(discoveryBeforeReady(true, async () => { throw new Error("offline"); })).resolves.toBeUndefined();
  });
});

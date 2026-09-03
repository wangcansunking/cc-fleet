import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceAuthRequests, AUTH_TTL_MS, POLL_INTERVAL_MS } from "../../src/control/hub/device-auth.js";

const dir = () => mkdtempSync(join(tmpdir(), "ccauth-"));
const req = { hostname: "laptop-home", os: "linux", agentVersion: "0.1.0" };

describe("device authorization — the request", () => {
  it("hands the node a secret to poll with and a human a code to approve", () => {
    const r = new DeviceAuthRequests(dir()).start(req);
    expect(r.deviceCode.length).toBeGreaterThan(30);
    expect(r.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(r.intervalMs).toBe(POLL_INTERVAL_MS);
  });

  it("keeps the user code free of characters a human would mistype", () => {
    const a = new DeviceAuthRequests(dir());
    for (let i = 0; i < 100; i++) expect(a.start(req).userCode).not.toMatch(/[01OIL]/);
  });

  it("never stores the device code itself", () => {
    // Same rule as device tokens: the file is a verifier, not a vault. Whoever holds the device code
    // can claim the credential, so it must not be sitting on the hub's disk.
    const d = dir();
    const r = new DeviceAuthRequests(d).start(req);
    const raw = readFileSync(join(d, "device-auth.json"), "utf8");
    expect(raw).not.toContain(r.deviceCode);
    expect(raw).toContain("sha256:");
  });

  it("shows a human what they are about to approve", () => {
    // A bare "approve Y/N" invites reflex approval. The hostname is the only thing distinguishing a
    // machine you just set up from one you did not.
    const a = new DeviceAuthRequests(dir());
    a.start(req);
    expect(a.listPending()[0]).toMatchObject({ hostname: "laptop-home", os: "linux" });
  });

  it("does not reuse a live user code", () => {
    const a = new DeviceAuthRequests(dir());
    const codes = new Set(Array.from({ length: 40 }, () => a.start(req).userCode));
    expect(codes.size).toBe(40);
  });
});

describe("device authorization — polling", () => {
  it("says pending until someone approves", () => {
    let now = 0;
    const a = new DeviceAuthRequests(dir(), () => now);
    const { deviceCode } = a.start(req);
    expect(a.poll(deviceCode).state).toBe("pending");
  });

  it("hands over the approval exactly once", () => {
    // A redeemed device code must be dead. Otherwise a leaked one stays useful forever.
    let now = 0;
    const a = new DeviceAuthRequests(dir(), () => now);
    const { deviceCode, userCode } = a.start(req);
    a.approve(userCode);
    now += POLL_INTERVAL_MS;
    expect(a.poll(deviceCode).state).toBe("approved");
    now += POLL_INTERVAL_MS;
    expect(a.poll(deviceCode).state).toBe("unknown");
  });

  it("tells an impatient node to slow down instead of serving it", () => {
    let now = 0;
    const a = new DeviceAuthRequests(dir(), () => now);
    const { deviceCode } = a.start(req);
    expect(a.poll(deviceCode).state).toBe("pending");
    expect(a.poll(deviceCode).state).toBe("slow_down"); // same millisecond
    now += POLL_INTERVAL_MS;
    expect(a.poll(deviceCode).state).toBe("pending");
  });

  it("reports denial distinctly, so the node can stop rather than retry", () => {
    let now = 0;
    const a = new DeviceAuthRequests(dir(), () => now);
    const { deviceCode, userCode } = a.start(req);
    a.deny(userCode);
    now += POLL_INTERVAL_MS;
    expect(a.poll(deviceCode).state).toBe("denied");
  });

  it("expires an unapproved request", () => {
    let now = 0;
    const a = new DeviceAuthRequests(dir(), () => now);
    const { deviceCode } = a.start(req);
    now = AUTH_TTL_MS + 1;
    expect(a.poll(deviceCode).state).toBe("expired");
  });

  it("refuses to approve an expired request", () => {
    let now = 0;
    const a = new DeviceAuthRequests(dir(), () => now);
    const { userCode } = a.start(req);
    now = AUTH_TTL_MS + 1;
    expect(a.approve(userCode)).toBeNull();
  });

  it("treats an unknown device code as unknown, revealing nothing", () => {
    expect(new DeviceAuthRequests(dir()).poll("never-issued").state).toBe("unknown");
  });
});

describe("device authorization — approval", () => {
  it("accepts the code as a human would retype it", () => {
    const a = new DeviceAuthRequests(dir());
    const { userCode } = a.start(req);
    expect(a.approve(userCode.toLowerCase().replace("-", " "))).not.toBeNull();
  });

  it("reports an unknown code rather than silently succeeding", () => {
    expect(new DeviceAuthRequests(dir()).approve("ZZZZ-ZZZZ")).toBeNull();
  });

  it("cannot approve the same request twice", () => {
    const a = new DeviceAuthRequests(dir());
    const { userCode } = a.start(req);
    expect(a.approve(userCode)).not.toBeNull();
    expect(a.approve(userCode)).toBeNull();
  });

  it("approves only the request named, leaving others pending", () => {
    const a = new DeviceAuthRequests(dir());
    const first = a.start(req);
    const second = a.start({ ...req, hostname: "vm-azure" });
    a.approve(first.userCode);
    expect(a.listPending().map((r) => r.hostname)).toEqual(["vm-azure"]);
    expect(a.poll(second.deviceCode).state).toBe("pending");
  });

  it("survives across processes, because approving happens in a different one", () => {
    // `cc-fleet approve` is not the hub process. An in-memory queue would make approval impossible.
    const d = dir();
    const { deviceCode, userCode } = new DeviceAuthRequests(d).start(req);
    expect(new DeviceAuthRequests(d).approve(userCode)).not.toBeNull();
    expect(new DeviceAuthRequests(d).poll(deviceCode).state).toBe("approved");
  });
});

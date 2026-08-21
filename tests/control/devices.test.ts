import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceRegistry } from "../../src/control/hub/devices.js";

const dir = () => mkdtempSync(join(tmpdir(), "ccdev-"));
const enroll = (r: DeviceRegistry, hostname = "laptop-home") =>
  r.enroll({ hostname, os: "win32", agentVersion: "0.1.0" });

describe("device registry — enrolment", () => {
  it("issues a device id and a token", () => {
    const r = new DeviceRegistry(dir());
    const d = enroll(r);
    expect(d.deviceId).toBe("laptop-home");
    expect(d.deviceToken.length).toBeGreaterThan(20);
  });

  it("uses the hostname as the device id, so hand-written assignments stay readable", () => {
    // The profile's `assignments` are hand-edited in this phase. A random uuid would make writing
    // one impossible.
    const r = new DeviceRegistry(dir());
    expect(enroll(r, "vm-azure").deviceId).toBe("vm-azure");
  });

  it("suffixes a second machine that reports the same hostname", () => {
    const r = new DeviceRegistry(dir());
    expect(enroll(r).deviceId).toBe("laptop-home");
    expect(enroll(r).deviceId).toBe("laptop-home-2");
    expect(enroll(r).deviceId).toBe("laptop-home-3");
  });

  it("sanitizes a hostname that would be awkward as an identifier", () => {
    const r = new DeviceRegistry(dir());
    expect(enroll(r, "My Laptop (work)!").deviceId).toMatch(/^[a-zA-Z0-9._-]+$/);
  });

  it("falls back to a usable id when the hostname sanitizes to nothing", () => {
    const r = new DeviceRegistry(dir());
    expect(enroll(r, "///").deviceId.length).toBeGreaterThan(0);
  });
});

describe("device registry — the token is never stored", () => {
  it("persists only a hash, never the token itself", () => {
    // A leaked registry must not be a leaked fleet. The node holds the plaintext; the hub holds a
    // digest and can only ever verify, never reproduce.
    const d = dir();
    const r = new DeviceRegistry(d);
    const { deviceToken } = enroll(r);
    const raw = readFileSync(join(d, "devices.json"), "utf8");
    expect(raw).not.toContain(deviceToken);
    expect(raw).toMatch(/sha256:/);
  });

  it("writes the registry 0600", () => {
    const d = dir();
    enroll(new DeviceRegistry(d));
    const mode = statSync(join(d, "devices.json")).mode & 0o777;
    if (process.platform !== "win32") expect(mode).toBe(0o600);
    else expect(existsSync(join(d, "devices.json"))).toBe(true);
  });

  it("accepts the exact token and nothing else", () => {
    const r = new DeviceRegistry(dir());
    const { deviceToken, deviceId } = enroll(r);
    expect(r.verify(deviceToken)?.deviceId).toBe(deviceId);
    expect(r.verify(deviceToken + "x")).toBeNull();
    expect(r.verify(deviceToken.slice(0, -1))).toBeNull();
    expect(r.verify("")).toBeNull();
    expect(r.verify("not-a-token")).toBeNull();
  });

  it("keeps each device's token to itself", () => {
    const r = new DeviceRegistry(dir());
    const a = enroll(r, "a");
    const b = enroll(r, "b");
    expect(r.verify(a.deviceToken)?.deviceId).toBe("a");
    expect(r.verify(b.deviceToken)?.deviceId).toBe("b");
    expect(a.deviceToken).not.toBe(b.deviceToken);
  });
});

describe("device registry — revocation", () => {
  it("stops accepting a revoked device's token", () => {
    const r = new DeviceRegistry(dir());
    const { deviceToken, deviceId } = enroll(r);
    expect(r.revoke(deviceId)).toBe(true);
    expect(r.verify(deviceToken)).toBeNull();
  });

  it("keeps the record after revocation, for the audit trail", () => {
    const r = new DeviceRegistry(dir());
    const { deviceId } = enroll(r);
    r.revoke(deviceId);
    const rec = r.list().find((d) => d.deviceId === deviceId);
    expect(rec).toBeDefined();
    expect(rec!.revokedAt).toBeGreaterThan(0);
  });

  it("revokes only the named device", () => {
    const r = new DeviceRegistry(dir());
    const a = enroll(r, "a");
    const b = enroll(r, "b");
    r.revoke("a");
    expect(r.verify(a.deviceToken)).toBeNull();
    expect(r.verify(b.deviceToken)?.deviceId).toBe("b");
  });

  it("reports an unknown device rather than silently succeeding", () => {
    expect(new DeviceRegistry(dir()).revoke("never-existed")).toBe(false);
  });

  it("lets a revoked machine re-enrol as a new record", () => {
    const r = new DeviceRegistry(dir());
    const first = enroll(r);
    r.revoke(first.deviceId);
    const second = enroll(r);
    expect(second.deviceToken).not.toBe(first.deviceToken);
    expect(r.verify(second.deviceToken)).not.toBeNull();
    expect(r.verify(first.deviceToken)).toBeNull(); // the old credential stays dead
  });

  it("reuses a revoked device's id rather than hoarding it", () => {
    const r = new DeviceRegistry(dir());
    r.revoke(enroll(r).deviceId);
    expect(enroll(r).deviceId).toBe("laptop-home"); // not laptop-home-2
  });
});

describe("device registry — durability", () => {
  it("survives a process restart", () => {
    const d = dir();
    const { deviceToken, deviceId } = enroll(new DeviceRegistry(d));
    expect(new DeviceRegistry(d).verify(deviceToken)?.deviceId).toBe(deviceId);
  });

  it("sees a revocation made by another process without restarting", () => {
    // `cc-fleet revoke` runs in a DIFFERENT process from the running hub. If auth cached the
    // registry, revoking would not take effect until the hub restarted — which is exactly when you
    // least want to wait.
    const d = dir();
    const hub = new DeviceRegistry(d);
    const { deviceToken, deviceId } = enroll(hub);
    new DeviceRegistry(d).revoke(deviceId); // the CLI's process
    expect(hub.verify(deviceToken)).toBeNull();
  });

  it("treats a corrupt registry as empty rather than crashing the hub", () => {
    const d = dir();
    enroll(new DeviceRegistry(d));
    writeFileSync(join(d, "devices.json"), "{ half-written");
    expect(new DeviceRegistry(d).list()).toEqual([]);
  });

  it("leaves no temp file behind after a write", () => {
    const d = dir();
    enroll(new DeviceRegistry(d));
    expect(existsSync(join(d, ".devices.json.tmp"))).toBe(false);
  });
});

describe("device registry — liveness", () => {
  it("records when a device was last seen", () => {
    let now = 1000;
    const r = new DeviceRegistry(dir(), () => now);
    const { deviceId } = enroll(r);
    now = 5000;
    r.touch(deviceId);
    expect(r.list().find((d) => d.deviceId === deviceId)!.lastSeenAt).toBe(5000);
  });

  it("ignores a touch for an unknown device", () => {
    expect(() => new DeviceRegistry(dir()).touch("ghost")).not.toThrow();
  });

  it("lists devices with the facts the operator needs", () => {
    const r = new DeviceRegistry(dir());
    enroll(r);
    const [rec] = r.list();
    expect(rec).toMatchObject({ deviceId: "laptop-home", hostname: "laptop-home", os: "win32", agentVersion: "0.1.0", revokedAt: null });
    expect(rec.enrolledAt).toBeGreaterThan(0);
  });
});

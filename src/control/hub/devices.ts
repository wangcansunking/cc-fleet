import { createHash, randomBytes } from "node:crypto";
import { readJson, writeJsonAtomic } from "./enroll.js";

// The fleet's device registry: who is enrolled, and what proves it.
//
// Replaces M1's single fleet-wide token. Each machine gets its own credential, so a leak is one
// machine and revocation is one machine — neither was possible before.

const FILE = "devices.json";

export interface DeviceRecord {
  deviceId: string;
  tokenHash: string;      // "sha256:<hex>" — never the token
  hostname: string;
  os: string;
  agentVersion: string;
  enrolledAt: number;
  lastSeenAt: number;
  revokedAt: number | null;
}
export interface EnrollRequest {
  hostname: string;
  os: string;
  agentVersion: string;
}
export interface EnrolledDevice {
  deviceId: string;
  deviceToken: string;    // returned ONCE, at enrolment; the hub cannot reproduce it afterwards
}
interface RegistryFile { devices: DeviceRecord[] }

const hash = (token: string): string => `sha256:${createHash("sha256").update(token).digest("hex")}`;

// A device id ends up as a key in a hand-written profile (`assignments`), so it must stay something
// a person can read and type. Anything outside this set is collapsed to a dash.
function sanitize(hostname: string): string {
  const cleaned = hostname.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "device";
}

export class DeviceRegistry {
  constructor(private readonly dataDir: string, private readonly now: () => number = Date.now) {}

  // Every read hits disk.
  //
  // `cc-fleet revoke` runs in a DIFFERENT process from the running hub, so a cached registry would
  // mean revocation did not take effect until the hub restarted — precisely when waiting is least
  // acceptable. The registry is a handful of records; re-reading it per request is free, and it is
  // the same lazy-read posture the worker's access key already uses.
  private read(): RegistryFile {
    const raw = readJson<RegistryFile>(this.dataDir, FILE, { devices: [] });
    return Array.isArray(raw?.devices) ? raw : { devices: [] };
  }
  private write(file: RegistryFile): void {
    writeJsonAtomic(this.dataDir, FILE, file);
  }

  list(): DeviceRecord[] {
    return this.read().devices;
  }

  enroll(req: EnrollRequest): EnrolledDevice {
    const file = this.read();
    const base = sanitize(req.hostname);
    // Only ACTIVE devices reserve an id. A revoked machine's name is released — hoarding ids would
    // march a re-enrolled laptop through laptop-home-2, -3, -4 for no reason.
    const taken = new Set(file.devices.filter((d) => d.revokedAt === null).map((d) => d.deviceId));
    let deviceId = base;
    for (let n = 2; taken.has(deviceId); n++) deviceId = `${base}-${n}`;

    const deviceToken = randomBytes(32).toString("base64url");
    const at = this.now();
    file.devices.push({
      deviceId, tokenHash: hash(deviceToken),
      hostname: req.hostname, os: req.os, agentVersion: req.agentVersion,
      enrolledAt: at, lastSeenAt: at, revokedAt: null,
    });
    this.write(file);
    return { deviceId, deviceToken };
  }

  // The device this token belongs to, or null if it is unknown, malformed or revoked.
  //
  // Lookup is by DIGEST, not by comparing the secret: the value compared is already a hash of the
  // presented token, so timing differences leak nothing an attacker could invert.
  verify(token: string): DeviceRecord | null {
    if (!token) return null;
    const digest = hash(token);
    const found = this.read().devices.find((d) => d.tokenHash === digest);
    return found && found.revokedAt === null ? found : null;
  }

  // Returns false for an unknown device rather than pretending — a revoke that silently no-ops is how
  // an operator ends up believing a machine was ejected when it was not.
  revoke(deviceId: string): boolean {
    const file = this.read();
    const found = file.devices.find((d) => d.deviceId === deviceId && d.revokedAt === null);
    if (!found) return false;
    found.revokedAt = this.now();
    this.write(file);
    return true;
  }

  touch(deviceId: string): void {
    const file = this.read();
    const found = file.devices.find((d) => d.deviceId === deviceId);
    if (!found) return;
    found.lastSeenAt = this.now();
    this.write(file);
  }
}

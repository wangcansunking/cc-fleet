import { createHash, randomBytes, randomInt } from "node:crypto";
import { readJson, writeJsonAtomic } from "./json-store.js";

// Device authorization, RFC 8628 in shape (docs/design.md §6).
//
// Direction matters. The old flow had the hub mint a code that a person carried to the new machine —
// but a person setting up a machine is SITTING AT that machine. Here the node asks, displays a short
// code, and the operator approves it on the hub. It also removes a real limitation: the hub minted
// codes only at startup, so enrolling a second machine meant restarting it.
//
// The security shape improves too, and this is the part worth understanding:
//
//   deviceCode  32 random bytes. Travels over the network, and whoever holds it gets the credential.
//   userCode    8 characters. Shown to a human and typed on the HUB, never presented over the wire
//               as an authenticator.
//
// Previously the short, low-entropy code WAS the network credential, which is why it needed a
// per-IP throttle to survive guessing. Now the network-facing secret is unguessable, and the
// guessable one is only ever used locally by the person who owns the machine.

const FILE = "device-auth.json";

// Lookalike characters removed: this is read off one screen and typed on another.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const GROUP = 4;

export const AUTH_TTL_MS = 15 * 60_000;   // a person has to physically walk to the hub
export const POLL_INTERVAL_MS = 3_000;

export type AuthStatus = "pending" | "approved" | "denied";

export interface DeviceAuthRecord {
  /** sha256 of the device code — the secret itself is never stored, as with device tokens. */
  deviceCodeHash: string;
  userCode: string;
  hostname: string;
  os: string;
  agentVersion: string;
  status: AuthStatus;
  createdAt: number;
  expiresAt: number;
  /** null = never polled. NOT 0: a zero timestamp is a legal clock value, and conflating the two
   *  makes the first two polls indistinguishable from a rate-limit-exempt pair. */
  lastPolledAt: number | null;
  /** Set once approved and redeemed, so a device code cannot be spent twice. */
  redeemedAt: number | null;
}
interface AuthFile { requests: DeviceAuthRecord[] }

const hash = (s: string): string => `sha256:${createHash("sha256").update(s).digest("hex")}`;
const group = (): string => Array.from({ length: GROUP }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
const normalizeUserCode = (raw: string): string => raw.toUpperCase().replace(/[^A-Z0-9]/g, "");

export interface StartResult {
  deviceCode: string;
  userCode: string;
  intervalMs: number;
  expiresAt: number;
}
export type PollResult =
  | { state: "approved"; record: DeviceAuthRecord }
  | { state: "pending" }
  | { state: "slow_down" }
  | { state: "denied" }
  | { state: "expired" }
  | { state: "unknown" };

export class DeviceAuthRequests {
  constructor(private readonly dataDir: string, private readonly now: () => number = Date.now) {}

  // On disk, not in memory, because `cc-fleet approve` runs in a DIFFERENT process from the hub.
  // An in-memory queue would make approval impossible without an admin socket.
  private read(): AuthFile {
    const raw = readJson<AuthFile>(this.dataDir, FILE, { requests: [] });
    return Array.isArray(raw?.requests) ? raw : { requests: [] };
  }
  private write(file: AuthFile): void {
    // Drop anything long dead so the file cannot grow without bound from abandoned attempts.
    const cutoff = this.now() - AUTH_TTL_MS;
    file.requests = file.requests.filter((r) => r.expiresAt > cutoff);
    writeJsonAtomic(this.dataDir, FILE, file);
  }

  /** A node asks to be let in. Returns the secret it polls with and the code a human will approve. */
  start(req: { hostname: string; os: string; agentVersion: string }): StartResult {
    const file = this.read();
    const deviceCode = randomBytes(32).toString("base64url");
    let userCode: string;
    // Collisions are astronomically unlikely but would be catastrophic to resolve after the fact —
    // two machines racing one approval — so just don't allow one to exist.
    do { userCode = `${group()}-${group()}`; }
    while (file.requests.some((r) => r.userCode === userCode && r.status === "pending" && r.expiresAt > this.now()));

    const at = this.now();
    file.requests.push({
      deviceCodeHash: hash(deviceCode), userCode,
      hostname: req.hostname, os: req.os, agentVersion: req.agentVersion,
      status: "pending", createdAt: at, expiresAt: at + AUTH_TTL_MS, lastPolledAt: null, redeemedAt: null,
    });
    this.write(file);
    return { deviceCode, userCode, intervalMs: POLL_INTERVAL_MS, expiresAt: at + AUTH_TTL_MS };
  }

  /** Everything a human might approve right now, newest last. */
  listPending(): DeviceAuthRecord[] {
    const t = this.now();
    return this.read().requests
      .filter((r) => r.status === "pending" && r.expiresAt > t)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Returns the record so the caller can show WHAT it approved — a bare "ok" invites reflex approval. */
  approve(rawUserCode: string): DeviceAuthRecord | null {
    return this.decide(rawUserCode, "approved");
  }
  deny(rawUserCode: string): DeviceAuthRecord | null {
    return this.decide(rawUserCode, "denied");
  }
  private decide(rawUserCode: string, status: AuthStatus): DeviceAuthRecord | null {
    const wanted = normalizeUserCode(rawUserCode);
    const file = this.read();
    const found = file.requests.find(
      (r) => normalizeUserCode(r.userCode) === wanted && r.status === "pending" && r.expiresAt > this.now(),
    );
    if (!found) return null;
    found.status = status;
    this.write(file);
    return found;
  }

  // Poll with the device code. Approval is consumed exactly once: a redeemed code must not mint a
  // second credential, or a leaked device code would stay useful forever.
  poll(deviceCode: string): PollResult {
    const file = this.read();
    const digest = hash(deviceCode);
    const found = file.requests.find((r) => r.deviceCodeHash === digest);
    if (!found) return { state: "unknown" };

    const t = this.now();
    if (found.expiresAt <= t) return { state: "expired" };
    if (found.redeemedAt) return { state: "unknown" }; // already spent — indistinguishable from bogus

    // Honour the advertised interval. A node hammering the endpoint is told to slow down rather than
    // being served, which keeps one impatient client from drowning the hub.
    if (found.lastPolledAt !== null && t - found.lastPolledAt < POLL_INTERVAL_MS) {
      found.lastPolledAt = t;
      this.write(file);
      return { state: "slow_down" };
    }
    found.lastPolledAt = t;

    if (found.status === "denied") { this.write(file); return { state: "denied" }; }
    if (found.status === "pending") { this.write(file); return { state: "pending" }; }

    found.redeemedAt = t;
    this.write(file);
    return { state: "approved", record: found };
  }
}

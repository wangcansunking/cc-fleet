import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";

// The hub's device token.
//
// M1 uses ONE long-lived pre-shared token for every node (docs/specs/2026-08-13-control-m1-tracer.md
// §2): the enroll handshake, per-device tokens and revocation land in the next PR, and MUST land
// before the hub is ever exposed beyond a LAN — this token grants the ability to rewrite what a
// machine executes.
//
// Storage mirrors the worker's access key (src/shared/network.ts): small plaintext JSON, 0600, in the
// data dir, with an env override so CI and headless runs can pin it without touching disk.
const file = (dir: string) => join(dir, "fleet.json");
interface FleetFile { token?: string }

function read(dir: string): FleetFile {
  if (!existsSync(file(dir))) return {};
  try { return JSON.parse(readFileSync(file(dir), "utf8")) as FleetFile; } catch { return {}; }
}

export function readHubToken(dir: string): string | null {
  if (process.env.FLEET_TOKEN) return process.env.FLEET_TOKEN;
  return read(dir).token ?? null;
}

// Mint a token on first use and persist it; subsequent calls return the same one so restarting the
// hub does not invalidate every enrolled node.
export function ensureHubToken(dir: string): string {
  const existing = readHubToken(dir);
  if (existing) return existing;
  const token = randomBytes(32).toString("base64url");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file(dir), JSON.stringify({ ...read(dir), token }), { mode: 0o600 });
  return token;
}

// Constant-time compare so a token cannot be recovered byte-by-byte from response timing. Length is
// compared first because timingSafeEqual throws on a length mismatch — that leak is acceptable (a
// token's length is not secret) and unavoidable without padding.
function sameToken(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// FAIL-CLOSED: with no token configured, nothing is authorized. An unconfigured control plane must
// refuse every request rather than hand desired state — i.e. executable instructions — to whoever
// connects first. This mirrors the worker's LAN mode, which refuses all traffic when no key is set.
export function isAuthorized(dir: string, authHeader: string | undefined): boolean {
  const expected = readHubToken(dir);
  if (!expected) return false;
  if (!authHeader?.startsWith("Bearer ")) return false;
  const presented = authHeader.slice("Bearer ".length);
  return presented.length > 0 && sameToken(presented, expected);
}

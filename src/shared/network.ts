import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

// Network ACCESS MODE for the worker proxy: the posture the user picks for who may reach :7991.
// Stored like the GitHub token and the WebIQ key — small plaintext JSON, 0600, in the data dir —
// and read LAZILY (the auth middleware re-reads per request) so rotating the key or revoking access
// takes effect without a worker restart. Env vars ACCESS_MODE / ACCESS_KEY take precedence so CI and
// headless runs can pin the posture without touching disk.
//
//   mode "localhost" (DEFAULT, safe) — the worker binds loopback only (127.0.0.1) and serves every
//                                      request unauthenticated, exactly as it always has. A key may
//                                      exist but is not enforced; loopback is the boundary.
//   mode "lan"                       — the worker binds beyond loopback (0.0.0.0) so other machines on
//                                      the network can reach it, but EVERY request must carry the key
//                                      or it is rejected 401. LAN exposure must never be an open proxy,
//                                      so this mode is fail-closed: with no key set, all requests are
//                                      refused (and the UI refuses to enter LAN without one).
const file = (dir: string) => join(dir, "network.json");
export type AccessMode = "localhost" | "lan";

interface NetworkFile { mode?: AccessMode; key?: string; keyRevision?: number }
function read(dir: string): NetworkFile {
  if (!existsSync(file(dir))) return {};
  try { return JSON.parse(readFileSync(file(dir), "utf8")) as NetworkFile; } catch { return {}; }
}
function write(dir: string, data: NetworkFile): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file(dir), JSON.stringify(data), { mode: 0o600 });
}

// The active mode. ACCESS_MODE env wins; on disk only the literal "lan" enables LAN (any other value,
// or an unreadable/absent file, is the safe localhost default — a corrupt file must never silently
// open the proxy to the network).
export function readAccessMode(dir: string): AccessMode {
  const env = process.env.ACCESS_MODE;
  if (env === "lan" || env === "localhost") return env;
  return read(dir).mode === "lan" ? "lan" : "localhost";
}

// The shared key, or null if none is set. ACCESS_KEY env wins so a key can be injected without disk.
export function readAccessKey(dir: string): string | null {
  if (process.env.ACCESS_KEY) return process.env.ACCESS_KEY;
  return read(dir).key ?? null;
}

// A URL-safe random key (32 bytes ≈ 43 base64url chars) — enough entropy that it can't be guessed
// against the 401 wall, short enough to paste into a client config.
export function generateAccessKey(): string {
  return randomBytes(32).toString("base64url");
}

// Switch posture. Entering LAN is FAIL-CLOSED at the source: if no key exists yet we mint one in the
// same write, so it is impossible to persist `mode: "lan"` without a key to guard it. Returns the key
// that now guards the proxy (the freshly minted one, or the existing/env key) so the caller can show
// it. Leaving LAN keeps the key on disk — flipping back to LAN later reuses it instead of churning a
// new secret every toggle.
export function setAccessMode(dir: string, mode: AccessMode): { mode: AccessMode; key: string | null } {
  const cur = read(dir);
  if (mode === "lan") {
    const key = process.env.ACCESS_KEY ?? cur.key ?? generateAccessKey();
    write(dir, { ...cur, mode, key });
    return { mode, key };
  }
  write(dir, { ...cur, mode });
  return { mode, key: cur.key ?? null };
}

// Force a new key (rotate). Persists it so it survives restarts; returns the EFFECTIVE key the gate
// will accept (via readAccessKey), so an ACCESS_KEY env override is reflected honestly rather than the
// UI claiming a rotation the env silently shadows. Does not change the mode — rotating in localhost
// just pre-seeds a key for the next LAN switch.
export function rotateAccessKey(dir: string): string {
  const current = read(dir);
  write(dir, { ...current, key: generateAccessKey(), keyRevision: (current.keyRevision ?? 0) + 1 });
  return readAccessKey(dir)!; // non-null: we just wrote a key (or ACCESS_KEY env is set)
}

export function readAccessKeyRevision(dir: string): number {
  return read(dir).keyRevision ?? (readAccessKey(dir) ? 1 : 0);
}

/** Ensure the public fleet gateway has a key before it can ever be tunnelled. */
export function ensureAccessKey(dir: string): { key: string; revision: number } {
  const current = read(dir);
  if (process.env.ACCESS_KEY) return { key: process.env.ACCESS_KEY, revision: current.keyRevision ?? 1 };
  if (current.key) return { key: current.key, revision: current.keyRevision ?? 1 };
  const key = generateAccessKey();
  write(dir, { ...current, key, keyRevision: 1 });
  return { key, revision: 1 };
}

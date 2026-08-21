import { existsSync, mkdirSync, renameSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { randomInt } from "node:crypto";
import { join } from "node:path";

// One-time enrollment codes: the only way a machine joins the fleet.
//
// M1 used ONE pre-shared token for the whole fleet — leak it on any machine and the fleet is
// compromised, with no way to eject a single node. A code is short-lived, single-use, and buys
// exactly one per-device token (see devices.ts).

// Deliberately excludes 0/O/1/I/L. A code is read off a screen and retyped by a person, often via
// chat; characters that cannot be transcribed reliably turn into support burden, and users route
// around support burden by reusing credentials.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const GROUP = 4;

export const CODE_TTL_MS = 5 * 60_000;
// 40 bits of entropy cannot survive an unlimited guess rate on its own, so guessing is throttled
// PER SOURCE. That is the whole defence, and the arithmetic says it is enough: 31^8 ≈ 8.5e11 codes,
// throttled to 10 attempts per source per minute, against a 5-minute window.
//
// An earlier draft also burned every live code once failures accumulated fleet-wide. That was
// removed: it bought nothing the entropy did not already buy, and it handed anyone a trivial denial
// of service — five bad guesses from anywhere would permanently prevent legitimate machines from
// enrolling. A defence whose failure mode is "nobody can join" is worse than the attack it prevents.
export const MAX_IP_FAILURES = 10;    // wrong guesses from one source before it is shut out
export const IP_BLOCK_MS = 60_000;

export type ConsumeResult =
  | { ok: true }
  // "invalid" covers wrong, expired AND already-used, on purpose: telling them apart would reveal
  // whether a guessed code ever existed, converting a blind guess into an oracle query.
  | { ok: false; reason: "invalid" | "blocked" };

interface Outstanding { expiresAt: number; used: boolean }

export class EnrollCodes {
  private readonly codes = new Map<string, Outstanding>();
  private readonly ipFailures = new Map<string, { count: number; blockedUntil: number }>();
  private failures = 0;

  // Codes live in memory ONLY. A hub restart therefore invalidates every outstanding code — which is
  // the behaviour we want: a code handed out before a restart should not survive it.
  constructor(private readonly now: () => number = Date.now) {}

  mint(): string {
    let code: string;
    do { code = `${group()}-${group()}`; } while (this.codes.has(code));
    this.codes.set(code, { expiresAt: this.now() + CODE_TTL_MS, used: false });
    return code;
  }

  // Live, unused, unexpired codes. Used by the CLI to tell the operator whether one is pending.
  outstanding(): number {
    this.sweep();
    return this.codes.size;
  }

  // Total failed attempts seen. Not used to gate anything — it exists so the hub can TELL the
  // operator that someone is guessing, which is the useful half of what the removed fleet-wide
  // burn was reaching for, without the denial of service.
  failedAttempts(): number {
    return this.failures;
  }

  // Validate and atomically spend a code. `source` is the caller's IP, used only for rate limiting.
  consume(raw: string, source: string): ConsumeResult {
    this.sweep();
    const ip = this.ipFailures.get(source);
    if (ip && ip.blockedUntil > this.now()) return { ok: false, reason: "blocked" };

    const code = normalize(raw);
    const entry = this.codes.get(code);
    if (!entry || entry.used || entry.expiresAt < this.now()) return this.fail(source);

    // Marked used BEFORE returning, so two machines racing the same code produce exactly one winner.
    // Node is single-threaded, so this is atomic with respect to concurrent requests.
    entry.used = true;
    this.codes.delete(code);
    this.ipFailures.delete(source);
    return { ok: true };
  }

  private fail(source: string): ConsumeResult {
    const ip = this.ipFailures.get(source) ?? { count: 0, blockedUntil: 0 };
    ip.count += 1;
    if (ip.count >= MAX_IP_FAILURES) ip.blockedUntil = this.now() + IP_BLOCK_MS;
    this.ipFailures.set(source, ip);
    this.failures += 1;
    return { ok: false, reason: "invalid" };
  }

  private sweep(): void {
    const t = this.now();
    for (const [code, entry] of this.codes) if (entry.used || entry.expiresAt < t) this.codes.delete(code);
    for (const [ip, state] of this.ipFailures) if (state.blockedUntil && state.blockedUntil < t) this.ipFailures.delete(ip);
  }
}

function group(): string {
  let out = "";
  for (let i = 0; i < GROUP; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

// Accept what a human actually types: any case, dashes optional. The entropy lives in the characters,
// so being strict about presentation buys no security and costs successful enrolments.
function normalize(raw: string): string {
  const bare = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return bare.length === GROUP * 2 ? `${bare.slice(0, GROUP)}-${bare.slice(GROUP)}` : bare;
}

// Atomic JSON write: a half-written registry would cost every device its enrolment. Write a sibling
// temp file, then rename — rename is atomic on both POSIX and Windows (same volume).
export function writeJsonAtomic(dir: string, name: string, data: unknown): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const target = join(dir, name);
  const tmp = join(dir, `.${name}.tmp`);
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  try { renameSync(tmp, target); }
  catch (e) { try { unlinkSync(tmp); } catch { /* ignore */ } throw e; }
}

export function readJson<T>(dir: string, name: string, fallback: T): T {
  const target = join(dir, name);
  if (!existsSync(target)) return fallback;
  try { return JSON.parse(readFileSync(target, "utf8")) as T; } catch { return fallback; }
}

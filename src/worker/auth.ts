import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import type { AccessMode } from "../shared/network.js";

// Live access posture, read fresh on EVERY request by the middleware below (the providers are
// closures over the data dir) — so flipping the mode or rotating the key takes effect immediately,
// without a worker restart. (Re-binding the socket for a localhost↔lan switch DOES need a restart;
// that is the supervisor's job. This gate only decides whether to serve a request on the open socket.)
export interface AccessControl {
  mode: () => AccessMode;
  key: () => string | null;
  // Whether THIS worker process actually bound a non-loopback interface (i.e. it's reachable off-box).
  // Decided once at spawn from BIND_HOST and FIXED for the process's life — a live socket can't be
  // rebound. This closes a fail-open window on a lan→localhost switch: the mode file flips to
  // "localhost" the instant the user toggles, but this same worker keeps listening on 0.0.0.0 until the
  // supervisor restarts it. Enforcing the key whenever the socket is exposed — regardless of what the
  // mode file momentarily says — means an exposed worker is NEVER an open proxy, even mid-restart or if
  // the restart fails entirely.
  exposed: boolean;
}

// Constant-time key comparison. The length pre-check leaks only the key LENGTH (standard, acceptable)
// and is required because timingSafeEqual throws on differing buffer lengths.
export function keysMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// Pull the presented key from either header clients already send: OpenAI/Codex use
// `Authorization: Bearer <key>`, Anthropic/Claude Code use `x-api-key: <key>`. Supporting both means
// LAN auth needs no new client-side plumbing — the same field that today carries the ignored
// "copilot-reverse-local" placeholder now carries the real key.
function presentedKey(req: { get(name: string): string | undefined }): string | null {
  const auth = req.get("authorization");
  if (auth) { const m = /^Bearer\s+(.+)$/i.exec(auth.trim()); if (m) return m[1].trim(); }
  return req.get("x-api-key")?.trim() || null;
}

// Whether a request originates from this machine's loopback interface. SECURITY: this is decided ONLY
// from the TCP-layer peer address (`req.socket.remoteAddress`) — NEVER from any header (X-Forwarded-For
// etc.), which a remote client could forge to impersonate localhost. Express's `trust proxy` is off by
// default, so `req.ip` would also be the socket address, but we read the socket directly to be explicit
// and immune to that setting. Covers the forms a loopback peer can present on a dual-stack 0.0.0.0
// socket: IPv4 `127.0.0.0/8`, IPv6 `::1`, and IPv4-mapped-IPv6 `::ffff:127.x`. An unknown/empty address
// is treated as NON-local (fail-safe: a request we can't attribute is gated, not exempted).
export function isLoopbackAddr(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.toLowerCase();
  if (a === "::1") return true;
  const v4 = a.startsWith("::ffff:") ? a.slice(7) : a; // unwrap IPv4-mapped-IPv6
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

// Gate every proxied request. A key is required when the worker is reachable off-box — `mode === "lan"`
// OR the socket is `exposed` (bound non-loopback) — AND the request actually came from off-box. Requests
// arriving over loopback are ALWAYS served unauthenticated: in LAN mode the local client (the user's own
// Claude/Codex on this machine) keeps working with no key, exactly as in localhost mode; only genuinely
// remote callers must present the key. The loopback check is purely TCP-layer (see isLoopbackAddr) so it
// can't be spoofed by a header. The `exposed` term still covers the lan→localhost transition: the mode
// file flips immediately but this socket stays on 0.0.0.0 until the supervisor restarts it, so a REMOTE
// caller keeps being gated until a fresh loopback-bound worker takes over.
//   when a remote request needs a key:
//     • no key configured  → 503, fail closed (must never be an open proxy; defense-in-depth backstop —
//                            the UI/store already refuse to enter LAN keyless, so this only fires on a
//                            hand-edited file or ACCESS_MODE=lan env with no ACCESS_KEY).
//     • missing/invalid key → 401, rejected BEFORE any upstream call.
// Mount AFTER /healthz (the supervisor's readiness probe must stay open) and BEFORE the proxy routes.
// `isLocal` is injectable so tests (which drive over loopback) can simulate a remote peer.
export function requireAccess(ctl: AccessControl, isLocal: (req: { socket: { remoteAddress?: string } }) => boolean = (req) => isLoopbackAddr(req.socket.remoteAddress)): RequestHandler {
  return (req, res, next) => {
    const gated = ctl.exposed || ctl.mode() === "lan";
    if (!gated || isLocal(req)) return next();          // localhost-bound, or a loopback caller → no key
    const configured = ctl.key();
    if (!configured) {
      res.status(503).json({ error: { message: "this proxy is exposed on the network but no access key is configured — refusing to serve (fail-closed). Set a key or switch to localhost mode." } });
      return;
    }
    const got = presentedKey(req);
    if (got && keysMatch(got, configured)) return next();
    res.status(401).json({ error: { message: "missing or invalid access key — network access requires a valid key (Authorization: Bearer <key> or x-api-key: <key>)" } });
  };
}

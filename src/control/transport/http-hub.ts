import express, { type Express, type Request, type Response } from "express";
import { createServer, type Server } from "node:http";
import type { Hub } from "../hub/hub.js";
import type { Peer, MessageHandler, Unsubscribe } from "../channel.js";
import type { DeviceRegistry } from "../hub/devices.js";
import type { EnrollCodes } from "../hub/enroll.js";

// Hub-side transport: SSE for hub→node, POST for node→hub.
//
// SSE rather than WebSocket because it needs no new runtime dependency and matches how the
// supervisor already streams events (src/supervisor/api.ts). The duplex illusion is completed by a
// plain POST endpoint; everything above the Channel interface is unaware of the difference, so M2 can
// swap in ws by replacing this file.

const KEEP_ALIVE_MS = 15_000;
// How often a live stream re-checks that its device is still enrolled. Revocation must reach an
// OPEN connection, not merely future requests — a revoked machine that keeps streaming is still
// being managed by the fleet, which is exactly what revoking was supposed to stop.
const REVOKE_CHECK_MS = 2_000;

// One connected node. Outbound frames go down the SSE response; inbound frames are injected by the
// POST handler, which finds this peer by device id.
class HttpPeer implements Peer {
  private readonly messageHandlers = new Set<MessageHandler>();
  private readonly closeHandlers = new Set<() => void>();
  private closed = false;

  constructor(readonly deviceId: string, private readonly res: Response) {}

  send(msg: unknown): void {
    if (this.closed) return;
    // Writing to a socket that died between broadcasts throws synchronously (ERR_STREAM_DESTROYED /
    // EPIPE). Treat that as a disconnect rather than letting it escape into the hub's broadcast loop.
    try { this.res.write(`data: ${JSON.stringify(msg)}\n\n`); }
    catch { this.close(); }
  }
  keepAlive(): void {
    if (this.closed) return;
    // An SSE comment: keeps proxies and idle-timeout middleboxes from reaping the stream, and is
    // ignored by any conforming parser (ours included — it carries no `data:` line).
    try { this.res.write(`:ka\n\n`); } catch { this.close(); }
  }
  deliver(msg: unknown): void {
    for (const h of [...this.messageHandlers]) {
      try { h(msg); } catch { /* one bad subscriber must not stop the rest */ }
    }
  }
  onMessage(handler: MessageHandler): Unsubscribe {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }
  onClose(handler: () => void): Unsubscribe {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const h of [...this.closeHandlers]) { try { h(); } catch { /* ignore */ } }
    try { this.res.end(); } catch { /* already torn down */ }
  }
}

export interface ControlRouterOptions {
  dataDir: string;
  hub: Hub;
  devices: DeviceRegistry;
  codes: EnrollCodes;
  keepAliveMs?: number;
  revokeCheckMs?: number;
}

export function createControlRouter(opts: ControlRouterOptions): Express {
  const app = express();
  app.set("trust proxy", true); // req.ip must reflect the real client for the enrol throttle
  app.use(express.json({ limit: "8mb" })); // profiles carry whole skill files
  const peers = new Map<string, HttpPeer>();

  // Enrolment is the ONE unauthenticated endpoint: the code is the credential. Everything else
  // requires a per-device token that only this endpoint can mint.
  app.post("/control/enroll", (req, res) => {
    const body = req.body as { code?: unknown; hostname?: unknown; os?: unknown; agentVersion?: unknown };
    const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
    const code = str(body?.code), hostname = str(body?.hostname);
    const os = str(body?.os), agentVersion = str(body?.agentVersion);
    if (!code || !hostname || !os || !agentVersion) {
      res.status(400).json({ error: "code, hostname, os and agentVersion are required" });
      return;
    }
    const spent = opts.codes.consume(code, req.ip ?? "unknown");
    if (!spent.ok) {
      // ONE message for wrong, expired and already-spent codes — and a 429 only for a throttled
      // source, which reveals nothing about any code. Distinguishing the rest would tell an attacker
      // whether a guess ever existed, turning a blind guess into an oracle query.
      if (spent.reason === "blocked") { res.status(429).json({ error: "too many attempts" }); return; }
      res.status(401).json({ error: "invalid or expired code" });
      return;
    }
    const device = opts.devices.enroll({ hostname, os, agentVersion });
    res.status(201).json(device);
  });

  // Auth is re-read per request (never captured at boot) so `cc-fleet revoke` — which runs in a
  // different process — takes effect immediately, without restarting the hub.
  const authorize = (req: Request, res: Response): string | null => {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    const device = opts.devices.verify(token);
    if (!device) { res.status(401).json({ error: "unauthorized" }); return null; }

    const claimed = typeof req.query.deviceId === "string" ? req.query.deviceId.trim() : "";
    if (!claimed) { res.status(400).json({ error: "deviceId required" }); return null; }
    // A valid token does not entitle you to ANY identity — only your own. Without this, any enrolled
    // machine could impersonate another and pull down its desired state.
    if (claimed !== device.deviceId) { res.status(403).json({ error: "token does not match deviceId" }); return null; }
    return device.deviceId;
  };

  app.get("/control/events", (req, res) => {
    const deviceId = authorize(req, res);
    if (!deviceId) return;

    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("connection", "keep-alive");
    res.flushHeaders?.();

    // A half-dead socket the OS has not reaped yet would otherwise leave a phantom peer shadowing the
    // live one, so the hub would broadcast into the void while the node looks stuck. Newest wins.
    peers.get(deviceId)?.close();

    const peer = new HttpPeer(deviceId, res);
    peers.set(deviceId, peer);
    opts.devices.touch(deviceId);

    const keepAlive = setInterval(() => peer.keepAlive(), opts.keepAliveMs ?? KEEP_ALIVE_MS);
    // Poll rather than push, because revocation happens in another process and there is nothing to
    // subscribe to. A couple of seconds of latency on ejecting a machine is acceptable; leaving it
    // connected until it happens to reconnect is not.
    const revokeCheck = setInterval(() => {
      if (!opts.devices.list().some((d) => d.deviceId === deviceId && d.revokedAt === null)) peer.close();
    }, opts.revokeCheckMs ?? REVOKE_CHECK_MS);
    keepAlive.unref?.();
    revokeCheck.unref?.();

    peer.onClose(() => {
      clearInterval(keepAlive);
      clearInterval(revokeCheck);
      if (peers.get(deviceId) === peer) peers.delete(deviceId); // don't evict a newer connection
    });
    req.on("close", () => peer.close());

    opts.hub.accept(peer); // registers, subscribes, and pushes current desired state immediately
  });

  app.post("/control/msg", (req, res) => {
    const deviceId = authorize(req, res);
    if (!deviceId) return;
    const peer = peers.get(deviceId);
    // 409 rather than 404: the device is known to the protocol, it just has no live stream — the
    // agent's correct response is to reconnect, not to give up.
    if (!peer) { res.status(409).json({ error: "no active stream for device" }); return; }
    opts.devices.touch(deviceId);
    peer.deliver(req.body);
    res.json({ ok: true });
  });

  return app;
}

export interface HubServerOptions extends ControlRouterOptions {
  port: number;   // 0 = ephemeral, for tests
  host?: string;
}
export interface HubServer {
  readonly port: number;
  close(): void;
}

export function startHubServer(opts: HubServerOptions): Promise<HubServer> {
  const app = createControlRouter(opts);
  const server: Server = createServer(app);
  // SSE responses are long-lived by design; without this, close() waits for streams that never end.
  const sockets = new Set<import("node:net").Socket>();
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host ?? "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : opts.port;
      resolve({
        port,
        close: () => {
          for (const s of sockets) s.destroy();
          sockets.clear();
          server.close();
        },
      });
    });
  });
}

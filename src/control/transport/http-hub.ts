import express, { type Express, type Request, type Response } from "express";
import { createServer, type Server } from "node:http";
import type { Hub } from "../hub/hub.js";
import type { Peer, MessageHandler, Unsubscribe } from "../channel.js";
import { isAuthorized } from "../hub/auth.js";

// Hub-side transport: SSE for hub→node, POST for node→hub.
//
// SSE rather than WebSocket because it needs no new runtime dependency and matches how the
// supervisor already streams events (src/supervisor/api.ts). The duplex illusion is completed by a
// plain POST endpoint; everything above the Channel interface is unaware of the difference, so M2 can
// swap in ws by replacing this file.

const KEEP_ALIVE_MS = 15_000;

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
  dataDir: string;          // where the hub token lives
  hub: Hub;
  keepAliveMs?: number;
}

export function createControlRouter(opts: ControlRouterOptions): Express {
  const app = express();
  app.use(express.json({ limit: "8mb" })); // profiles carry whole skill files
  const peers = new Map<string, HttpPeer>();

  // Auth is re-read per request (not captured at boot) so rotating or revoking the token takes effect
  // without a restart — the same lazy-read posture as the worker's access key.
  const gate = (req: Request, res: Response): boolean => {
    if (isAuthorized(opts.dataDir, req.headers.authorization)) return true;
    res.status(401).json({ error: "unauthorized" });
    return false;
  };
  const deviceIdOf = (req: Request, res: Response): string | null => {
    const id = typeof req.query.deviceId === "string" ? req.query.deviceId.trim() : "";
    if (id) return id;
    res.status(400).json({ error: "deviceId required" });
    return null;
  };

  app.get("/control/events", (req, res) => {
    if (!gate(req, res)) return;
    const deviceId = deviceIdOf(req, res);
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
    const timer = setInterval(() => peer.keepAlive(), opts.keepAliveMs ?? KEEP_ALIVE_MS);
    timer.unref?.();
    peer.onClose(() => {
      clearInterval(timer);
      if (peers.get(deviceId) === peer) peers.delete(deviceId); // don't evict a newer connection
    });
    req.on("close", () => peer.close());

    opts.hub.accept(peer); // registers, subscribes, and pushes current desired state immediately
  });

  app.post("/control/msg", (req, res) => {
    if (!gate(req, res)) return;
    const deviceId = deviceIdOf(req, res);
    if (!deviceId) return;
    const peer = peers.get(deviceId);
    // 409 rather than 404: the device is known to the protocol, it just has no live stream — the
    // agent's correct response is to reconnect, not to give up.
    if (!peer) { res.status(409).json({ error: "no active stream for device" }); return; }
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

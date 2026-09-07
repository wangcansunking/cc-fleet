import express, { type Express, type RequestHandler } from "express";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { FleetAdmin } from "./fleet-admin.js";
import { statusOf } from "./fleet-admin.js";
import { listRestarts, recentRequests, aggregateRequests, recentErrorRows, type Db } from "./db.js";
import { dashboardHtml } from "./dashboard.js";
import type { WorkerState, DoctorCheck, GithubStatus } from "../shared/control-types.js";
import type { ClientStatus } from "../tui/setup/status.js";
import type { ClaudeMapAdmin } from "./claude-map-admin.js";
import { normalizeClaudeMapReplacement } from "../shared/claude-map-store.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DashModel { id: string; display_name?: string }
export interface ControlDeps {
  db: Db;
  getState: () => WorkerState;
  restart: () => void;
  stop: () => void;
  start: () => void;
  doctor: (ping?: boolean) => Promise<DoctorCheck[]>;
  github: () => GithubStatus | undefined;
  clients: () => ClientStatus;          // per-scope Claude/Codex config read from the real files
  models: () => Promise<DashModel[]>;   // advertised models (proxied from the worker), for the dashboard
  now?: () => number;                   // clock for the 24h metrics window; injectable for tests
  subscribe: (send: (event: string, data: unknown) => void) => () => void;
  fleet?: FleetAdmin;
  claudeMap?: ClaudeMapAdmin;
  appVersion?: string;
}

export function createControlApp(deps: ControlDeps): Express {
  const app = express();
  app.use(express.json({ limit: "8mb" }));
  app.get("/", (_req, res) => res.type("html").send(dashboardHtml()));
  app.get("/favicon.ico", (_req, res) => res.status(204).end());

  // Loopback is the network boundary, but browsers can still submit cross-origin forms to localhost.
  // Every mutation therefore needs both same-origin proof and an unguessable per-process CSRF token.
  const csrfToken = randomBytes(32).toString("base64url");
  app.get("/api/bootstrap", (_req, res) => res.json({ csrfToken, product: "cc-fleet", version: deps.appVersion ?? "dev" }));
  const mutationGuard: RequestHandler = (req, res, next) => {
    if (!req.is("application/json")) { res.status(415).json({ error: "application/json required", code: "unsupported_media_type" }); return; }
    const origin = req.get("origin");
    const host = req.get("host");
    if (!origin || !host) { res.status(403).json({ error: "same-origin request required", code: "forbidden" }); return; }
    let parsed: URL;
    try { parsed = new URL(origin); } catch { res.status(403).json({ error: "invalid origin", code: "forbidden" }); return; }
    if (parsed.host !== host || (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost" && parsed.hostname !== "[::1]")) {
      res.status(403).json({ error: "foreign origin refused", code: "forbidden" }); return;
    }
    if (req.get("x-cc-fleet-csrf") !== csrfToken) { res.status(403).json({ error: "invalid CSRF token", code: "forbidden" }); return; }
    next();
  };
  const sendResult = (res: import("express").Response, result: unknown) => res.status(statusOf(result)).json(result);
  const requiredConfirm = (value: unknown, wanted: unknown = true): boolean => value === wanted;

  if (deps.claudeMap) {
    const claudeMap = deps.claudeMap;
    app.get("/api/claude-map", async (_req, res) => res.json(await claudeMap.status()));
    app.put("/api/claude-map", mutationGuard, async (req, res) => {
      let body;
      try { body = normalizeClaudeMapReplacement(req.body); }
      catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : String(error), code: "invalid_request" });
        return;
      }
      try {
        const status = await claudeMap.replace(body);
        deps.restart();
        res.json(status);
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error), code: "write_failed" });
      }
    });
    app.post("/api/claude-map/reset", mutationGuard, async (_req, res) => {
      try {
        const status = await claudeMap.reset();
        deps.restart();
        res.json(status);
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error), code: "write_failed" });
      }
    });
  }

  if (deps.fleet) {
    const fleet = deps.fleet;
    app.get("/api/fleet/summary", async (_req, res) => res.json(await fleet.summary()));
    app.get("/api/fleet/enrolments", async (_req, res) => res.json({ enrolments: await fleet.enrolments() }));
    app.get("/api/fleet/devices", async (_req, res) => res.json({ devices: await fleet.devices() }));
    app.get("/api/fleet/pending", async (_req, res) => res.json({ pending: await fleet.pending() }));
    app.get("/api/fleet/profile/live", async (_req, res) => sendResult(res, await fleet.liveProfile()));
    app.get("/api/fleet/profile/draft", async (_req, res) => res.json(await fleet.draftProfile()));
    app.get("/api/fleet/profile/preview", async (_req, res) => sendResult(res, await fleet.previewDraft()));
    app.get("/api/fleet/profile/history", async (_req, res) => res.json({ history: await fleet.history() }));
    app.get("/api/fleet/tunnel/status", async (_req, res) => res.json(await fleet.tunnelStatus()));

    app.post("/api/fleet/enrolments/:id/approve", mutationGuard, async (req, res) => {
      if (!requiredConfirm(req.body?.confirm)) { res.status(400).json({ error: "confirmation required", code: "confirmation_required" }); return; }
      sendResult(res, await fleet.approve(req.params.id));
    });
    app.post("/api/fleet/enrolments/:id/deny", mutationGuard, async (req, res) => {
      if (!requiredConfirm(req.body?.confirm)) { res.status(400).json({ error: "confirmation required", code: "confirmation_required" }); return; }
      sendResult(res, await fleet.deny(req.params.id));
    });
    app.post("/api/fleet/devices/:id/revoke", mutationGuard, async (req, res) => {
      if (!requiredConfirm(req.body?.confirm, req.params.id)) { res.status(400).json({ error: "device id confirmation required", code: "confirmation_required" }); return; }
      sendResult(res, await fleet.revoke(req.params.id));
    });
    app.post("/api/fleet/pending/:device/:kind/:id/adopt", mutationGuard, async (req, res) => {
      const body = z.object({ group: z.string().min(1), confirm: z.literal(true) }).safeParse(req.body);
      if (!body.success) { res.status(400).json({ error: body.error.issues[0].message, code: "invalid_request" }); return; }
      sendResult(res, await fleet.adopt(req.params.device, req.params.kind, req.params.id, body.data.group));
    });
    app.post("/api/fleet/pending/:device/:kind/:id/reject", mutationGuard, async (req, res) => {
      if (!requiredConfirm(req.body?.confirm)) { res.status(400).json({ error: "confirmation required", code: "confirmation_required" }); return; }
      sendResult(res, await fleet.reject(req.params.device, req.params.kind, req.params.id));
    });
    app.put("/api/fleet/profile/draft", mutationGuard, async (req, res) => {
      const body = z.object({ profile: z.unknown(), baseRevision: z.string().min(1) }).safeParse(req.body);
      if (!body.success) { res.status(400).json({ error: body.error.issues[0].message, code: "invalid_request" }); return; }
      sendResult(res, await fleet.saveDraft(body.data.profile, body.data.baseRevision));
    });
    app.post("/api/fleet/profile/publish", mutationGuard, async (req, res) => {
      const body = z.object({ revision: z.string().min(1), confirm: z.literal(true) }).safeParse(req.body);
      if (!body.success) { res.status(400).json({ error: "publish confirmation and revision required", code: "confirmation_required" }); return; }
      sendResult(res, await fleet.publishDraft(body.data.revision));
    });
    app.post("/api/fleet/profile/rollback", mutationGuard, async (req, res) => {
      const body = z.object({ historyId: z.string().min(1), revision: z.string().min(1), confirm: z.literal(true) }).safeParse(req.body);
      if (!body.success) { res.status(400).json({ error: "rollback confirmation required", code: "confirmation_required" }); return; }
      sendResult(res, await fleet.rollback(body.data.historyId, body.data.revision));
    });
    app.post("/api/fleet/tunnel/login", mutationGuard, async (_req, res) => sendResult(res, await fleet.tunnelLogin()));
    app.post("/api/fleet/tunnel/enable", mutationGuard, async (_req, res) => sendResult(res, await fleet.tunnelEnable()));
    app.post("/api/fleet/tunnel/disable", mutationGuard, async (_req, res) => sendResult(res, await fleet.tunnelDisable()));
    app.post("/api/fleet/tunnel/rotate-key", mutationGuard, async (req, res) => {
      if (!requiredConfirm(req.body?.confirm)) { res.status(400).json({ error: "confirmation required", code: "confirmation_required" }); return; }
      sendResult(res, await fleet.rotateLlmKey());
    });
    app.post("/api/fleet/tunnel/delete", mutationGuard, async (req, res) => {
      const id = req.body?.tunnelId;
      const current = await fleet.tunnelStatus();
      if (typeof id !== "string" || !id || current.tunnelId !== id || !requiredConfirm(req.body?.confirm, `DELETE ${id}`)) {
        res.status(400).json({ error: "type DELETE <current-tunnel-id> to confirm", code: "confirmation_required" }); return;
      }
      sendResult(res, await fleet.tunnelDelete());
    });
    app.post("/api/fleet/tunnel/interrupt", mutationGuard, async (req, res) => {
      if (!requiredConfirm(req.body?.confirm)) { res.status(400).json({ error: "confirmation required", code: "confirmation_required" }); return; }
      sendResult(res, await fleet.tunnelInterrupt());
    });
    app.post("/api/fleet/runtime/reload", mutationGuard, async (_req, res) => sendResult(res, await fleet.reloadRoles()));
    app.post("/api/fleet/node/reload", mutationGuard, async (_req, res) => sendResult(res, await fleet.reloadNode()));
  }

  app.get("/api/status", (_req, res) => res.json({ workerState: deps.getState(), restarts: listRestarts(deps.db, 50), github: deps.github() }));
  app.post("/api/restart", mutationGuard, (_req, res) => { deps.restart(); res.json({ ok: true }); });
  app.post("/api/stop", mutationGuard, (_req, res) => { deps.stop(); res.json({ ok: true }); });
  app.post("/api/start", mutationGuard, (_req, res) => { deps.start(); res.json({ ok: true }); });
  // ?ping=1 opts into the slower per-model connectivity probe (real 1-token requests); the dashboard's
  // 2s poll omits it and gets the cheap, upstream-free checks. Only the on-demand TUI /doctor sets it.
  app.get("/api/doctor", async (req, res) => res.json({ checks: await deps.doctor(req.query.ping === "1") }));
  app.get("/api/requests", (_req, res) => res.json({ requests: recentRequests(deps.db, 100) }));
  // Real metrics: lifetime + last-24h rollups computed in SQL over the WHOLE request_log (not a capped
  // 100-row fetch), plus the recent error rows. This is what /metrics renders — "100 reqs" used to be
  // a display ceiling, not a count.
  app.get("/api/metrics", (_req, res) => {
    const now = (deps.now ?? Date.now)();
    res.json({
      all: aggregateRequests(deps.db),
      day: aggregateRequests(deps.db, now - DAY_MS),
      recentErrors: recentErrorRows(deps.db, 20),
    });
  });
  app.get("/api/clients", (_req, res) => res.json(deps.clients()));
  // Proxied from the worker so the dashboard shows the SAME models the picker advertises. Best-effort:
  // an empty list (worker momentarily down) renders as "discovery unavailable", not a 500.
  app.get("/api/models", async (_req, res) => { try { res.json({ models: await deps.models() }); } catch { res.json({ models: [] }); } });
  app.get("/api/events", (req, res) => {
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache");
    res.flushHeaders?.();
    let off = () => {};
    // Writing to a socket that died between broadcasts throws synchronously (ERR_STREAM_DESTROYED /
    // EPIPE). emit() calls this on the worker-message path, so an uncaught throw would crash the
    // in-process supervisor + TUI. Swallow the write error and unsubscribe — a dead connection should
    // be dropped, not retried.
    const send = (event: string, data: unknown) => {
      try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
      catch { off(); }
    };
    // Subscribe BEFORE the first write so that if the hello frame throws (socket already dead), the
    // catch's off() refers to the real unsubscribe rather than the no-op default — otherwise a dead
    // connection would stay subscribed until the next emit or 'close'.
    off = deps.subscribe(send);
    send("hello", { state: deps.getState() });
    req.on("close", off);
  });
  return app;
}

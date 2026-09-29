import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { openDb, recordRestart, recordRequest } from "./db.js";
import { WorkerMonitor } from "./monitor.js";
import { EventBus } from "./events.js";
import { createControlApp } from "./api.js";
import { defaultConfig, workerBindHost } from "../shared/config.js";
import { dataDir, dbPath } from "../shared/paths.js";
import { readGhToken } from "../shared/creds.js";
import { readAccessMode } from "../shared/network.js";
import { startFleetRuntime, type NodeRuntimeStatus } from "./fleet-runtime.js";
import { createFleetAdmin } from "./fleet-admin.js";
import type { TunnelStatus } from "../tunnel/manager.js";
import { APP_VERSION } from "../version.js";
import { probeGithubAuth } from "../providers/copilot/token.js";
import { GithubHeartbeat, SIGNED_OUT_DETAIL } from "./github-heartbeat.js";
import { appendCrashLog } from "../shared/crash-log.js";
import { buildDoctorChecks } from "./doctor.js";
import { distinctConfiguredModels, pingViaProxy } from "./doctor-probes.js";
import { readClientStatus } from "../tui/setup/status.js";
import { readWebIqKey, readWebSearchMode, resolveWebSearchBackend } from "../shared/webiq-key.js";
import type { WorkerState, DoctorCheck } from "../shared/control-types.js";
import { createClaudeMapAdmin } from "./claude-map-admin.js";

export function startSupervisor(): { stop: () => void; ready: Promise<void> } {
  const config = defaultConfig();
  mkdirSync(dataDir(), { recursive: true });
  const db = openDb(dbPath());
  const bus = new EventBus();
  const workerEntry = join(dirname(fileURLToPath(import.meta.url)), "..", "worker", import.meta.url.endsWith(".ts") ? "index.ts" : "index.js");

  let state: WorkerState = "starting";
  const monitor = new WorkerMonitor(config, workerEntry, {
    onStateChange: (s) => { state = s; bus.emit("state", { state: s }); },
    onCrash: (d, exitCode, stderrTail) => {
      recordRestart(db, { ts: Date.now(), reason: d.markedUnhealthy ? "unhealthy" : "crash", exitCode, stderrTail, backoffMs: d.backoffMs, markedUnhealthy: d.markedUnhealthy ? 1 : 0 });
      // Also persist to crash.log so a worker crash is diagnosable post-mortem — the DB stderrTail can
      // be empty if the worker died before flushing; this keeps whatever it did emit.
      appendCrashLog("worker-crash", `exit=${exitCode} unhealthy=${d.markedUnhealthy} backoff=${d.backoffMs}ms\n${stderrTail || "(no stderr captured)"}`);
      bus.emit("crash", { exitCode, ...d });
    },
    onWorkerMessage: (m) => {
      if (m.type === "request-metric") {
        const sample = { ts: Date.now(), endpoint: m.endpoint, model: m.model, status: m.status, latencyMs: m.latencyMs, tokensIn: m.tokensIn, tokensOut: m.tokensOut, error: m.error };
        recordRequest(db, sample);
        bus.emit("metric", sample);
      }
    },
  // Bind the worker proxy per the LIVE access mode each spawn: localhost → loopback, lan → 0.0.0.0.
  // The control API below stays loopback always (the control plane is never on the network).
  }, () => workerBindHost(readAccessMode(dataDir()), config));

  const workerBase = `http://${config.bindHost}:${config.workerPort}`;

  // Periodically re-check the GitHub token so the UI reflects an expired/revoked login within ~60s,
  // instead of only on the next failed request or a manual /status. Declared before doctor() so the
  // light /doctor can reuse its cached status instead of hammering GitHub on the 2s dashboard poll.
  const heartbeat = new GithubHeartbeat(() => readGhToken(dataDir()), probeGithubAuth, undefined, {
    intervalMs: config.heartbeat.intervalMs, initialDelayMs: config.heartbeat.initialDelayMs,
  });

  // Advertised models, proxied from the worker (same source the picker uses) — shared by /doctor's
  // "models" check and the dashboard's /api/models panel so they never disagree.
  const listModelsAt = async (path: "/anthropic/v1/models" | "/openai/models"): Promise<{ id: string; display_name?: string }[]> => {
    const r = await fetch(`${workerBase}${path}`);
    if (!r.ok) throw new Error(`worker ${path} → ${r.status}`);
    return ((await r.json()) as { data?: { id: string; display_name?: string }[] }).data ?? [];
  };
  const listModels = () => listModelsAt("/anthropic/v1/models");
  // The Worker's internal list is live-only (never FALLBACK_MODELS), so a discovery failure cannot
  // falsely mark a configured backend available. It remains loopback-only behind the Worker gate.
  const claudeMapAdmin = createClaudeMapAdmin(dataDir(), async () => {
    const r = await fetch(`${workerBase}/internal/live-models`);
    if (!r.ok) throw new Error(`worker /internal/live-models → ${r.status}`);
    return ((await r.json()) as { data?: string[] }).data ?? [];
  });

  // /doctor is the user's self-check. Light mode (the dashboard's 2s poll, /report) is cheap and
  // upstream-free; ping mode (the on-demand TUI /doctor) adds one real 1-token request per
  // client-configured model. Probes are injected so the check logic stays pure + unit-tested.
  const doctor = async (ping = false): Promise<DoctorCheck[]> =>
    buildDoctorChecks({
      githubAuth: async (live) => {
        const gh = readGhToken(dataDir());
        if (!gh) return { ok: false, detail: SIGNED_OUT_DETAIL };
        // Light path (dashboard poll): reuse the heartbeat's cached result — a fresh token exchange
        // every 2s would trip GitHub's rate limit (the heartbeat runs on a 60s cadence for exactly this
        // reason). On-demand /doctor (live) does a fresh exchange so the user gets an authoritative,
        // up-to-the-second answer; it shares probeGithubAuth's classifier so both paths agree.
        if (!live) {
          const cached = heartbeat.current();
          if (cached) return { ok: cached.ok, detail: cached.detail };
          // Heartbeat hasn't completed its first probe yet — token is on disk but unverified.
          return { ok: false, detail: "checking… (login probe pending)" };
        }
        const probe = await probeGithubAuth(gh);
        return { ok: probe.ok, detail: probe.detail };
      },
      workerState: () => state,
      webBackend: () => resolveWebSearchBackend(readWebSearchMode(dataDir()), Boolean(readWebIqKey(dataDir()))),
      listModels: async () => (await listModels()).map((m) => m.id),
      configuredModels: () => distinctConfiguredModels(readClientStatus()),
      pingModel: (m) => pingViaProxy(workerBase, m),
    }, { ping });


  // Fleet runtime is async (gateway bind + profile load). Keep the supervisor's admin server available
  // while it starts, then attach its local-only admin facade. The app closes over `fleet` so requests
  // made after readiness see it without rebuilding Express.
  let tunnelStatus: TunnelStatus = { state: "disabled" };
  let nodeStatus: NodeRuntimeStatus = { state: "disabled" };
  let fleetRuntime: Awaited<ReturnType<typeof startFleetRuntime>> | undefined;
  let fleetAdmin: ReturnType<typeof createFleetAdmin> | undefined;
  const fleetProxy = new Proxy({} as ReturnType<typeof createFleetAdmin>, {
    get: (_target, prop) => (...args: unknown[]) => {
      if (!fleetAdmin) return { ok: false, code: "not_ready", error: "fleet runtime is starting" };
      return (fleetAdmin[prop as keyof typeof fleetAdmin] as (...xs: unknown[]) => unknown)(...args);
    },
  });
  const app = createControlApp({
    db, getState: () => state,
    restart: () => monitor.restartManually(),
    stop: () => monitor.stop(),
    start: () => monitor.start(),
    doctor,
    github: () => heartbeat.current(),
    clients: () => readClientStatus(),
    models: listModels,
    subscribe: (send) => bus.subscribe(send),
    fleet: fleetProxy,
    claudeMap: claudeMapAdmin,
    appVersion: APP_VERSION,
  });

  const adminServer = app.listen(config.supervisorPort, config.bindHost, () => monitor.start());
  const fleetReady = startFleetRuntime({
    dataDir: dataDir(), config,
    onTunnel: (s) => { tunnelStatus = s; bus.emit("tunnel", s); },
    onNode: (s) => { nodeStatus = s; bus.emit("node", s); },
    onPublish: (version) => bus.emit("profile", { version }),
    onReport: (deviceId, report) => bus.emit("device", { deviceId, report }),
    onInventory: (deviceId, inventory) => bus.emit("inventory", { deviceId, inventory }),
    onPush: (deviceId, item, stored) => bus.emit("pending", { deviceId, item: { kind: item.kind, id: item.id }, stored }),
  }).then((runtime) => {
    fleetRuntime = runtime;
    fleetAdmin = createFleetAdmin(runtime, dataDir(), { tunnel: () => tunnelStatus, node: () => nodeStatus });
    tunnelStatus = runtime.tunnel?.status() ?? { state: "disabled" };
    nodeStatus = runtime.nodeStatus();
    bus.emit("fleet", { ready: true });
  }).catch((e) => {
    appendCrashLog("fleet-runtime", e);
    bus.emit("fleet", { ready: false, error: (e as Error).message });
  });
  heartbeat.start();
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    heartbeat.stop(); monitor.stop(); fleetRuntime?.stop(); adminServer.close();
  };
  process.on("SIGINT", () => { stop(); process.exit(0); });
  process.on("SIGTERM", () => { stop(); process.exit(0); });
  return { stop, ready: fleetReady.then(() => {}) };
}

// Allow `node dist/supervisor/index.js` to boot the daemon directly.
if (process.argv[1] && process.argv[1].endsWith(join("supervisor", "index.js"))) startSupervisor();

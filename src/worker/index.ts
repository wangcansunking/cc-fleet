import { createWorkerApp } from "./server.js";
import { Router } from "./router.js";
import { CopilotAdapter } from "../providers/copilot/adapter.js";
import { CopilotTokenStore } from "../providers/copilot/token.js";
import { fetchModelDiscovery } from "../providers/copilot/models.js";
import { readGhToken } from "../shared/creds.js";
import { readWebIqKey, readWebSearchMode, resolveWebSearchBackend } from "../shared/webiq-key.js";
import { readAccessMode, readAccessKey } from "../shared/network.js";
import { makeGatewayRunner } from "../core/server-tools.js";
import { borrowSearch } from "../providers/copilot/borrow-search.js";
import { dataDir } from "../shared/paths.js";
import { defaultConfig } from "../shared/config.js";
import { readClaudeMapEnabled } from "../shared/prefs.js";
import type { WorkerToSupervisor } from "../shared/ipc.js";
import { discoveryBeforeReady } from "./model-discovery.js";

// Sending after the parent tore down the IPC channel throws ERR_IPC_CHANNEL_CLOSED; guard it so a
// crash-time report can't itself become a second, masking crash.
function send(msg: WorkerToSupervisor): void { try { if (process.connected) process.send?.(msg); } catch { /* channel gone */ } }

const cfg = defaultConfig();
const port = Number(process.env.WORKER_PORT ?? cfg.workerPort);
const host = process.env.BIND_HOST ?? cfg.bindHost;

const gh = readGhToken(dataDir());
if (!gh) { send({ type: "error", message: "no GitHub token; run `copilot-reverse` and /login first" }); process.exit(1); }

const tokenStore = new CopilotTokenStore(gh);
// Per-model supported_endpoints, populated lazily from the live model list (same source as the model
// ids). The adapter reads through this map so responses-only models (e.g. gpt-5.5) route to /responses
// as soon as discovery resolves; until then the map is empty and the /chat 400 safety net covers it.
let modelEndpoints: Record<string, string[]> = {};
// Set of model ids that advertise reasoning_effort. The adapter gates the /chat reasoning_effort field
// on this: sending it to a model without support (e.g. gpt-4o) is a hard 400. Empty until discovery
// resolves — the adapter then defaults to "supported" so a reasoning turn isn't silently dropped.
let reasoningModels = new Set<string>();
let reasoningEfforts: Record<string, string[]> = {};
const claudeMapEnabled = readClaudeMapEnabled(dataDir());
const router = new Router(
  [new CopilotAdapter(
    tokenStore,
    fetch,
    (m) => modelEndpoints[m] ?? [],
    (m) => reasoningModels.size === 0 || reasoningModels.has(m),
    (m) => reasoningEfforts[m] ?? [],
  )],
  cfg.modelMap,
  { claudeMapEnabled },
);
// One coherent upstream snapshot feeds fuzzy matching, endpoint/reasoning routing, and context metadata.
// Mapped aliases are never synthesized from the offline fallback alone: Router requires a live `available`
// list before publishing or resolving them.
const discoverModels = () => tokenStore.get().then((t) => fetchModelDiscovery(t)).then((discovery) => {
  router.setAvailableModels(discovery.ids, discovery.live);
  router.setOneMModels(discovery.oneM);
  router.setModelLimits(discovery.limits);
  modelEndpoints = discovery.endpoints;
  reasoningModels = discovery.reasoning;
  reasoningEfforts = discovery.reasoningEfforts;
});
const modelDiscoveryReady = discoveryBeforeReady(claudeMapEnabled, discoverModels);
// Gateway-run web_search / web_fetch. The backend is resolved per call (lazy → /webiq toggles need no
// restart): currently WebIQ when a key is set, else unavailable (Copilot borrow is disabled — see
// COPILOT_WEB_SEARCH_ENABLED). resolveWebSearchBackend centralises that policy.
const gatewayRunner = makeGatewayRunner({
  backend: () => resolveWebSearchBackend(readWebSearchMode(dataDir()), Boolean(readWebIqKey(dataDir()))),
  webiqKey: () => readWebIqKey(dataDir()),
  borrow: { run: (input) => borrowSearch(tokenStore, input) },
});
// Access control read LAZILY from disk per request (so /network toggles + key rotation need no worker
// restart). The gate requires a key whenever this worker is reachable off-box: either the live mode is
// `lan`, or this process is `exposed` — bound to a non-loopback host. `exposed` is fixed at spawn from
// the BIND_HOST the supervisor handed us (a live socket can't rebind), and it closes the lan→localhost
// fail-open window: the mode file flips instantly but this socket stays on 0.0.0.0 until the supervisor
// restarts it, so we keep enforcing the key until a fresh loopback-bound worker takes over.
const exposed = host !== "127.0.0.1" && host !== "::1" && host !== "localhost";
const access = { mode: () => readAccessMode(dataDir()), key: () => readAccessKey(dataDir()), exposed };
const app = createWorkerApp(router, (m) => send({ type: "request-metric", ...m }), gatewayRunner, access);
const server = app.listen(port, host, () => {
  void modelDiscoveryReady.then(() => send({ type: "ready", port }));
});
const hb = setInterval(() => send({ type: "heartbeat", ts: Date.now() }), 5_000);

process.on("message", (m: { type?: string }) => { if (m?.type === "shutdown") { clearInterval(hb); server.close(() => process.exit(0)); } });

// Parent-death guard: a forked child does NOT die when its supervisor dies abnormally (terminal
// closed, killed, crashed). An orphaned worker keeps holding :7891, so the NEXT supervisor's worker
// can't bind it → "listen EADDRINUSE :7891" crash loop → daemon marked unhealthy. `disconnect` fires
// when the IPC channel to the supervisor drops (a graceful stop already exited via the message above),
// so treat it as "my parent is gone" and exit NOW — the OS releases the socket on exit. We don't wait
// on server.close(): its callback never fires while a long-lived SSE stream is open, which is exactly
// when we most need to let go. Guarded by process.connected so it's inert for a never-forked worker.
if (process.connected) process.on("disconnect", () => process.exit(0));

// Crash diagnostics: write to STDERR FIRST so the supervisor's stderr capture (and crash.log) records
// the reason even when the IPC channel is already gone; the IPC send is a best-effort extra. Without
// the unhandledRejection handler, a stray floating rejection silently kills the worker on Node ≥15 —
// the exact "exit 1, empty stderr" crash loop we kept seeing.
function fatal(kind: string, e: unknown): never {
  const detail = e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e);
  try { process.stderr.write(`worker ${kind}: ${detail}\n`); } catch { /* nothing more we can do */ }
  send({ type: "error", message: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined });
  process.exit(1);
}
process.on("uncaughtException", (e) => fatal("uncaughtException", e));
process.on("unhandledRejection", (e) => fatal("unhandledRejection", e));

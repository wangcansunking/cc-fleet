#!/usr/bin/env node
import React from "react";
import { networkInterfaces as osNetworkInterfaces } from "node:os";
import { render } from "ink";
import { Command } from "commander";
import { App } from "../tui/app.js";
import { buildRegistry } from "../tui/slash/commands.js";
import { DaemonClient } from "../tui/daemon-client.js";
import { runDeviceLogin, beginDeviceLogin } from "./auth.js";
import { probeSupervisor } from "../daemon/lifecycle.js";
import { startSupervisor } from "../supervisor/index.js";
import { runAssistantTurn } from "../tui/assistant/runtime.js";
import { makeOnChat } from "../tui/assistant/on-chat.js";
import { readGhToken, clearGhToken, hasGhTokenFile } from "../shared/creds.js";
import { writeWebIqKey, readWebIqKey, clearWebIqKey, readWebSearchMode, writeWebSearchMode, resolveWebSearchBackend } from "../shared/webiq-key.js";
import { readClientSetup, writeClientSetup } from "../shared/client-setup.js";
import { readChatModel, writeChatModel, shouldShowChange, markChangeShown, readClaudeMapEnabled, writeClaudeMapEnabled } from "../shared/prefs.js";
import { readAccessMode, readAccessKey, setAccessMode as persistAccessMode, rotateAccessKey } from "../shared/network.js";
import type { NetworkInfo } from "../tui/screens/network.js";
import { CopilotTokenStore, isCopilotTokenValid } from "../providers/copilot/token.js";
import { fetchGithubUser, skuLabel, formatIdentity } from "../providers/copilot/account.js";
import { fetchCopilotModels, fetchModelLimits } from "../providers/copilot/models.js";
import { applyClaude, applyCodex, resetClaude, resetCodex, CLAUDE_ENV_KEYS, CODEX_ENV_KEYS, type Scope } from "../tui/setup/apply.js";
import { installSkill as installSkillFile } from "../tui/skills/install.js";
import type { SkillEntry } from "../tui/skills/catalog.js";
import { readClientStatus } from "../tui/setup/status.js";
import { summarizeStatus } from "../tui/status-summary.js";
import { applyCodexToml } from "../tui/setup/codex-toml.js";
import type { SetupClient } from "../tui/setup/wizard.js";
import { claudeCopilotReverseEnv } from "../tui/setup/clients.js";
import { stripOneM } from "../core/model-canonical.js";
import { availableClaudeMappings, backendForClaudeAlias, modelMapDisplay } from "../core/claude-model-map.js";
import { bestModelMatch } from "../core/fuzzy.js";
import { dataDir } from "../shared/paths.js";
import { defaultConfig } from "../shared/config.js";
import { APP_VERSION } from "../version.js";
import { APP_CHANGES } from "../changes.js";
import { buildChangeBannerLines } from "../tui/whats-new.js";
import { appendCrashLog } from "../shared/crash-log.js";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DEFAULT_MODEL = "gpt-4o"; // a valid Copilot model id; pass-through routing uses it as-is
// Conservative context budget that drives the assistant's auto-compaction. Sized below the
// common Copilot prompt window (gpt-4o ≈ 128K) so the engine compacts before the upstream
// rejects an over-long turn. TODO: read each model's real max_prompt_tokens from /models.
const DEFAULT_MAX_INPUT_TOKENS = 110_000;

// Process-level backstop. The TUI and the supervisor run in ONE process, so a stray throw or an
// unhandled rejection anywhere (a dead SSE socket, a bad creds read, an SDK stream) would otherwise
// terminate the whole app and drop the user back to the shell — especially on Node ≥15, where an
// unhandled rejection is fatal by default. We log to a file (Ink owns stdout, so console writes would
// corrupt the render) and keep running; the specific throw sites are also guarded at their source.
//
// uncaughtException is treated differently from unhandledRejection: Node documents the process as
// being in an undefined state afterward, so swallowing it indefinitely risks spinning forever on a
// recurring throw against corrupted state. A circuit breaker counts exceptions in a short window and
// lets the process die once they storm, so a user/supervisor restart gets a clean process — while a
// lone transient exception is still survived.
const UNCAUGHT_STORM_COUNT = 5;
const UNCAUGHT_STORM_WINDOW_MS = 10_000;
function installProcessBackstop(): void {
  process.on("unhandledRejection", (reason) => appendCrashLog("unhandledRejection", reason));
  let recent: number[] = [];
  process.on("uncaughtException", (err) => {
    appendCrashLog("uncaughtException", err);
    const now = Date.now();
    recent = recent.filter((t) => now - t < UNCAUGHT_STORM_WINDOW_MS);
    recent.push(now);
    if (recent.length >= UNCAUGHT_STORM_COUNT) {
      appendCrashLog("uncaughtException", `${UNCAUGHT_STORM_COUNT} exceptions within ${UNCAUGHT_STORM_WINDOW_MS}ms — exiting for a clean restart`);
      process.exit(1);
    }
  });
}

// The host's primary LAN IPv4 (first non-internal IPv4 across interfaces), or null if it can't be
// determined — used to show other machines the address to point at in LAN mode. Best-effort only;
// the proxy binds 0.0.0.0 regardless, so a null here just means "we couldn't pretty-print the URL".
function lanIPv4(): string | null {
  const ifaces = osNetworkInterfaces();
  for (const addrs of Object.values(ifaces)) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return null;
}
function networkInfoOf(workerPort: number): NetworkInfo {
  const mode = readAccessMode(dataDir());
  const ip = mode === "lan" ? lanIPv4() : null;
  return { mode, key: readAccessKey(dataDir()), lanUrl: ip ? `http://${ip}:${workerPort}` : null };
}

async function launchTui(): Promise<void> {
  installProcessBackstop();
  const cfg = defaultConfig();
  const existingToken = readGhToken(dataDir());
  if (!existingToken) {
    console.log("No GitHub login found — starting device-code login.");
    await runDeviceLogin(dataDir());
  } else if (!(await isCopilotTokenValid(existingToken))) {
    console.log("GitHub login expired — re-authenticating.");
    await runDeviceLogin(dataDir());
  }

  // Run the daemon IN-PROCESS — no separate console window pops up. Reuse one if already running.
  let stopSupervisor: (() => void) | undefined;
  if (!(await probeSupervisor())) {
    process.stdout.write("starting copilot-reverse…\n");
    stopSupervisor = startSupervisor().stop;
    for (let i = 0; i < 60 && !(await probeSupervisor()); i++) await delay(100);
  }

  const base = `http://${cfg.bindHost}:${cfg.supervisorPort}`;
  const client = new DaemonClient(base);
  const workerBase = `http://${cfg.bindHost}:${cfg.workerPort}`;
  // Per-protocol base URLs the worker now serves under: OpenAI clients -> /openai/*,
  // Anthropic clients (and the assistant's own dogfood SDK) -> /anthropic/*.
  const openaiBase = `${workerBase}/openai`;
  const anthropicBase = `${workerBase}/anthropic`;
  const endpoint = { host: cfg.bindHost, port: cfg.workerPort, apiKey: "copilot-reverse-local" };
  let app: { unmount: () => void } | undefined;
  const quit = () => { stopSupervisor?.(); app?.unmount(); process.exit(0); };
  // Restore a client's config: strip copilot-reverse's keys from BOTH scopes and clear the HUD flag.
  const resetClient = async (clientKind: SetupClient): Promise<string[]> => {
    const fn = clientKind === "claude" ? resetClaude : resetCodex;
    const keys = clientKind === "claude" ? CLAUDE_ENV_KEYS : CODEX_ENV_KEYS;
    const results = (["global", "project"] as Scope[]).map((scope) => fn(scope, keys));
    writeClientSetup(dataDir(), { ...readClientSetup(dataDir()), [clientKind]: false });
    const lines = results
      .filter((r) => r.changed.length)
      .map((r) => `removed ${r.changed.join(", ")} from ${r.path}`);
    return lines.length ? lines : [`no copilot-reverse ${clientKind} config found to remove`];
  };

  const registry = buildRegistry({ client, quit }, endpoint, {
    dashboardUrl: `http://${cfg.bindHost}:${cfg.supervisorPort}/`,
    reportRepo: cfg.reportRepo,
    appVersion: APP_VERSION,
    platform: `${process.platform} node-${process.version}`,
    resetClient,
    // Clear the stored token and restart the worker (it will report unauthenticated until re-login).
    logout: async () => {
      clearGhToken(dataDir());
      await client.restart().catch(() => {});
      return ["signed out — GitHub token removed", "run /login to sign in again"];
    },
  });
  // Two-phase /login for the TUI: surface the device code immediately, poll in the background, then
  // restart the worker so it picks up the new token. The blocking single-call form deadlocked the
  // Repl (the code stayed hidden behind the poll, so the user could never authorize it).
  const doLogin = async (show: (lines: string[]) => void): Promise<string[]> => {
    const { code, complete } = await beginDeviceLogin(dataDir());
    show([`Open ${code.verification_uri} and enter code: ${code.user_code}`, "waiting for authorization…"]);
    await complete();
    // Drop the cached Copilot token so the next get() does a fresh exchange with the just-written
    // GitHub token (the store re-reads the token on each exchange, so a new instance isn't required —
    // but resetting clears any Copilot token cached against the old login).
    tokenStore = new CopilotTokenStore(() => readGhToken(dataDir()));
    cachedIdentity = undefined; // a new login may be a different user — re-resolve the username
    await client.restart().catch(() => {});
    return ["GitHub authorization complete — worker restarting with the new token"];
  };
  // Filled in below once we have a token; the assistant prefers a model's real window over the default.
  const modelLimits: Record<string, number> = {};
  const modelLabels: Record<string, string> = {};
  let latestModels: string[] = [];
  // Provider form: the store re-reads the GitHub token on each exchange, so a transient unreadable
  // creds.json (Windows lock / partial write) can't poison the store for the session — it recovers on
  // the next clean read, and a genuinely absent token surfaces as a 401 instead of a `token null` send.
  let tokenStore = new CopilotTokenStore(() => readGhToken(dataDir()));
  const loadModels = async () => {
    const token = await tokenStore.get();
    const [ids, limits] = await Promise.all([fetchCopilotModels(token), fetchModelLimits(token)]);
    latestModels = ids;
    Object.assign(modelLimits, limits); // so the picker shows windows and auto-compaction is sized
    for (const key of Object.keys(modelLabels)) delete modelLabels[key];
    if (!readClaudeMapEnabled(dataDir())) return ids;
    const out = [...ids];
    const seen = new Set(out.map(stripOneM));
    for (const { alias, backend } of availableClaudeMappings(ids)) {
      if (!seen.has(alias)) { out.push(alias); seen.add(alias); }
      modelLabels[alias] = modelMapDisplay(alias, ids);
      if (limits[backend] !== undefined) modelLimits[alias] = limits[backend];
    }
    return out;
  };
  // Pull each model's real context window in the background too, in case the picker never opens.
  void tokenStore.get().then((t) => fetchModelLimits(t)).then((m) => Object.assign(modelLimits, m)).catch(() => {});

  // Account facts for the status card: who's logged in (GitHub /user) + their Copilot plan (rides along
  // on the token exchange, so getEntitlement() is free once get() has run). The username is cached
  // per-process (it doesn't change within a login); a /login re-auth clears it so the next read
  // re-resolves against the new token. Both are best-effort — any failure yields empty fields and the
  // card simply omits them.
  let cachedIdentity: string | undefined;
  const resolveAccount = async (): Promise<{ identity?: string; plan?: string }> => {
    let plan: string | undefined;
    try { await tokenStore.get(); const ent = tokenStore.getEntitlement(); if (ent) plan = skuLabel(ent.sku); }
    catch { /* not logged in / transient — omit plan */ }
    if (cachedIdentity === undefined) {
      const gh = readGhToken(dataDir());
      if (gh) { const user = await fetchGithubUser(gh); if (user) cachedIdentity = formatIdentity(user); }
    }
    return { identity: cachedIdentity, plan };
  };

  // Apply a client's config (shared by the /setup wizard and the assistant's setup_* tools).
  // For Claude Code we also write the selected model's real context window so the client doesn't
  // For Claude Code we also write the selected model's real context window so the client doesn't
  // assume the default 200K (which makes a 1M model read "context 100%" far too early). For Codex
  // the native config is ~/.codex/config.toml (what the standalone CLI actually reads); we also keep
  // a legacy .env for older OpenAI-style tooling, but report the config.toml path since that's the
  // one that matters.
  const applyClient = (clientKind: SetupClient, scope: Scope, model: string) => {
    if (clientKind === "claude") {
      const backend = readClaudeMapEnabled(dataDir()) ? backendForClaudeAlias(model, latestModels) : undefined;
      const r = applyClaude(scope, claudeCopilotReverseEnv(anthropicBase, "copilot-reverse-local", model, modelLimits[backend ?? model]));
      writeClientSetup(dataDir(), { ...readClientSetup(dataDir()), claude: true });
      return r;
    }
    applyCodex(scope, { OPENAI_BASE_URL: openaiBase, OPENAI_API_KEY: "copilot-reverse-local", OPENAI_MODEL: model }); // legacy .env
    const toml = applyCodexToml({ baseUrl: openaiBase, model, contextWindow: modelLimits[model], apiKey: "copilot-reverse-local" });
    writeClientSetup(dataDir(), { ...readClientSetup(dataDir()), codex: true });
    return toml; // the native config Codex reads — surface this path in the setup card
  };
  const setup = { apply: async (clientKind: SetupClient, scope: Scope, model: string) => applyClient(clientKind, scope, model) };

  const onChat = makeOnChat(
    {
      client, workerBaseUrl: anthropicBase, apiKey: "copilot-reverse-local", model: DEFAULT_MODEL,
      maxInputTokens: DEFAULT_MAX_INPUT_TOKENS, modelLimits,
      listModels: loadModels,
      setupClient: async (c, s, m) => applyClient(c, s, m),
    },
    (c, p, print, abort) => runAssistantTurn(c, p, print, undefined, abort),
    undefined,
    // Pre-flight auth gate: block a turn (with an actionable hint) when there's no GitHub token, or
    // the stored one no longer exchanges for a Copilot token — instead of firing a request that just
    // hangs until the turn timeout. Reuses the long-lived tokenStore so a valid login is a cached,
    // round-trip-free check between message bursts (its get() caches with a 60s skew).
    async () => {
      if (!hasGhTokenFile(dataDir())) return "you're signed out — run /login to sign in before chatting";
      try { await tokenStore.get(); return null; }
      catch { return "your GitHub login has expired — run /login to sign in again"; }
    },
  );

  const persistedModel = readChatModel(dataDir());
  // Heal a stale TUI chat selection on startup when Claude models disappeared upstream. This is separate
  // from /setup-claude's configured model: it only controls copilot-reverse's built-in assistant.
  let initialModel = persistedModel ?? DEFAULT_MODEL;
  if (readClaudeMapEnabled(dataDir()) && persistedModel) {
    const models = await loadModels().catch((): string[] => []);
    if (!models.includes(persistedModel)) {
      const fallback = models.find((candidate) => modelLabels[candidate]?.includes(" → "));
      if (fallback) { initialModel = fallback; writeChatModel(dataDir(), fallback); }
    }
  }

  // "What's new" banner: surface the real headlines from recent releases (newest first), not a
  // generic pointer — a bundled release has several changes, so we flatten across releases and show
  // the top few, each tagged with its version. Keyed by the current version so each release
  // re-announces, shown ~3 launches then quiet. The full list lives behind /changes.
  const CHANGE_ID = `v${APP_VERSION}`;
  const bannerLines = buildChangeBannerLines(APP_CHANGES);
  const changeBanner = bannerLines.length && shouldShowChange(dataDir(), CHANGE_ID)
    ? { lines: bannerLines }
    : undefined;

  // Startup overview. The token was already validated above (re-auth happens before we get here), so
  // GitHub is connected; web search readiness and configured clients are read from disk. Resolve the
  // account (username + plan) too — best-effort, and the token is already cached so it's cheap.
  const clientStatus = readClientStatus();
  const account = await resolveAccount().catch(() => ({} as { identity?: string; plan?: string }));
  const startupStatus = summarizeStatus({
    hasToken: Boolean(readGhToken(dataDir())),
    tokenValid: true,
    webSearch: resolveWebSearchBackend(readWebSearchMode(dataDir()), Boolean(readWebIqKey(dataDir()))),
    worker: "ready",
    clients: { claude: clientStatus.claude.user || clientStatus.claude.project, codex: clientStatus.codex.user || clientStatus.codex.project },
    identity: account.identity,
    plan: account.plan,
  });

  app = render(
    React.createElement(App, {
      registry,
      title: "copilot-reverse",
      initialModel,
      statusSource: () => client.status(),
      metricsSource: () => client.metrics(),
      readStatus: () => readClientStatus(),
      modelLimits,
      modelLabels,
      onChat,
      loadModels,
      setup,
      // Install a bundled agent skill into ~/.claude/skills (global) or ./.claude/skills (project).
      installSkill: async (scope: Scope, entry: SkillEntry) => installSkillFile(scope, entry),
      info: {
        openai: openaiBase,
        anthropic: anthropicBase,
        supervisorPort: cfg.supervisorPort,
        workerPort: cfg.workerPort,
        dataDir: dataDir(),
      },
      onModelChange: (m: string) => writeChatModel(dataDir(), m),
      pickModelOnStart: !persistedModel,
      claudeMapEnabled: () => readClaudeMapEnabled(dataDir()),
      setClaudeMap: async (enabled: boolean) => {
        writeClaudeMapEnabled(dataDir(), enabled);
        await client.restart();
      },
      login: doLogin,
      enableWebiq: (k: string) => { writeWebIqKey(k, dataDir()); writeWebSearchMode(dataDir(), "webiq"); },
      disableWebiq: () => { clearWebIqKey(dataDir()); },
      webSearchBackend: () => resolveWebSearchBackend(readWebSearchMode(dataDir()), Boolean(readWebIqKey(dataDir()))),
      // Network access mode. networkInfo reads the live posture; setAccessMode persists then restarts
      // the worker so the supervisor re-spawns it bound to the new host (loopback vs 0.0.0.0 — a live
      // socket can't be rebound); rotateKey mints a fresh key (no restart needed — the gate reads it
      // per request). Entering LAN is fail-closed in the store (a key is minted if none exists). The
      // restart error is NOT swallowed: if the rebind fails the UI shows it (the still-running worker
      // stays key-protected via the `exposed` backstop, so a failed lan→localhost is safe, not open).
      networkInfo: () => networkInfoOf(cfg.workerPort),
      setAccessMode: async (mode) => { persistAccessMode(dataDir(), mode); await client.restart(); return networkInfoOf(cfg.workerPort); },
      rotateKey: async () => { rotateAccessKey(dataDir()); return networkInfoOf(cfg.workerPort); },
      // Each client's pinned model on THIS machine (user scope, else project) + its real context
      // window, to fill the LAN remote-setup config blocks so they size context exactly like local
      // setup. Claude's pinned id is the canonical dashed [1m] form, but modelLimits is keyed by
      // Copilot's dotted id — map back via bestModelMatch so the window lookup hits. Codex stores the
      // raw Copilot id, so it indexes modelLimits directly. Undefined window (limits not loaded) →
      // the block omits the field, same as a local setup run before limits resolve.
      clientModels: () => {
        const s = readClientStatus();
        const claudeModel = s.claude.userModel ?? s.claude.projectModel;
        const codexModel = s.codex.userModel ?? s.codex.projectModel;
        const limitFor = (canonical?: string): number | undefined => {
          if (!canonical) return undefined;
          const mappedBackend = readClaudeMapEnabled(dataDir()) ? backendForClaudeAlias(canonical, latestModels) : undefined;
          if (mappedBackend && modelLimits[mappedBackend] !== undefined) return modelLimits[mappedBackend];
          if (modelLimits[canonical] !== undefined) return modelLimits[canonical]; // already a Copilot id (Codex)
          const copilotId = bestModelMatch(stripOneM(canonical), Object.keys(modelLimits)); // dashed→dotted (Claude)
          return copilotId ? modelLimits[copilotId] : undefined;
        };
        return { claude: claudeModel, codex: codexModel, claudeWindow: limitFor(claudeModel), codexWindow: limitFor(codexModel) };
      },
      startupStatus,
      changeBanner,
      onChangeSeen: () => markChangeShown(dataDir(), CHANGE_ID),
      githubStatus: async () => {
        const token = readGhToken(dataDir());
        if (!token) return "signed-out";
        return (await isCopilotTokenValid(token)) ? "connected" : "expired";
      },
      // Fresh username + Copilot plan for the live /status card (best-effort).
      accountInfo: resolveAccount,
    }),
  );
}

const program = new Command();
program.name("copilot-reverse").description("copilot-reverse: interactive Copilot proxy").version(APP_VERSION);
program.command("login").description("GitHub device-code login").action(() => runDeviceLogin(dataDir()));
program.action(() => { void launchTui(); });
program.parseAsync(process.argv);

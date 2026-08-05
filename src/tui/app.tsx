import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { loadingVerb, oneLine } from "../shared/format.js";
import { Repl, type CommandHint } from "./repl.js";
import { SetupWizard, type SetupClient } from "./setup/wizard.js";
import { ModelScreen } from "./screens/model.js";
import { ConfigScreen, type ConfigInfo } from "./screens/config.js";
import { WebIqKeyScreen } from "./screens/webiq-key.js";
import { NetworkScreen, type NetworkInfo, type NetworkAction } from "./screens/network.js";
import { SkillScreen } from "./screens/skill.js";
import type { SkillEntry } from "./skills/catalog.js";
import { summarizeStatus, githubLoginState, type StatusSummary, type GithubLoginState } from "./status-summary.js";
import { remoteConfigBlocks } from "./setup/remote-config.js";
import type { Scope, ApplyResult } from "./setup/apply.js";
import type { ClientStatus, ScopeStatus } from "./setup/status.js";
import { theme } from "./theme.js";
import type { Registry } from "./slash/registry.js";
import { withCost, fmtTokens as k, fmtCost as usd, type Aggregate } from "./panels/metrics-agg.js";
import type { WorkerState, StatusResponse, MetricsResponse } from "../shared/control-types.js";
import type { WebSearchBackend } from "../shared/webiq-key.js";
import { claudeMapLines } from "../core/claude-model-map.js";

type Entry =
  | { type: "user"; text: string }
  | { type: "assistant"; text: string; streaming?: boolean; startedAt?: number }
  | { type: "system"; text: string }
  | { type: "card"; title: string; tone: "info" | "ok" | "error"; lines: string[] }
  | { type: "metrics"; agg: Aggregate; day: Aggregate; errors: string[] }
  | { type: "help"; commands: CommandHint[] };

type Screen = { kind: "model" } | { kind: "setup"; client: SetupClient } | { kind: "config" } | { kind: "webiq-key" } | { kind: "network" } | { kind: "skill" } | null;

const stateColor: Record<WorkerState, string> = {
  ready: theme.ready, starting: theme.starting, crashed: theme.crashed, unhealthy: theme.unhealthy,
};

const EMPTY_STATUS: ClientStatus = { claude: { user: false, project: false }, codex: { user: false, project: false } };
const SPINNER = ["✶", "✸", "✹", "✺", "✹", "✷"];

// The 2s status poll re-reads the config files and would call setStatus with a FRESH object every tick.
// A new reference defeats React's bail-out, so the whole frame re-renders every 2s — and when scrollback
// (e.g. a tall /metrics card) overflows the terminal, Ink repaints with a full clear, which reads as
// flicker. Compare by value so a stable config produces zero re-renders: the poll only repaints on a real
// change (a config file was edited), never on an idle tick.
const sameScope = (a: ScopeStatus, b: ScopeStatus): boolean =>
  a.user === b.user && a.project === b.project && a.userModel === b.userModel && a.projectModel === b.projectModel;
export const sameStatus = (a: ClientStatus, b: ClientStatus): boolean =>
  sameScope(a.claude, b.claude) && sameScope(a.codex, b.codex);

// Startup overview card. GitHub shows a login STATE (no real token expiry exists). Web search shows
// the resolved backend: "via WebIQ", "via Copilot (native)", or "unavailable — run /webiq".
// `extra` appends detail lines (e.g. worker restart history for /status).
function statusCard(s: StatusSummary, extra: string[] = [], clients?: ClientStatus): Entry {
  const gh = s.github === "connected" ? "✓ connected" : s.github === "expired" ? "✗ expired — run /login" : "✗ signed out — run /login";
  // Fold in who's logged in + their Copilot plan when connected: "✓ connected · Can Wang (canwa) ·
  // Copilot Enterprise". Each segment is appended only when present, so a failed/pending lookup just
  // shows "✓ connected" with no dangling separator.
  const ghLine = [gh, s.identity, s.plan].filter(Boolean).join(" · ");
  const web = s.webSearch === "webiq" ? "✓ via WebIQ" : s.webSearch === "copilot" ? "✓ via Copilot (native)" : "✗ unavailable — run /webiq";
  // Per-scope + model when we have the file-derived detail; else fall back to the simple flag.
  const scope = (sc?: { on: boolean; model?: string }) => sc?.on ? `✓ ${sc.model ? sc.model.replace(/\[1m\]$/, "") : "on"}` : "○";
  const clientsLine = clients
    ? `claude u:${scope({ on: clients.claude.user, model: clients.claude.userModel })} p:${scope({ on: clients.claude.project, model: clients.claude.projectModel })} · codex u:${scope({ on: clients.codex.user, model: clients.codex.userModel })} p:${scope({ on: clients.codex.project, model: clients.codex.projectModel })}`
    : `claude ${s.clients.claude ? "✓" : "○"}  codex ${s.clients.codex ? "✓" : "○"}`;
  const tone: "ok" | "error" = s.github === "connected" ? "ok" : "error";
  return { type: "card", title: "status", tone, lines: [
    `GitHub login   ${ghLine}`,
    `web search     ${web}`,
    `worker         ${s.worker}`,
    `clients        ${clientsLine}`,
    ...extra,
  ] };
}

const fmtElapsed = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
};
const fmtTokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

export interface AppProps {
  registry: Registry;
  title: string;
  workerState?: WorkerState;
  initialModel?: string;
  statusSource?: () => Promise<StatusResponse>;
  metricsSource?: () => Promise<MetricsResponse>; // server-side lifetime + 24h rollups for /metrics
  readStatus?: () => ClientStatus;            // reads the real config files (per user/project scope)
  modelLimits?: Record<string, number>;       // model id -> context window, shown in the picker
  modelLabels?: Record<string, string>;       // display-only labels; submitted model ids stay unchanged
  onChat?: (text: string, print: (line: string) => void, model?: string, abort?: AbortController) => Promise<void>;
  loadModels?: () => Promise<string[]>;
  setup?: { apply: (client: SetupClient, scope: Scope, model: string) => Promise<ApplyResult> };
  // Install a bundled agent skill into a client's skills dir. Optional → the /setup-skill surface is
  // hidden when a host doesn't wire it (the command falls through to its stub message).
  installSkill?: (scope: Scope, entry: SkillEntry) => Promise<ApplyResult>;
  info?: ConfigInfo;
  onModelChange?: (model: string) => void;
  pickModelOnStart?: boolean;
  claudeMapEnabled?: () => boolean;
  // Persists the preference and restarts the worker. A rejection means persistence may have succeeded
  // but activation is incomplete; the UI reports that distinction and points to /restart.
  setClaudeMap?: (enabled: boolean) => Promise<void>;
  // Device-code login. `show` pushes the verification URL + code to the UI immediately; the
  // returned promise resolves with a completion message once the user authorizes. The two-phase
  // shape is required: a single blocking call would hide the code behind the token poll.
  login?: (show: (lines: string[]) => void) => Promise<string[]>;
  // Web search backend control. /webiq opts into Microsoft Web IQ (enableWebiq stores the key + flips
  // mode); disableWebiq (/webiq clean) clears the key. webSearchBackend reports the RESOLVED active
  // backend (copilot | webiq | unavailable), read live so the HUD/status reflect it.
  enableWebiq?: (key: string) => void;
  disableWebiq?: () => void;
  webSearchBackend?: () => WebSearchBackend;
  // Network access mode control. networkInfo reads the LIVE posture (mode + key + LAN URL) for the
  // /network panel and HUD. setAccessMode flips localhost↔lan (restarting the worker to re-bind the
  // socket) and returns the resulting info; rotateKey mints a fresh key. All optional so a host that
  // doesn't wire them simply hides the surface.
  networkInfo?: () => NetworkInfo;
  setAccessMode?: (mode: "localhost" | "lan") => Promise<NetworkInfo>;
  rotateKey?: () => Promise<NetworkInfo>;
  // Each client's pinned model on THIS machine (from the real config files) + its real context
  // window, used to fill the remote-setup config blocks shown when switching to LAN. Optional →
  // blocks fall back to defaults and omit the window.
  clientModels?: () => { claude?: string; codex?: string; claudeWindow?: number; codexWindow?: number };
  // One-time status overview shown as the first card on startup.
  startupStatus?: StatusSummary;
  // "What's new" banner shown a few launches then suppressed; the cli decides via prefs and passes
  // pre-filtered lines (omit to show nothing). onSeen records one view so it eventually stops.
  changeBanner?: { lines: string[] };
  onChangeSeen?: () => void;
  // Live GitHub login check for /status (a real token-exchange check). Defaults to the startup value.
  githubStatus?: () => Promise<GithubLoginState>;
  // Fresh account facts (username + Copilot plan label) for the live /status card. Best-effort — may
  // return empty fields if the lookups fail. Startup uses startupStatus.identity/plan instead.
  accountInfo?: () => Promise<{ identity?: string; plan?: string }>;
}

// Split card lines into physical rows: a single rendered <Text> with an embedded newline makes
// Ink/Yoga mis-measure the box and the border bleeds (a Copilot 502's HTML body once did exactly
// this). Exploding on newlines guarantees each row is its own <Text> — callers should still sanitize,
// but the card alone can no longer be broken by multiline content. Exported for direct unit testing
// (a TTY-less render harness can't reproduce the visual break, so we test the logic, not the pixels).
export function cardRows(lines: string[]): string[] {
  return lines.flatMap((l) => l.split(/\r?\n/));
}

function OutputCard({ title, lines, tone }: { title: string; lines: string[]; tone: "info" | "ok" | "error" }) {
  const border = tone === "error" ? theme.error : tone === "ok" ? theme.ready : theme.border;
  const rows = cardRows(lines);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={border} paddingX={1} marginBottom={1}>
      <Text color={theme.accent} bold>{title}</Text>
      {rows.map((l, i) => {
        const m = /^(OK|FAIL)\s+(.*)$/.exec(l);
        if (m) {
          const ok = m[1] === "OK";
          return (
            <Text key={i}>
              <Text color={ok ? theme.ready : theme.error}>{ok ? "✓ " : "✗ "}</Text>
              <Text color={theme.output}>{m[2]}</Text>
            </Text>
          );
        }
        return <Text key={i} color={theme.output}>{l}</Text>;
      })}
    </Box>
  );
}

// Styled /metrics: a colored summary row of chips, then an aligned per-model table. Numbers carry
// the accent/state colors; labels are dimmed — so the eye lands on counts and cost, not boilerplate.
// Shows lifetime totals AND a last-24h line; both are real SQL rollups over the whole request_log.
function MetricsCard({ agg, day, errors }: { agg: Aggregate; day: Aggregate; errors: string[] }) {
  const top = [...agg.byModel].sort((a, b) => b.count - a.count);
  const w = Math.min(22, Math.max(8, ...top.map((r) => r.model.replace(/^claude-/, "").length)));
  const m = (s: string) => s.replace(/^claude-/, "").slice(0, w).padEnd(w);
  // One labelled summary line (all-time / last 24h share this shape).
  const summary = (label: string, a: Aggregate) => (
    <Text>
      <Text color={theme.muted}>{label.padEnd(9)}</Text>
      <Text color={theme.ready} bold>{a.total}</Text><Text color={theme.muted}> reqs  </Text>
      <Text color={a.errors ? theme.error : theme.muted} bold>{a.errors}</Text><Text color={theme.muted}> err  </Text>
      <Text color={theme.assistant}>{k(a.tokensIn)}↑ {k(a.tokensOut)}↓</Text><Text color={theme.muted}>  est </Text>
      <Text color={theme.accent} bold>{usd(a.costUsd)}</Text>
    </Text>
  );
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1} marginBottom={1}>
      <Text color={theme.accent} bold>metrics</Text>
      {summary("all-time", agg)}
      {summary("last 24h", day)}
      <Text color={theme.border}>{"─".repeat(w + 26)}</Text>
      {top.map((r) => (
        <Text key={r.model}>
          <Text color={theme.output}>{m(r.model)}</Text>
          <Text color={theme.muted}>  n=</Text><Text color={theme.assistant}>{String(r.count).padEnd(4)}</Text>
          <Text color={theme.muted}>{String(r.avgMs).padStart(5)}ms  </Text>
          <Text color={theme.assistant}>{k(r.tokensIn)}/{k(r.tokensOut)}</Text>
          <Text color={theme.muted}> ~</Text><Text color={theme.accent}>{usd(r.costUsd)}</Text>
        </Text>
      ))}
      {agg.total === 0 && <Text color={theme.muted}>no requests yet</Text>}
      {errors.length > 0 && <Text color={theme.error}>recent errors:</Text>}
      {errors.map((e, i) => <Text key={i} color={theme.muted}>  {e}</Text>)}
      <Text color={theme.muted} dimColor>all-time totals · cost = list-price estimate (Copilot is flat-fee)</Text>
    </Box>
  );
}

function HelpCard({ commands }: { commands: CommandHint[] }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1} marginBottom={1}>
      <Text color={theme.accent} bold>Commands</Text>
      {commands.map((c) => (
        <Text key={c.name}>
          <Text color={theme.prompt}>{c.name.padEnd(16)}</Text>
          <Text color={theme.muted}>{c.describe}</Text>
        </Text>
      ))}
      <Text color={theme.muted}>tip: type / to autocomplete · plain text talks to the assistant</Text>
    </Box>
  );
}

// HUD client cell: shows configured scopes read from the real config files, with the pinned model.
function ClientBadge({ name, status }: { name: string; status: { user: boolean; project: boolean; userModel?: string; projectModel?: string } }) {
  const short = (m?: string) => (m ? m.replace(/\[1m\]$/, "").replace(/^claude-/, "").slice(0, 14) : "");
  const cell = (label: string, on: boolean, model?: string) => (
    <Text color={on ? theme.ready : theme.muted}>{label}:{on ? `✓ ${short(model)}`.trimEnd() : "○"}</Text>
  );
  return (
    <Text color={theme.muted}>
      {name} {cell("u", status.user, status.userModel)} {cell("p", status.project, status.projectModel)}
    </Text>
  );
}

export function App({
  registry, title, workerState = "starting", initialModel = "—",
  statusSource, metricsSource, readStatus, modelLimits, modelLabels, onChat,
  loadModels, setup, installSkill, info, onModelChange, pickModelOnStart, claudeMapEnabled, setClaudeMap, login, enableWebiq, disableWebiq, webSearchBackend, networkInfo, setAccessMode, rotateKey, clientModels, startupStatus, githubStatus, accountInfo, changeBanner, onChangeSeen,
}: AppProps) {
  const cmds: CommandHint[] = registry.list().map((c) => ({ name: c.name, describe: c.describe }));
  const [entries, setEntries] = useState<Entry[]>(() => [
    ...(startupStatus ? [statusCard(startupStatus)] : []),
    ...(changeBanner ? [{ type: "card" as const, title: "what's new", tone: "info" as const, lines: changeBanner.lines }] : []),
    { type: "system", text: "Type a message to chat with the assistant, or /help for commands." },
  ]);
  useEffect(() => { if (changeBanner) onChangeSeen?.(); }, []);
  const [state, setState] = useState<WorkerState>(workerState);
  const [status, setStatus] = useState<ClientStatus>(() => readStatus?.() ?? EMPTY_STATUS);
  const [webBackend, setWebBackend] = useState<WebSearchBackend>(() => webSearchBackend?.() ?? "unavailable");
  // Network access posture (mode + key + LAN URL), read live; refreshed after a /network change.
  const [net, setNet] = useState<NetworkInfo | undefined>(() => networkInfo?.());
  // GitHub login state, kept fresh by the supervisor heartbeat surfaced through the 2s status poll.
  const [github, setGithub] = useState<GithubLoginState | undefined>(startupStatus?.github);
  const [model, setModel] = useState(initialModel);
  const [screen, setScreen] = useState<Screen>(pickModelOnStart && loadModels ? { kind: "model" } : null);
  const [, setNow] = useState(0); // ticks the live loading line while the assistant streams
  const abortRef = useRef<AbortController | null>(null); // current turn's interrupt handle
  const loginInFlight = useRef(false); // guards against starting a second device-login flow
  const add = (e: Entry) => setEntries((p) => [...p, e].slice(-100));
  // Re-read the real config files, but keep the previous object when nothing changed so the 2s poll
  // doesn't force a full-frame repaint (see sameStatus). webBackend is a string and already bails on
  // equality inside setState.
  const refreshStatus = () => {
    if (readStatus) { const next = readStatus(); setStatus((prev) => (sameStatus(prev, next) ? prev : next)); }
    if (webSearchBackend) setWebBackend(webSearchBackend());
  };

  // esc interrupts an in-flight assistant turn (the Repl doesn't use esc, so this is unambiguous).
  useInput((_input, key) => { if (key.escape) abortRef.current?.abort(); });

  useEffect(() => {
    if (!statusSource && !readStatus) return;
    let alive = true;
    const tick = async () => {
      try {
        const s = await statusSource?.();
        if (alive && s) {
          setState(s.workerState);
          if (s.github) setGithub(githubLoginState(s.github.hasToken, s.github.ok)); // live login badge
        }
      } catch { /* daemon momentarily down */ }
      if (alive) refreshStatus(); // HUD reflects the real config files, even if edited externally
    };
    void tick();
    const id = setInterval(tick, 2000);
    return () => { alive = false; clearInterval(id); };
  }, [statusSource]);

  const streaming = entries.some((e) => e.type === "assistant" && e.streaming);
  useEffect(() => {
    if (!streaming) return;
    const id = setInterval(() => setNow((n) => n + 1), 200);
    return () => clearInterval(id);
  }, [streaming]);

  function pickModel(m: string) {
    setModel(m);
    onModelChange?.(m);
    setScreen(null);
    add({ type: "card", title: "model", tone: "ok", lines: [`✓ chat model set to ${m}`] });
  }

  async function handle(line: string) {
    add({ type: "user", text: `› ${line}` });
    const t = line.trim();
    if (t === "/model" && loadModels) { setScreen({ kind: "model" }); return; }
    if (t === "/claude-map" && claudeMapEnabled) {
      add({ type: "card", title: "/claude-map", tone: "info", lines: [
        `Claude map: ${claudeMapEnabled() ? "on" : "off"}`,
        ...claudeMapLines().map((mapping) => `  ${mapping}`),
      ] });
      return;
    }
    if (t.startsWith("/claude-map") && claudeMapEnabled && setClaudeMap) {
      const args = t.split(/\s+/).slice(1);
      if (args.length !== 1 || (args[0] !== "on" && args[0] !== "off")) {
        add({ type: "card", title: "/claude-map", tone: "error", lines: ["usage: /claude-map [on|off]"] });
        return;
      }
      const enabled = args[0] === "on";
      if (claudeMapEnabled() === enabled) {
        add({ type: "card", title: "/claude-map", tone: "info", lines: [`Claude map already ${args[0]}`, ...claudeMapLines().map((mapping) => `  ${mapping}`)] });
        return;
      }
      try {
        await setClaudeMap(enabled);
        const lines = [
          `✓ Claude map ${args[0]}`,
          "reopen Claude's /model picker; restart Claude Code/Desktop if its cached list is stale",
        ];
        // A saved TUI model may name a Claude model that disappeared upstream. Once mapping is enabled,
        // move the built-in assistant onto the first live mapped alias instead of leaving every chat turn
        // on a permanent model_not_supported. Preserve any already-valid selection.
        if (enabled && loadModels) {
          const models = await loadModels().catch((): string[] => []);
          if (!models.includes(model)) {
            const fallback = models.find((candidate) => modelLabels?.[candidate]?.includes(" → "));
            if (fallback) {
              setModel(fallback);
              onModelChange?.(fallback);
              lines.push(`chat model switched to ${fallback} (previous model unavailable)`);
            }
          }
        }
        add({ type: "card", title: "/claude-map", tone: "ok", lines });
      } catch (e) {
        add({ type: "card", title: "/claude-map", tone: "error", lines: [
          `preference saved, but worker activation is incomplete: ${e instanceof Error ? e.message : String(e)}`,
          "run /restart to apply the saved preference",
        ] });
      }
      return;
    }
    // Web-search backend controls. "/webiq clean" clears the key; "/webiq" opens the key screen and
    // switches to the WebIQ backend on submit. After either, re-read the resolved backend for the HUD.
    if (t === "/webiq clean" && disableWebiq) {
      disableWebiq(); setWebBackend(webSearchBackend?.() ?? "unavailable");
      add({ type: "card", title: "/webiq", tone: "ok", lines: ["✓ WebIQ key cleared"] });
      return;
    }
    if (t === "/webiq" && enableWebiq) { setScreen({ kind: "webiq-key" }); return; }
    if (t === "/status" && (startupStatus || githubStatus || webSearchBackend)) {
      // Render the live status overview (same card as startup), then the worker restart history.
      // /status is an explicit "is my login OK right now?" — do the live check when wired (the cached
      // heartbeat can be up to ~60s stale), falling back to the cached/seed value only if it isn't.
      const ghState = githubStatus ? await githubStatus() : (github ?? startupStatus?.github ?? "signed-out");
      let worker = state, restarts: string[] = [];
      try {
        const s = await statusSource?.();
        if (s) { worker = s.workerState; restarts = s.restarts.slice(0, 5).map((r) => `  ${r.reason} exit=${r.exitCode ?? "-"} ${r.stderrTail.slice(0, 60)}`); }
      } catch { /* daemon momentarily down — show what we have */ }
      // Fresh identity/plan for the live card when connected. Best-effort — a failed lookup just omits
      // them. Fall back to the startup values so a transient miss doesn't blank a name we already had.
      const acct: { identity?: string; plan?: string } = ghState === "connected" && accountInfo ? await accountInfo().catch(() => ({})) : {};
      const summary = summarizeStatus({
        hasToken: ghState !== "signed-out", tokenValid: ghState === "connected",
        webSearch: webSearchBackend?.() ?? webBackend, worker,
        clients: { claude: status.claude.user || status.claude.project, codex: status.codex.user || status.codex.project },
        identity: acct.identity ?? startupStatus?.identity,
        plan: acct.plan ?? startupStatus?.plan,
      });
      add(statusCard(summary, restarts.length ? ["", "recent restarts:", ...restarts] : [], status));
      return;
    }
    if (t === "/config" && info) { setScreen({ kind: "config" }); return; }
    if (t === "/network" && networkInfo) { setNet(networkInfo()); setScreen({ kind: "network" }); return; }
    if (t === "/metrics" && metricsSource) {
      const m = await metricsSource();
      const agg = withCost(m.all);   // lifetime totals (real COUNT(*), not a 100-row cap)
      const day = withCost(m.day);   // last 24h
      const errs = m.recentErrors.slice(0, 5).map((e) => `${e.status} ${e.model} — ${oneLine(e.error, 80) || "(no message)"}`);
      add({ type: "metrics", agg, day, errors: errs });
      return;
    }
    if (t === "/login" && login) {
      // Show the verification URL + code right away, then resolve a completion card once the user
      // authorizes. Done as a special case (not a registry command) because the slash registry only
      // renders a command's final return value — it can't surface the code mid-poll. Guarded so a
      // double Enter doesn't start two device-code flows (polling a superseded code 401s).
      if (loginInFlight.current) { add({ type: "card", title: "/login", tone: "info", lines: ["already waiting for authorization…"] }); return; }
      loginInFlight.current = true;
      void login((lines) => add({ type: "card", title: "/login", tone: "info", lines }))
        .then((lines) => add({ type: "card", title: "/login", tone: "ok", lines }))
        .catch((e) => add({ type: "card", title: "/login", tone: "error", lines: [`login failed: ${e instanceof Error ? e.message : String(e)}`] }))
        .finally(() => { loginInFlight.current = false; });
      return;
    }
    if (setup && loadModels && (t === "/setup-claude" || t === "/setup-codex")) {
      setScreen({ kind: "setup", client: t === "/setup-claude" ? "claude" : "codex" });
      return;
    }
    if (t === "/setup-skill" && installSkill) { setScreen({ kind: "skill" }); return; }
    if (line.startsWith("/")) {
      if (t === "/help") { add({ type: "help", commands: cmds }); return; }
      const out = await registry.run(line);
      const tone: "info" | "ok" | "error" =
        out.some((l) => /fail|error|unknown/i.test(l)) ? "error" : out.some((l) => /^OK /.test(l)) ? "ok" : "info";
      add({ type: "card", title: t, tone, lines: out });
      if (t === "/reset-claude" || t === "/reset-codex") refreshStatus(); // HUD follows the files
    } else if (onChat) {
      // Open one streaming bubble immediately (shows the live loading line), then append each
      // delta into it in place rather than spawning a new line per chunk.
      add({ type: "assistant", text: "", streaming: true, startedAt: Date.now() });
      const append = (chunk: string) =>
        setEntries((p) => {
          const copy = [...p];
          for (let i = copy.length - 1; i >= 0; i--) {
            const e = copy[i];
            if (e.type === "assistant" && e.streaming) { copy[i] = { ...e, text: e.text + chunk }; break; }
          }
          return copy;
        });
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        await onChat(line, append, model, ctrl);
      } finally {
        abortRef.current = null;
        setEntries((p) => p.map((e) => (e.type === "assistant" && e.streaming ? { ...e, streaming: false } : e)));
      }
    } else {
      add({ type: "system", text: "(assistant not available — use /help)" });
    }
  }

  const configured = (s: { user: boolean; project: boolean }) => s.user || s.project;

  let body: React.ReactNode;
  if (screen?.kind === "model" && loadModels) {
    body = <ModelScreen loadModels={loadModels} limits={modelLimits} labels={modelLabels} current={model} onPick={pickModel} onCancel={() => setScreen(null)} />;
  } else if (screen?.kind === "setup" && setup && loadModels) {
    const client = screen.client;
    body = (
      <SetupWizard
        client={client}
        loadModels={loadModels}
        limits={modelLimits}
        labels={modelLabels}
        apply={(scope, m) => setup.apply(client, scope, m)}
        onDone={(result, m) => {
          refreshStatus();
          setScreen(null);
          add({ type: "card", title: `setup ${client}`, tone: "ok", lines: [`✓ model ${m}`, `wrote ${result.path}`, `keys: ${result.changed.join(", ") || "(no change)"}`] });
        }}
        onCancel={() => { setScreen(null); add({ type: "system", text: "setup cancelled" }); }}
      />
    );
  } else if (screen?.kind === "config" && info) {
    body = (
      <ConfigScreen
        info={info}
        model={model}
        clients={{ claude: configured(status.claude), codex: configured(status.codex) }}
        accessMode={net?.mode}
        onAction={(a) => {
          if (a === "model") setScreen({ kind: "model" });
          else if (a === "network" && networkInfo) { setNet(networkInfo()); setScreen({ kind: "network" }); }
          else if (a === "setup-claude") setScreen({ kind: "setup", client: "claude" });
          else if (a === "setup-codex") setScreen({ kind: "setup", client: "codex" });
          else setScreen(null);
        }}
      />
    );
  } else if (screen?.kind === "webiq-key" && enableWebiq) {
    body = (
      <WebIqKeyScreen
        onSubmit={(k) => { enableWebiq(k); setWebBackend(webSearchBackend?.() ?? "webiq"); setScreen(null); add({ type: "card", title: "/webiq", tone: "ok", lines: ["✓ WebIQ enabled — all web search now routes through Microsoft Web IQ"] }); }}
        onCancel={() => { setScreen(null); add({ type: "system", text: "webiq cancelled" }); }}
      />
    );
  } else if (screen?.kind === "network" && net) {
    const onNet = async (a: NetworkAction) => {
      if (a === "back") { setScreen(null); return; }
      try {
        if (a === "lan" && setAccessMode) {
          const r = await setAccessMode("lan"); setNet(r); setScreen(null);
          const head = [
            "✓ LAN mode — the proxy is now reachable from other machines (worker restarting to re-bind)",
            r.lanUrl ? `Claude    ${r.lanUrl}/anthropic` : "",
            r.lanUrl ? `Codex     ${r.lanUrl}/openai` : "",
            r.key ? `key       ${r.key}` : "",
          ].filter(Boolean);
          // Paste-ready remote config: each block has the LAN host + key already in the right slot
          // (Claude → ANTHROPIC_API_KEY, Codex → experimental_bearer_token). Only when we know the LAN
          // URL + key (both hold in LAN; the URL can be null only if we couldn't read a LAN IPv4).
          const blocks: string[] = [];
          if (r.lanUrl && r.key) {
            const models = clientModels?.() ?? {};
            for (const b of remoteConfigBlocks({ lanUrl: r.lanUrl, key: r.key, claudeModel: models.claude, codexModel: models.codex, claudeContextWindow: models.claudeWindow, codexContextWindow: models.codexWindow })) {
              const label = b.client === "claude" ? "Claude" : "Codex";
              blocks.push("", `── ${label} (remote) → ${b.path} ──`, ...b.lines);
            }
          } else {
            blocks.push("", "set each remote client's base URL to http://<this-machine-LAN-IP>:7891 (+/anthropic or /openai)");
          }
          add({ type: "card", title: "/network", tone: "ok", lines: [
            ...head,
            ...blocks,
            "",
            "remote machines must send the key as Authorization: Bearer <key> or x-api-key — without it → 401",
            "this machine keeps working over 127.0.0.1 with no key",
          ] });
        } else if (a === "localhost" && setAccessMode) {
          const r = await setAccessMode("localhost"); setNet(r); setScreen(null);
          add({ type: "card", title: "/network", tone: "ok", lines: ["✓ localhost mode — loopback only, private to this machine (worker restarting to re-bind)"] });
        } else if (a === "rotate" && rotateKey) {
          const r = await rotateKey(); setNet(r);
          add({ type: "card", title: "/network", tone: "ok", lines: [`✓ access key ${net.key ? "rotated" : "generated"}`, r.key ? `key  ${r.key}` : ""].filter(Boolean) });
        }
      } catch (e) {
        setScreen(null);
        add({ type: "card", title: "/network", tone: "error", lines: [`network change failed: ${e instanceof Error ? e.message : String(e)}`] });
      }
    };
    body = <NetworkScreen info={net} onAction={onNet} />;
  } else if (screen?.kind === "skill" && installSkill) {
    body = (
      <SkillScreen
        install={(scope, entry) => installSkill(scope, entry)}
        onDone={(result, entry, scope) => {
          setScreen(null);
          add({ type: "card", title: "install skill", tone: "ok", lines: [
            `✓ ${entry.title}  (${scope})`,
            `wrote ${result.path}`,
            `files: ${result.changed.join(", ") || "(already up to date)"}`,
            "Claude Code discovers it on its next launch.",
          ] });
        }}
        onCancel={() => { setScreen(null); add({ type: "system", text: "skill install cancelled" }); }}
      />
    );
  } else {
    body = <Repl onSubmit={handle} commands={cmds} />;
  }

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between" paddingX={1}>
        <Text color={theme.accent} bold>✳ {title}</Text>
        <Text color={theme.muted}>worker: <Text color={stateColor[state]}>{state}</Text></Text>
      </Box>

      <Box flexDirection="column" paddingX={1} marginTop={1}>
        {entries.map((e, i) => {
          if (e.type === "card") return <OutputCard key={i} title={e.title} lines={e.lines} tone={e.tone} />;
          if (e.type === "metrics") return <MetricsCard key={i} agg={e.agg} day={e.day} errors={e.errors} />;
          if (e.type === "help") return <HelpCard key={i} commands={e.commands} />;
          const color = e.type === "user" ? theme.user : e.type === "assistant" ? theme.assistant : theme.muted;
          if (e.type === "assistant" && e.streaming) {
            const elapsed = e.startedAt ? Date.now() - e.startedAt : 0;
            const frame = SPINNER[Math.floor(Date.now() / 200) % SPINNER.length];
            const tokens = Math.ceil(e.text.length / 4);
            return (
              <Box key={i} flexDirection="column">
                <Text color={theme.accent}>✽ <Text color={theme.muted}>{frame} {loadingVerb(elapsed)}… (esc to interrupt · {fmtElapsed(elapsed)} · ↓ {fmtTokens(tokens)} tokens · thinking)</Text></Text>
                {e.text ? <Text color={color}>{e.text}</Text> : null}
              </Box>
            );
          }
          // User turns get a clay-on-dark highlight bar so they stand out from muted system notes and
          // gray assistant output — a clear visual anchor for "this is what I said".
          if (e.type === "user") return <Box key={i} marginTop={1}><Text backgroundColor={theme.accent} color="black" bold>{` ${e.text.replace(/^›\s*/, "")} `}</Text></Box>;
          return <Text key={i} color={color}>{e.text}</Text>;
        })}
      </Box>

      {body}

      <Box flexDirection="column" paddingX={1}>
        <Box>
          {github && <><Text color={theme.muted}>github </Text><Text color={github === "connected" ? theme.ready : theme.error}>{github === "connected" ? "✓" : "✗ /login"}</Text></>}
          <Text color={theme.muted}>{github ? "  ·  " : ""}daemon </Text><Text color={stateColor[state]}>{state}</Text>
          {net && <><Text color={theme.muted}>  ·  net </Text><Text color={net.mode === "lan" ? theme.accent : theme.muted}>{net.mode === "lan" ? "⚠ LAN" : "localhost"}</Text></>}
        </Box>
        <Box>
          <Text color={theme.muted}>web </Text><Text color={webBackend === "unavailable" ? theme.muted : theme.ready}>{webBackend === "webiq" ? "✓ webiq" : webBackend === "copilot" ? "✓ copilot" : "✗ /webiq"}</Text>
          <Text color={theme.muted}>  ·  </Text><ClientBadge name="claude" status={status.claude} />
          <Text color={theme.muted}>  </Text><ClientBadge name="codex" status={status.codex} />
          <Text color={theme.muted}>  ·  /help</Text>
        </Box>
      </Box>
    </Box>
  );
}

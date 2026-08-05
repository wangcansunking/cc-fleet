import { Registry, type SlashContext } from "./registry.js";
import { claudeCodeConfig, codexConfig, type Endpoint } from "../setup/clients.js";
import { withCost, fmtTokens as k, fmtCost as usd } from "../panels/metrics-agg.js";
import { openUrl as defaultOpenUrl } from "../../shared/open-url.js";
import { buildIssueUrl, PLACEHOLDER_REPO } from "../report.js";
import { APP_CHANGES } from "../../changes.js";
import { oneLine } from "../../shared/format.js";

export interface RegistryOpts {
  dashboardUrl?: string;            // supervisor URL the /dashboard command opens
  reportRepo?: string;              // "owner/repo" for /report; unset/placeholder disables it
  appVersion?: string;
  platform?: string;
  openUrl?: (url: string) => void;  // injectable for tests
  resetClient?: (client: "claude" | "codex") => Promise<string[]>; // restore client config
  login?: () => Promise<string[]>;  // re-run GitHub device-code login
  logout?: () => Promise<string[]>; // clear the stored GitHub token
}

export function buildRegistry(ctx: SlashContext, endpoint: Endpoint, opts: RegistryOpts = {}): Registry {
  const reg = new Registry(ctx);
  const openUrl = opts.openUrl ?? defaultOpenUrl;
  reg.add({ name: "/status", describe: "show worker status + restart history", run: async (_a, c) => {
    const s = await c.client.status();
    const lines = [`worker: ${s.workerState}`];
    for (const r of s.restarts.slice(0, 5)) lines.push(`  ${r.reason} exit=${r.exitCode ?? "-"} ${r.stderrTail.slice(0, 60)}`);
    return lines;
  } });
  reg.add({ name: "/doctor", describe: "self-check: login, worker, web search, models reachable", run: async (_a, c) => (await c.client.doctor(true)).map((x) => `${x.ok ? "OK " : "FAIL"} ${x.name}: ${x.detail}`) });
  reg.add({ name: "/restart", describe: "restart the worker", run: async (_a, c) => { await c.client.restart(); return ["restart requested"]; } });
  reg.add({ name: "/stop", describe: "stop the worker", run: async (_a, c) => { await c.client.stop(); return ["worker stopped"]; } });
  reg.add({ name: "/start", describe: "start the worker", run: async (_a, c) => { await c.client.start(); return ["worker started"]; } });
  reg.add({ name: "/logs", describe: "recent request errors (what failed & why)", run: async (_a, c) => {
    // recentErrors comes from a SQL query over the WHOLE request_log, so errors that scrolled past the
    // last-100-requests window still show (the old path filtered a 100-row fetch and could miss them).
    const errs = (await c.client.metrics()).recentErrors.slice(0, 20);
    if (!errs.length) return ["no request errors logged — everything's green ✓"];
    // oneLine() flattens the message: upstream failures can carry a whole HTML page (a Copilot 502)
    // or a "raw\nhint" pair, and a newline here would shatter the bordered card it renders into.
    return errs.map((e) => `${new Date(e.ts).toISOString()} ${e.status} ${e.endpoint} ${e.model} — ${oneLine(e.error, 160) || "(no message)"}`);
  } });
  reg.add({ name: "/metrics", describe: "request metrics, tokens, cost + recent errors", run: async (_a, c) => {
    // Real lifetime rollup over the whole request_log (not a capped 100-row fetch), cost from list price.
    const m = await c.client.metrics();
    const a = withCost(m.all), d = withCost(m.day);
    if (!a.total) return ["no requests yet"];
    const line = (label: string, x: typeof a) => `${label}: ${x.total}  errors: ${x.errors}  tokens: ${k(x.tokensIn)}↑ ${k(x.tokensOut)}↓  est. cost: ${usd(x.costUsd)}`;
    const lines = [
      line("all-time", a),
      line("last 24h", d),
      ...a.byModel.map((r) => `  ${r.model.padEnd(20)} n=${r.count} avg=${r.avgMs}ms  ${k(r.tokensIn)}↑ ${k(r.tokensOut)}↓ ~${usd(r.costUsd)}`),
      "  cost is a list-price estimate (Copilot is flat-fee)",
    ];
    const errs = m.recentErrors.slice(0, 5);
    if (errs.length) {
      lines.push("recent errors:");
      for (const e of errs) lines.push(`  ${e.status} ${e.model} — ${oneLine(e.error, 80) || "(no message)"}`);
    }
    return lines;
  } });
  reg.add({ name: "/setup-claude", describe: "print Claude Code config", run: async () => claudeCodeConfig(endpoint).instructions.split("\n") });
  reg.add({ name: "/setup-codex", describe: "print Codex/OpenAI config", run: async () => codexConfig(endpoint).instructions.split("\n") });
  reg.add({ name: "/setup-status", describe: "show configured endpoints", run: async () => [`OpenAI: http://${endpoint.host}:${endpoint.port}/openai`, `Anthropic: http://${endpoint.host}:${endpoint.port}/anthropic`] });
  // Opens the skill picker (handled in the App, like /config) — a no-op stub so the command is
  // recognized and listed in /help + autocomplete rather than reported as unknown.
  reg.add({ name: "/setup-skill", describe: "install a bundled agent skill into Claude Code", run: async () => ["opening skill picker…"] });
  reg.add({ name: "/reset-claude", describe: "restore Claude Code config (remove copilot-reverse's keys)", run: async () => opts.resetClient ? opts.resetClient("claude") : ["reset not available"] });
  reg.add({ name: "/reset-codex", describe: "restore Codex/OpenAI config (remove copilot-reverse's keys)", run: async () => opts.resetClient ? opts.resetClient("codex") : ["reset not available"] });
  reg.add({ name: "/login", describe: "sign in to GitHub (device-code)", run: async () => opts.login ? opts.login() : ["login not available"] });
  reg.add({ name: "/logout", describe: "sign out — remove the stored GitHub token", run: async () => opts.logout ? opts.logout() : ["logout not available"] });
  reg.add({ name: "/model", describe: "switch the chat model", run: async () => ["opening model picker…"] });
  // Stateful behavior is handled in App (like /model); this stub keeps help/autocomplete complete.
  reg.add({ name: "/claude-map", describe: "map native Claude names to available GPT backends", run: async () => ["showing Claude model map…"] });
  // Web search works out of the box via Copilot; /webiq opts into Microsoft Web IQ, /webiq clean
  // reverts. Handled in the App (opens the key screen / toggles), so this is a no-op stub that exists
  // only so the command is recognized and not reported as unknown.
  reg.add({ name: "/webiq", describe: "use Microsoft Web IQ for web search (/webiq clean to revert)", run: async () => ["opening webiq…"] });
  reg.add({ name: "/config", describe: "view & change configuration", run: async () => ["opening config panel…"] });
  reg.add({ name: "/network", describe: "view & change network access mode (localhost / LAN)", run: async () => ["opening network panel…"] });
  reg.add({ name: "/dashboard", describe: "open the web dashboard in your browser", run: async () => {
    if (!opts.dashboardUrl) return ["dashboard URL not available"];
    openUrl(opts.dashboardUrl);
    return [`opening dashboard: ${opts.dashboardUrl}`];
  } });
  reg.add({ name: "/report", describe: "open a pre-filled GitHub issue with diagnostics", run: async (_a, c) => {
    const repo = opts.reportRepo;
    if (!repo || repo === PLACEHOLDER_REPO) return ["set reportRepo (owner/repo) in config to enable /report"];
    const [status, doctor, metrics] = await Promise.all([c.client.status(), c.client.doctor(), c.client.metrics()]);
    const url = buildIssueUrl({
      repo, version: opts.appVersion ?? "0.0.0", platform: opts.platform ?? process.platform,
      status, doctor, errors: metrics.recentErrors.slice(0, 10),
    });
    openUrl(url);
    return [`opening a pre-filled GitHub issue for ${repo} in your browser…`];
  } });
  reg.add({ name: "/changes", describe: "what's new — recent releases", run: async () => {
    if (!APP_CHANGES.length) return ["no changelog bundled"];
    // Header per release, then one bullet per bundled change. A release that merged several
    // changesets has several summaries; listing only the first would hide every later change
    // (e.g. a headline feature buried under a release-plumbing fix).
    const clip = (s: string) => (s.length > 86 ? s.slice(0, 85) + "…" : s);
    const lines: string[] = [];
    for (const c of APP_CHANGES.slice(0, 10)) {
      lines.push(`v${c.version} (${c.date})`);
      for (const s of c.summaries) lines.push(`  • ${clip(s)}`);
    }
    const repo = opts.reportRepo && opts.reportRepo !== PLACEHOLDER_REPO ? opts.reportRepo : "wangcansunking/copilot-reverse";
    lines.push("", `full changelog: https://github.com/${repo}/blob/master/CHANGELOG.md`);
    return lines;
  } });
  reg.add({ name: "/quit", describe: "exit copilot-reverse", run: async (_a, c) => { c.quit(); return ["bye"]; } });
  reg.add({ name: "/help", describe: "list commands", run: async () => reg.list().map((c) => `${c.name.padEnd(14)} ${c.describe}`) });
  return reg;
}

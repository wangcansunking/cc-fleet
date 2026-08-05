import { describe, it, expect, vi } from "vitest";
import { buildRegistry } from "../../src/tui/slash/commands.js";
import { aggregate } from "../../src/tui/panels/metrics-agg.js";
import type { MetricSample, MetricsResponse, MetricsWindow } from "../../src/shared/control-types.js";

const endpoint = { host: "127.0.0.1", port: 7891, apiKey: "k" };

// Build a server-shaped MetricsResponse from plain samples so tests stay expressed in samples. The
// real aggregate() rolls them up into the lifetime window; day mirrors all-time here (tests don't
// exercise the 24h cut), and recentErrors is the failed rows newest-first.
function metricsOf(samples: MetricSample[]): MetricsResponse {
  const a = aggregate(samples);
  const win: MetricsWindow = { total: a.total, errors: a.errors, tokensIn: a.tokensIn, tokensOut: a.tokensOut,
    byModel: a.byModel.map((r) => ({ model: r.model, count: r.count, errors: samples.filter((s) => s.model === r.model && (s.status >= 400 || s.error != null)).length, avgMs: r.avgMs, tokensIn: r.tokensIn, tokensOut: r.tokensOut })) };
  const recentErrors = samples.filter((s) => s.status >= 400 || s.error != null).slice().sort((x, y) => y.ts - x.ts);
  return { all: win, day: win, recentErrors };
}

function ctx() {
  return {
    client: {
      status: vi.fn(async () => ({ workerState: "ready", restarts: [{ ts: 1, reason: "crash", exitCode: 1, stderrTail: "boom", markedUnhealthy: 0 as const }] })),
      restart: vi.fn(async () => {}), stop: vi.fn(async () => {}), start: vi.fn(async () => {}),
      doctor: vi.fn(async () => [{ name: "github-auth", ok: true, detail: "ok" }]),
      requests: vi.fn(async () => []),
      metrics: vi.fn(async () => metricsOf([])),
    },
    quit: vi.fn(),
  };
}

describe("slash commands", () => {
  it("dispatches /status", async () => {
    const reg = buildRegistry(ctx() as any, endpoint);
    const out = await reg.run("/status");
    expect(out.join("\n")).toMatch(/worker: ready/i);
  });
  it("/restart calls client", async () => {
    const c = ctx();
    await buildRegistry(c as any, endpoint).run("/restart");
    expect(c.client.restart).toHaveBeenCalled();
  });
  it("/doctor lists checks and requests the per-model ping", async () => {
    const c = ctx();
    const out = await buildRegistry(c as any, endpoint).run("/doctor");
    expect(out.join("\n")).toMatch(/github-auth.*ok/i);
    expect(c.client.doctor).toHaveBeenCalledWith(true); // /doctor is the on-demand self-check → ping
  });
  it("/help lists commands", async () => {
    const out = await buildRegistry(ctx() as any, endpoint).run("/help");
    expect(out.join("\n")).toMatch(/\/status/);
  });
  it("/help lists /webiq, and the removed /web-search-support is gone", async () => {
    const reg = buildRegistry(ctx() as any, endpoint);
    expect((await reg.run("/help")).join("\n")).toMatch(/\/webiq/);            // visible in help
    expect(reg.list().map((c) => c.name)).toContain("/webiq");                 // visible in autocomplete
    expect((await reg.run("/webiq")).join("\n")).not.toMatch(/unknown/i);      // recognized
    expect((await reg.run("/web-search-support")).join("\n")).toMatch(/unknown/i); // old command gone
  });
  it("/claude-map is recognized and listed for help/autocomplete", async () => {
    const reg = buildRegistry(ctx() as any, endpoint);
    expect((await reg.run("/help")).join("\n")).toMatch(/\/claude-map/);
    expect(reg.list().map((c) => c.name)).toContain("/claude-map");
    expect((await reg.run("/claude-map")).join("\n")).not.toMatch(/unknown/i);
  });
  it("unknown command", async () => {
    const out = await buildRegistry(ctx() as any, endpoint).run("/nope");
    expect(out.join("\n")).toMatch(/unknown/i);
  });
  it("/setup-claude prints ANTHROPIC_BASE_URL", async () => {
    const out = await buildRegistry(ctx() as any, endpoint).run("/setup-claude");
    expect(out.join("\n")).toMatch(/ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:7891\/anthropic/);
  });
  it("/setup-skill is recognized and listed in /help + autocomplete", async () => {
    const reg = buildRegistry(ctx() as any, endpoint);
    expect((await reg.run("/setup-skill")).join("\n")).not.toMatch(/unknown/i); // recognized (stub)
    expect((await reg.run("/help")).join("\n")).toMatch(/\/setup-skill/);        // visible in help
    expect(reg.list().map((c) => c.name)).toContain("/setup-skill");             // in autocomplete
  });
  it("/metrics shows empty-state when no requests", async () => {
    const out = await buildRegistry(ctx() as any, endpoint).run("/metrics");
    expect(out.join("\n")).toMatch(/no requests yet/i);
  });
  it("/logs flattens a multi-line error so each entry stays on one line", async () => {
    const c = ctx();
    c.client.metrics = vi.fn(async () => metricsOf([
      { ts: 1700000000000, endpoint: "/anthropic/v1/messages", model: "claude-opus-4-8", status: 502, latencyMs: 10,
        error: "copilot stream failed: 502 — <!DOCTYPE html>\n<html>\n  <body>502</body>\n</html>\nGitHub login expired — run /login" },
    ]));
    const out = await buildRegistry(c as any, endpoint).run("/logs");
    // Each rendered entry must be exactly one physical line — no entry may smuggle in a newline.
    for (const line of out) expect(line).not.toMatch(/\n/);
    expect(out.join("")).toMatch(/502/);
  });
  it("/metrics flattens multi-line errors in its recent-errors tail", async () => {
    const c = ctx();
    c.client.metrics = vi.fn(async () => metricsOf([
      { ts: 1700000000000, endpoint: "/anthropic/v1/messages", model: "claude-opus-4-8", status: 502, latencyMs: 10,
        error: "boom\n<html>\n  <body>x</body>\n</html>" },
    ]));
    const out = await buildRegistry(c as any, endpoint).run("/metrics");
    for (const line of out) expect(line).not.toMatch(/\n/);
  });
  it("/metrics reports token totals and an estimated cost", async () => {
    const c = ctx();
    c.client.metrics = vi.fn(async () => metricsOf([
      { ts: 2, endpoint: "/anthropic/v1/messages", model: "claude-opus-4-8", status: 200, latencyMs: 30, tokensIn: 1000, tokensOut: 500 },
    ]));
    const out = (await buildRegistry(c as any, endpoint).run("/metrics")).join("\n");
    expect(out).toMatch(/tokens: 1\.0k↑ 500↓/);
    expect(out).toMatch(/est\. cost: \$/);
  });
  it("/dashboard opens the dashboard url in the browser", async () => {
    const opened: string[] = [];
    const reg = buildRegistry(ctx() as any, endpoint, { dashboardUrl: "http://127.0.0.1:7890/", openUrl: (u) => opened.push(u) });
    const out = await reg.run("/dashboard");
    expect(opened).toEqual(["http://127.0.0.1:7890/"]);
    expect(out.join("\n")).toMatch(/127\.0\.0\.1:7890/);
  });
  it("/report opens a prefilled GitHub issue when a repo is configured", async () => {
    const opened: string[] = [];
    const reg = buildRegistry(ctx() as any, endpoint, { reportRepo: "octo/copilot-reverse", appVersion: "0.0.1", openUrl: (u) => opened.push(u) });
    await reg.run("/report");
    expect(opened[0]).toMatch(/^https:\/\/github\.com\/octo\/copilot-reverse\/issues\/new\?/);
  });
  it("/report guides the user to set a repo when unconfigured", async () => {
    const opened: string[] = [];
    const reg = buildRegistry(ctx() as any, endpoint, { openUrl: (u) => opened.push(u) });
    const out = await reg.run("/report");
    expect(opened).toHaveLength(0);
    expect(out.join("\n")).toMatch(/reportRepo/);
  });
  it("/reset-claude invokes the reset handler for claude", async () => {
    const calls: string[] = [];
    const reg = buildRegistry(ctx() as any, endpoint, { resetClient: async (c) => { calls.push(c); return [`removed ${c} config`]; } });
    const out = await reg.run("/reset-claude");
    expect(calls).toEqual(["claude"]);
    expect(out.join("\n")).toMatch(/removed claude config/);
  });
  it("/reset-codex invokes the reset handler for codex", async () => {
    const calls: string[] = [];
    const reg = buildRegistry(ctx() as any, endpoint, { resetClient: async (c) => { calls.push(c); return ["ok"]; } });
    await reg.run("/reset-codex");
    expect(calls).toEqual(["codex"]);
  });
  it("/login invokes the login handler", async () => {
    let called = false;
    const reg = buildRegistry(ctx() as any, endpoint, { login: async () => { called = true; return ["enter code: ABCD-1234"]; } });
    const out = await reg.run("/login");
    expect(called).toBe(true);
    expect(out.join("\n")).toMatch(/ABCD-1234/);
  });
  it("/logout invokes the logout handler", async () => {
    let called = false;
    const reg = buildRegistry(ctx() as any, endpoint, { logout: async () => { called = true; return ["signed out"]; } });
    const out = await reg.run("/logout");
    expect(called).toBe(true);
    expect(out.join("\n")).toMatch(/signed out/);
  });
  it("/login and /logout degrade gracefully when no handler is wired", async () => {
    const reg = buildRegistry(ctx() as any, endpoint);
    expect((await reg.run("/login")).join("\n")).toMatch(/not available/);
    expect((await reg.run("/logout")).join("\n")).toMatch(/not available/);
  });
  it("/changes lists recent versions as headers with bulleted changes and ends with the changelog url", async () => {
    const out = await buildRegistry(ctx() as any, endpoint).run("/changes");
    expect(out.length).toBeGreaterThan(1);
    expect(out[0]).toMatch(/^v\d+\.\d+\.\d+ \(\d{4}-\d{2}-\d{2}\)$/); // header line, no inline summary
    expect(out.some((l) => /^ {2}• /.test(l))).toBe(true);          // at least one bulleted change
    expect(out.at(-1)).toMatch(/blob\/master\/CHANGELOG\.md$/);
  });
  it("/changes uses the configured repo for the changelog url", async () => {
    const out = await buildRegistry(ctx() as any, endpoint, { reportRepo: "octo/copilot-reverse" }).run("/changes");
    expect(out.at(-1)).toMatch(/github\.com\/octo\/copilot-reverse\/blob\/master\/CHANGELOG\.md/);
  });
});

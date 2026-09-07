import { describe, it, expect } from "vitest";
import request from "supertest";
import { dashboardHtml } from "../../src/supervisor/dashboard.js";
import { createControlApp } from "../../src/supervisor/api.js";
import { openDb, recordRequest } from "../../src/supervisor/db.js";

const dash = { clients: () => ({ claude: { user: false, project: false }, codex: { user: false, project: false } }), models: async () => [] };

describe("dashboard", () => {
  it("is a self-contained HTML page that pulls the control API", () => {
    const html = dashboardHtml();
    expect(html).toMatch(/<!doctype html>/i);
    expect(html).toContain("/api/status");
    // Totals come from the SQL rollup, not a capped /api/requests fetch.
    expect(html).toContain("/api/metrics");
    expect(html).toContain("/api/doctor");
  });

  it("includes a complete Claude-map editor with save, cancel, reset, validation, and state styling", () => {
    const html = dashboardHtml();
    expect(html).toContain('data-view="claude-map"');
    expect(html).toContain('/api/claude-map');
    expect(html).toContain('Save & restart');
    expect(html).toMatch(/Cancel|Reload saved/);
    expect(html).toMatch(/Reset to defaults/);
    expect(html).toContain('claude-map-backends');
    expect(html).toContain('claudeMapDraftEnabled=this.checked');
    expect(html).toMatch(/unavailable/);
    expect(html).toMatch(/disabled/);
    expect(html).toMatch(/claude-/);
  });

  it("keeps the Claude-map editor responsive with its table/actions available on mobile", () => {
    const html = dashboardHtml();
    expect(html).toMatch(/@media\(max-width:760px\)/);
    expect(html).toMatch(/\.map-row/);
    expect(html).toMatch(/grid-template-columns:1fr/);
  });

  it("pulls the new client + model panels and the github/web state", () => {
    const html = dashboardHtml();
    expect(html).toContain("/api/clients");
    expect(html).toContain("/api/models");
    // The page must reference the github login + web-search surfaces it now renders.
    expect(html).toMatch(/github/i);
    expect(html).toMatch(/web search/i);
  });

  it("renders real lifetime totals + a per-model breakdown, not a capped 100-row dump", () => {
    // The old page derived "total" from reqs.length on a 100-capped /api/requests fetch, so it stuck at
    // "total 100" and the flat recent-requests list was 30 identical 200s. Totals + per-model now come
    // from /api/metrics (real COUNT(*)/SUM), so the page renders all.byModel and the all-time/24h split.
    const html = dashboardHtml();
    expect(html).toContain("renderMetrics");
    expect(html).toContain("byModel");
    expect(html).toMatch(/all-time/);
    expect(html).toMatch(/last 24h/);
    // The old flat "Recent requests" dump is gone (replaced by the By-model breakdown).
    expect(html).not.toMatch(/Recent requests/);
  });

  it("orders the By model section above Recent errors", () => {
    const html = dashboardHtml();
    expect(html.indexOf("By model")).toBeGreaterThan(-1);
    expect(html.indexOf("Recent errors")).toBeGreaterThan(-1);
    // By model is the at-a-glance summary; the (potentially long, expandable) error list sits below it.
    expect(html.indexOf("By model")).toBeLessThan(html.indexOf("Recent errors"));
  });

  it("renders errors as expandable <details> rows whose open state survives the 2s poll", () => {
    // A long upstream body (a 502 HTML page) shouldn't flood the row — each error is a collapsed
    // <details> with a one-line summary, click to expand the full <pre>. Because tick() rebuilds the
    // table innerHTML every 2s, the open rows are tracked in openErrors (keyed by ts) and re-applied.
    const html = dashboardHtml();
    expect(html).toContain("details.errrow");          // the expandable row style
    expect(html).toContain('class="full"');            // the full-message <pre>
    expect(html).toContain("openErrors");              // open-state set, preserved across re-render
    expect(html).toContain("ontoggle");                // summary toggles the tracked state
  });

  it("counts a runaway-tagged 200 (error set) as an error via /api/metrics, matching the TUI", async () => {
    // The old dashboard derived errors client-side and counted only status>=400, so a runaway 200 (cut
    // stream, error tagged) silently vanished from the dashboard while /logs + /metrics flagged it. The
    // dashboard now renders /api/metrics, where the shared rule (status >= 400 OR error IS NOT NULL) is
    // enforced in SQL — so a 200-with-error is counted. Assert the real data source, not an HTML grep.
    const db = openDb(":memory:");
    recordRequest(db, { ts: 1, endpoint: "/v1/messages", model: "gpt-4o", status: 200, latencyMs: 9 });                               // clean 200
    recordRequest(db, { ts: 2, endpoint: "/v1/messages", model: "gpt-4o", status: 200, latencyMs: 9, error: "runaway stream cut" }); // runaway 200
    const app = createControlApp({
      db, getState: () => "ready", restart: () => {}, stop: () => {}, start: () => {},
      doctor: async () => [], github: () => undefined, ...dash, subscribe: () => () => {},
    });
    const res = await request(app).get("/api/metrics");
    expect(res.body.all.total).toBe(2);
    expect(res.body.all.errors).toBe(1);                                  // the runaway 200 counts
    expect(res.body.recentErrors.map((e: { error?: string }) => e.error)).toContain("runaway stream cut");
  });

  it("emits JavaScript that parses without a browser", () => {
    const html = dashboardHtml();
    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    expect(() => new Function(script!)).not.toThrow();
  });

  it("is served at GET / by the control app", async () => {
    const app = createControlApp({
      db: openDb(":memory:"), getState: () => "ready",
      restart: () => {}, stop: () => {}, start: () => {}, doctor: async () => [],
      github: () => undefined, clients: () => ({ claude: { user: false, project: false }, codex: { user: false, project: false } }),
      models: async () => [],
      subscribe: () => () => {},
    });
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/html/);
    expect(res.text).toMatch(/<!doctype html>/i);
  });
});

// E2E: persistence + control API, the setup->status->reset lifecycle for both clients, the error
// capture -> dashboard data path, and the TUI slash commands (/logs, /dashboard, /report, /reset).
// Case catalog: cases.md. Shared harness: helpers.ts.
import { describe, it, expect } from "vitest";
import request from "supertest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wired, ok, failing } from "./helpers.js";
import { openDb, recordRequest, recentRequests } from "../src/supervisor/db.js";
import { buildRegistry } from "../src/tui/slash/commands.js";
import { applyClaude, resetClaude, CLAUDE_ENV_KEYS } from "../src/tui/setup/apply.js";
import { claudeCopilotReverseEnv } from "../src/tui/setup/clients.js";
import { readClientStatus } from "../src/tui/setup/status.js";
import { applyCodexToml, codexTomlPath } from "../src/tui/setup/codex-toml.js";

describe("E2E: persistence & control API", () => {
  it("EP-21 a failed request's error message persists in the request_log and is queryable", async () => {
    const { worker, control } = wired(failing);
    await request(worker).post("/openai/chat/completions").send({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
    const res = await request(control).get("/api/requests");
    const failed = res.body.requests.find((r: any) => r.status >= 400);
    expect(failed.error).toMatch(/context_length_exceeded/);
  });

  it("EP-22 control API exposes status, doctor, and requests endpoints", async () => {
    const { control } = wired(ok);
    expect((await request(control).get("/api/status")).body.workerState).toBe("ready");
    expect((await request(control).get("/api/doctor")).body.checks[0].name).toBe("worker");
    expect(Array.isArray((await request(control).get("/api/requests")).body.requests)).toBe(true);
  });

  it("EP-23 db migration: a freshly opened db round-trips a recorded request", async () => {
    const db = openDb(":memory:");
    recordRequest(db, { ts: 1, endpoint: "/v1/messages", model: "m", status: 200, latencyMs: 5 });
    expect(recentRequests(db, 1)[0].status).toBe(200);
  });
});

describe("E2E: setup lifecycle (Claude + Codex)", () => {
  it("EP-24 setup writes Claude config the HUD status then reports as configured (user scope)", async () => {
    const home = mkdtempSync(join(tmpdir(), "e2e-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "e2e-cwd-"));
    applyClaude("global", claudeCopilotReverseEnv("http://127.0.0.1:7891", "k", "claude-opus-4.8", 1_000_000), { home, cwd });
    const status = readClientStatus({ home, cwd });
    expect(status.claude.user).toBe(true);
    expect(status.claude.project).toBe(false);
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    // Dashed canonical id (not Copilot's dotted claude-opus-4.8[1m]) so Claude Code's picker matches it.
    expect(settings.env.ANTHROPIC_MODEL).toBe("claude-opus-4-8[1m]");
    expect(settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("1000000");
    // Friendly name + family alias, so a model Claude Code's built-in table lacks still renders as
    // "Opus 4.8 (1M context)" in the picker/status line instead of the raw id.
    expect(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("claude-opus-4-8[1m]");
    expect(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME).toBe("Opus 4.8 (1M context)");
    // Discovery must survive: the traffic switch that silently disables it is stripped, not written.
    expect(settings.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).toBe("1");
    expect(settings.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBeUndefined();
  });

  it("EP-24b re-running setup heals an install still carrying the discovery-killing traffic flag", () => {
    const cwd = mkdtempSync(join(tmpdir(), "e2e-heal-"));
    // an older setup left the flag behind
    applyClaude("project", { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" }, { cwd });
    applyClaude("project", claudeCopilotReverseEnv("http://127.0.0.1:7891", "k", "claude-opus-5", 1_000_000), { cwd });
    const settings = JSON.parse(readFileSync(join(cwd, ".claude", "settings.json"), "utf8"));
    expect(settings.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBeUndefined();
    expect(settings.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).toBe("1");
    expect(settings.env.ANTHROPIC_MODEL).toBe("claude-opus-5[1m]");
  });

  it("EP-25 setup-codex writes a native config.toml with the model context window", () => {    const home = mkdtempSync(join(tmpdir(), "e2e-codex-"));
    applyCodexToml({ home, baseUrl: "http://127.0.0.1:7891/v1", model: "gpt-5.5", contextWindow: 1_050_000 });
    const toml = readFileSync(codexTomlPath(home), "utf8");
    expect(toml).toContain('model = "gpt-5.5"');
    expect(toml).toContain("model_context_window = 1050000");
    expect(toml).toContain("[model_providers.copilot-reverse]");
  });

  it("EP-26 reset removes every key setup wrote, including the 1M-window keys", () => {
    const cwd = mkdtempSync(join(tmpdir(), "e2e-reset2-"));
    applyClaude("project", claudeCopilotReverseEnv("http://127.0.0.1:7891", "k", "claude-opus-4.8", 1_000_000), { cwd });
    resetClaude("project", CLAUDE_ENV_KEYS, { cwd });
    const settings = JSON.parse(readFileSync(join(cwd, ".claude", "settings.json"), "utf8"));
    expect(settings.env?.ANTHROPIC_MODEL).toBeUndefined();
    expect(settings.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
    // the custom-model trio must go too, or a stale alias outlives the reset
    expect(settings.env?.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
    expect(settings.env?.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME).toBeUndefined();
    expect(settings.env?.ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION).toBeUndefined();
  });
});

describe("E2E: error capture & dashboard", () => {
  it("EP-05 a failed stream surfaces an error frame AND lands in the control API + dashboard data", async () => {
    const { worker, control } = wired(failing);
    const res = await request(worker).post("/anthropic/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 50, stream: true, messages: [{ role: "user", content: "hi" }] });
    expect(res.text).toContain("event: error");
    expect(res.text).toContain("context_length_exceeded");
    // the supervisor recorded the failure with its message
    const reqs = await request(control).get("/api/requests");
    const failed = reqs.body.requests.find((r: any) => r.status >= 400);
    expect(failed).toBeDefined();
    expect(failed.error).toMatch(/context_length_exceeded/);
  });

  it("EP-06 the supervisor serves the dashboard HTML at /", async () => {
    const { control } = wired(ok);
    const res = await request(control).get("/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/html/);
    expect(res.text).toMatch(/<!doctype html>/i);
  });
});

describe("E2E: TUI commands", () => {
  const ctx = () => {
    const err = { ts: 1, endpoint: "/v1/messages", model: "claude-opus-4-8", status: 502, latencyMs: 4, error: "context_length_exceeded" };
    const win = { total: 1, errors: 1, tokensIn: 0, tokensOut: 0, byModel: [{ model: "claude-opus-4-8", count: 1, errors: 1, avgMs: 4, tokensIn: 0, tokensOut: 0 }] };
    return {
      client: {
        status: async () => ({ workerState: "ready" as const, restarts: [] }),
        restart: async () => {}, stop: async () => {}, start: async () => {},
        doctor: async () => [{ name: "worker", ok: true, detail: "ready" }],
        requests: async () => [err],
        metrics: async () => ({ all: win, day: win, recentErrors: [err] }),
      },
      quit: () => {},
    };
  };
  const endpoint = { host: "127.0.0.1", port: 7891, apiKey: "k" };

  it("EP-07 /logs surfaces recent request errors with their messages", async () => {
    const out = await buildRegistry(ctx() as any, endpoint).run("/logs");
    expect(out.join("\n")).toMatch(/context_length_exceeded/);
  });

  it("EP-08 /dashboard and /report open URLs in the browser", async () => {
    const opened: string[] = [];
    const reg = buildRegistry(ctx() as any, endpoint, { dashboardUrl: "http://127.0.0.1:7890/", reportRepo: "octo/copilot-reverse", appVersion: "0.0.1", openUrl: (u) => opened.push(u) });
    await reg.run("/dashboard");
    await reg.run("/report");
    expect(opened[0]).toBe("http://127.0.0.1:7890/");
    expect(opened[1]).toMatch(/^https:\/\/github\.com\/octo\/copilot-reverse\/issues\/new\?/);
  });

  it("EP-09 /reset removes the keys that setup wrote (round-trip)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "e2e-reset-"));
    applyClaude("project", { ANTHROPIC_BASE_URL: "http://x", ANTHROPIC_API_KEY: "k", ANTHROPIC_MODEL: "gpt-4o" }, { cwd });
    const reg = buildRegistry(ctx() as any, endpoint, { resetClient: async () => resetClaude("project", CLAUDE_ENV_KEYS, { cwd }).changed });
    const out = await reg.run("/reset-claude");
    expect(out.join("\n")).toMatch(/ANTHROPIC_BASE_URL/);
    const settings = JSON.parse(readFileSync(join(cwd, ".claude", "settings.json"), "utf8"));
    expect(settings.env?.ANTHROPIC_BASE_URL).toBeUndefined();
  });
});

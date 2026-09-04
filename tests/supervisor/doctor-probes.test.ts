import { describe, it, expect, vi } from "vitest";
import { distinctConfiguredModels, pingViaProxy } from "../../src/supervisor/doctor-probes.js";
import type { ClientStatus } from "../../src/tui/setup/status.js";

const cs = (over: Partial<ClientStatus> = {}): ClientStatus => ({
  claude: { user: false, project: false },
  codex: { user: false, project: false },
  ...over,
});

describe("distinctConfiguredModels", () => {
  it("collects the models the clients are configured with, de-duplicated", () => {
    const status = cs({
      claude: { user: true, project: true, userModel: "claude-opus-4-8[1m]", projectModel: "claude-opus-4-8[1m]" },
      codex: { user: true, project: false, userModel: "gpt-5.5" },
    });
    expect(distinctConfiguredModels(status).sort()).toEqual(["claude-opus-4-8[1m]", "gpt-5.5"]);
  });

  it("ignores scopes copilot-reverse didn't configure, and scopes with no model", () => {
    const status = cs({ claude: { user: true, project: false, userModel: "claude-opus-4-8" }, codex: { user: false, project: false } });
    expect(distinctConfiguredModels(status)).toEqual(["claude-opus-4-8"]);
  });

  it("returns nothing when no client is configured", () => {
    expect(distinctConfiguredModels(cs())).toEqual([]);
  });
});

describe("pingViaProxy", () => {
  it("POSTs a minimal 1-token message and reports ok + latency on 200", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const r = await pingViaProxy("http://127.0.0.1:7991", "claude-opus-4-8[1m]", fetchFn as unknown as typeof fetch);
    expect(r.ok).toBe(true);
    expect(typeof r.latencyMs).toBe("number");
    const [url, init] = fetchFn.mock.calls[0];
    expect(String(url)).toBe("http://127.0.0.1:7991/anthropic/v1/messages");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe("claude-opus-4-8[1m]");
    expect(body.max_tokens).toBe(1);
  });

  it("reports not-ok with the status + body when the proxy returns an error", async () => {
    const fetchFn = vi.fn(async () => new Response("upstream 502\n<html>boom</html>", { status: 502 }));
    const r = await pingViaProxy("http://127.0.0.1:7991", "gpt-4o", fetchFn as unknown as typeof fetch);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/502/);
    expect(r.error).not.toMatch(/\n/); // flattened — feeds a DoctorCheck.detail rendered in a card
  });

  it("reports not-ok when the request throws (worker down)", async () => {
    const fetchFn = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    const r = await pingViaProxy("http://127.0.0.1:7991", "gpt-4o", fetchFn as unknown as typeof fetch);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ECONNREFUSED/);
  });

  it("times out a hung worker instead of blocking forever", async () => {
    // A worker that never responds: the fetch only settles when its signal aborts. With a tiny timeout
    // the probe must come back not-ok with a timeout message — proving it fails fast.
    const fetchFn = (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
    const r = await pingViaProxy("http://127.0.0.1:7991", "gpt-4o", fetchFn as unknown as typeof fetch, 20);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/timed out/i);
  });
});

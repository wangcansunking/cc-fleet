// Deep TUI interaction tests — render the real Ink <App>, drive it via stdin, and assert on the
// rendered frames. These cover user-facing flows the basic app.test.tsx doesn't: esc-to-interrupt,
// error rendering, HUD per-scope badges (read from a status fn), reset flipping the badge, the
// model picker, multi-turn streaming, and Repl autocomplete navigation.
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { App } from "../../src/tui/app.js";
import { Registry } from "../../src/tui/slash/registry.js";
import type { ClientStatus } from "../../src/tui/setup/status.js";

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
function reg(extra?: (r: Registry) => void) {
  const r = new Registry({ client: {} as any, quit: vi.fn() });
  r.add({ name: "/ping", describe: "ping", run: async () => ["pong"] });
  extra?.(r);
  return r;
}
const STATUS = (over: Partial<ClientStatus> = {}): ClientStatus => ({
  claude: { user: false, project: false }, codex: { user: false, project: false }, ...over,
});

describe("TUI: HUD client badges (from the real status fn)", () => {
  it("renders per-scope user/project markers for claude and codex", () => {
    const readStatus = () => STATUS({ claude: { user: true, project: false }, codex: { user: false, project: true } });
    const { lastFrame } = render(<App registry={reg()} title="m" readStatus={readStatus} />);
    const f = lastFrame() ?? "";
    expect(f).toMatch(/claude u:✓ p:○/);
    expect(f).toMatch(/codex u:○ p:✓/);
  });
});

describe("TUI: assistant errors are rendered (not swallowed)", () => {
  it("shows an error line when onChat prints an error", async () => {
    const onChat = async (_t: string, print: (l: string) => void) => { print("assistant error: boom"); };
    const { stdin, lastFrame } = render(<App registry={reg()} title="m" onChat={onChat} />);
    await tick();
    stdin.write("hi there");
    await tick();
    stdin.write("\r");
    await tick(80);
    expect(lastFrame()).toContain("assistant error: boom");
  });
});

describe("TUI: esc interrupts an in-flight turn", () => {
  it("aborts the turn and the abort signal fires", async () => {
    let aborted = false;
    const onChat = (_t: string, _p: (l: string) => void, _m?: string, abort?: AbortController) =>
      new Promise<void>((resolve) => {
        abort?.signal.addEventListener("abort", () => { aborted = true; resolve(); });
      });
    const { stdin } = render(<App registry={reg()} title="m" onChat={onChat} />);
    await tick();
    stdin.write("do something long");
    await tick();
    stdin.write("\r");          // start the turn
    await tick();
    stdin.write("\x1b");        // ESC
    await tick(80);
    expect(aborted).toBe(true);
  });
});

describe("TUI: multi-turn streaming keeps answers distinct", () => {
  it("each turn lands in its own bubble", async () => {
    let n = 0;
    const onChat = async (_t: string, print: (l: string) => void) => { n++; print(`answer-${n}`); };
    const { stdin, lastFrame } = render(<App registry={reg()} title="m" onChat={onChat} />);
    await tick();
    stdin.write("q1"); await tick(); stdin.write("\r"); await tick(80);
    stdin.write("q2"); await tick(); stdin.write("\r"); await tick(80);
    const f = lastFrame() ?? "";
    expect(f).toContain("answer-1");
    expect(f).toContain("answer-2");
  });
});

describe("TUI: Repl autocomplete navigation", () => {
  it("down-arrow moves the highlight so Enter runs the second match", async () => {
    const r = new Registry({ client: {} as any, quit: vi.fn() });
    r.add({ name: "/setup-claude", describe: "a", run: async () => ["ran-claude"] });
    r.add({ name: "/setup-codex", describe: "b", run: async () => ["ran-codex"] });
    const { stdin, lastFrame } = render(<App registry={r} title="m" />);
    await tick();
    stdin.write("/setup");        // popup shows both, highlights the first
    await tick();
    stdin.write("\x1b[B");        // Down arrow -> highlight /setup-codex
    await tick();
    stdin.write("\r");
    await tick(80);
    const f = lastFrame() ?? "";
    expect(f).toContain("ran-codex");
    expect(f).not.toContain("ran-claude");
  });

  it("tab completes the highlighted command without running it", async () => {
    const r = new Registry({ client: {} as any, quit: vi.fn() });
    r.add({ name: "/doctor", describe: "d", run: async () => ["health-ok"] });
    const { stdin, lastFrame } = render(<App registry={r} title="m" />);
    await tick();
    stdin.write("/doc");
    await tick();
    stdin.write("\t");           // Tab -> completes to "/doctor " but does not run
    await tick(60);
    expect(lastFrame()).not.toContain("health-ok");
  });
});

describe("TUI: /metrics styled card", () => {
  it("renders all-time + 24h summary stats and a per-model row from metricsSource", async () => {
    const win = {
      total: 2, errors: 0, tokensIn: 21000, tokensOut: 8400,
      byModel: [
        { model: "claude-opus-4-8", count: 1, errors: 0, avgMs: 820, tokensIn: 20000, tokensOut: 8000 },
        { model: "gpt-4o", count: 1, errors: 0, avgMs: 210, tokensIn: 1000, tokensOut: 400 },
      ],
    };
    const metricsSource = async () => ({ all: win, day: win, recentErrors: [] });
    const { stdin, lastFrame } = render(<App registry={reg()} title="m" metricsSource={metricsSource as any} />);
    await tick();
    stdin.write("/metrics");
    await tick();
    stdin.write("\r");
    await tick(80);
    const f = lastFrame() ?? "";
    expect(f).toContain("metrics");
    expect(f).toMatch(/all-time/);
    expect(f).toMatch(/last 24h/);
    expect(f).toMatch(/2 reqs/);
    expect(f).toMatch(/opus-4-8/);
    expect(f).toMatch(/est/);
  });
});

describe("TUI: /login surfaces the device code before the poll resolves", () => {
  it("renders the verification URL + code immediately, not buffered behind the token poll", async () => {
    // Reproduces the deadlock: the old /login buffered its device-code line and only returned
    // (and thus rendered) after pollForToken resolved — but the user can't authorize a code they
    // can't see. The login prop must push the code to the UI, then resolve when authorized.
    let releaseToken!: () => void;
    const tokenGate = new Promise<void>((r) => { releaseToken = r; });
    const login = (show: (lines: string[]) => void) => {
      show(["Open https://github.com/login/device and enter code: AB-12"]);
      return tokenGate.then(() => ["GitHub authorization complete."]);
    };
    const { stdin, lastFrame } = render(<App registry={reg()} title="m" login={login} />);
    await tick();
    stdin.write("/login");
    await tick();
    stdin.write("\r");
    await tick(80);
    // The code is on screen WHILE the token poll is still pending (gate not released).
    expect(lastFrame()).toContain("AB-12");
    expect(lastFrame()).toContain("github.com/login/device");

    releaseToken();
    await tick(80);
    expect(lastFrame()).toContain("GitHub authorization complete.");
  });

  it("renders an error card (not a crash) when authorization fails", async () => {
    // A rejected poll (e.g. expired/incorrect device code) must surface as an error card. The old
    // path let the rejection escape as an unhandled rejection and killed the whole process.
    const login = (show: (lines: string[]) => void) => {
      show(["Open https://github.com/login/device and enter code: AB-12"]);
      return Promise.reject(new Error("authorization failed: incorrect_device_code"));
    };
    const { stdin, lastFrame } = render(<App registry={reg()} title="m" login={login} />);
    await tick();
    stdin.write("/login");
    await tick();
    stdin.write("\r");
    await tick(80);
    const f = lastFrame() ?? "";
    expect(f).toContain("login failed");
    expect(f).toContain("incorrect_device_code");
    // The raw "Error:" prefix should be stripped — show a clean message.
    expect(f).not.toContain("Error:");
  });

  it("ignores a second /login while one is already in flight", async () => {
    // The user can hit Enter on /login twice; without a guard that starts two device-code flows,
    // and polling a superseded code fails with incorrect_device_code. Only one flow should start.
    let starts = 0;
    const gate = new Promise<string[]>(() => {}); // never resolves — login stays pending
    const login = (show: (lines: string[]) => void) => { starts++; show([`code ${starts}`]); return gate; };
    const { stdin } = render(<App registry={reg()} title="m" login={login} />);
    await tick();
    stdin.write("/login"); await tick(); stdin.write("\r"); await tick(60);
    stdin.write("/login"); await tick(); stdin.write("\r"); await tick(60);
    expect(starts).toBe(1);
  });
});

describe("TUI: /webiq key entry", () => {
  it("opens a masked key screen and enables WebIQ with the typed key", async () => {
    const saved: string[] = [];
    const enableWebiq = (k: string) => { saved.push(k); };
    // backend resolver reflects the key once enabled (simulates resolveWebSearchBackend)
    let key: string | null = null;
    const webSearchBackend = () => (key ? "webiq" as const : "unavailable" as const);
    const { stdin, lastFrame } = render(<App registry={reg()} title="m" enableWebiq={(k) => { enableWebiq(k); key = k; }} webSearchBackend={webSearchBackend} />);
    await tick();
    stdin.write("/webiq");
    await tick();
    stdin.write("\r");          // run the command -> opens the screen
    await tick(60);
    expect(lastFrame()).toMatch(/WebIQ API key/i);
    // type a key (should render masked, not echoed)
    stdin.write("secret-key-123");
    await tick();
    expect(lastFrame()).not.toContain("secret-key-123");
    expect(lastFrame()).toMatch(/•/);
    stdin.write("\r");          // submit
    await tick(60);
    expect(saved).toEqual(["secret-key-123"]);
    expect(lastFrame()).toMatch(/web .*✓ webiq/); // HUD reflects the webiq backend
  });

  it("/webiq clean clears the key", async () => {
    let cleaned = false;
    let key: string | null = "k";
    const webSearchBackend = () => (key ? "webiq" as const : "unavailable" as const);
    const { stdin, lastFrame } = render(<App registry={reg()} title="m" enableWebiq={() => {}} disableWebiq={() => { cleaned = true; key = null; }} webSearchBackend={webSearchBackend} />);
    await tick();
    stdin.write("/webiq clean");
    await tick();
    stdin.write("\r");
    await tick(60);
    expect(cleaned).toBe(true);
    expect(lastFrame()).toMatch(/cleared/i);
    expect(lastFrame()).toMatch(/web .*✗ \/webiq/); // no key left → unavailable
  });
});

describe("TUI: /status command shows the live status card", () => {
  it("renders the GitHub/web/worker overview when /status is run", async () => {
    const { stdin, lastFrame } = render(
      <App registry={reg()} title="m"
        githubStatus={async () => "connected"}
        webSearchBackend={() => "webiq"} />,
    );
    await tick();
    stdin.write("/status");
    await tick();
    stdin.write("\r");
    await tick(80);
    const f = lastFrame() ?? "";
    expect(f).toMatch(/GitHub login.*connected/);
    expect(f).toMatch(/web search.*via WebIQ/);
  });

  it("shows web search unavailable in the card when no backend is usable", async () => {
    const { stdin, lastFrame } = render(
      <App registry={reg()} title="m"
        githubStatus={async () => "connected"}
        webSearchBackend={() => "unavailable"} />,
    );
    await tick();
    stdin.write("/status");
    await tick();
    stdin.write("\r");
    await tick(80);
    expect(lastFrame()).toMatch(/web search.*unavailable.*\/webiq/);
  });
});

describe("TUI: /setup-skill installs a bundled skill", () => {
  it("opens the picker, installs the chosen skill at the chosen scope, and shows a success card", async () => {
    const calls: Array<{ scope: string; name: string }> = [];
    const installSkill = vi.fn(async (scope: any, entry: any) => {
      calls.push({ scope, name: entry.name });
      return { path: `/home/.claude/skills/${entry.name}`, changed: ["SKILL.md"] };
    });
    const { stdin, lastFrame } = render(<App registry={reg()} title="m" installSkill={installSkill} />);
    await tick();
    stdin.write("/setup-skill");
    await tick();
    stdin.write("\r");              // run the command -> opens the picker
    await tick(60);
    expect(lastFrame() ?? "").toMatch(/install skill/);
    expect(lastFrame() ?? "").toMatch(/choose a skill/);
    stdin.write("\r");             // pick the first (only) catalog skill -> scope step
    await tick(60);
    expect(lastFrame() ?? "").toMatch(/choose scope/);
    stdin.write("\r");            // first scope = global -> install
    await tick(80);
    expect(installSkill).toHaveBeenCalledTimes(1);
    expect(calls[0].scope).toBe("global");
    expect(calls[0].name).toBe("analyze-session-create-issue");
    const f = lastFrame() ?? "";
    expect(f).toMatch(/installed/);
    expect(f).toContain("SKILL.md");
    stdin.write("x");            // dismiss the done screen -> success card
    await tick(60);
    const done = lastFrame() ?? "";
    expect(done).toMatch(/install skill/);
    expect(done).toContain("/home/.claude/skills/analyze-session-create-issue");
  });
});

describe("TUI: startup status card", () => {
  it("renders the GitHub/web-search/worker overview on startup", () => {
    const startupStatus = { github: "connected" as const, webSearch: "webiq" as const, worker: "ready" as const, clients: { claude: true, codex: false } };
    const { lastFrame } = render(<App registry={reg()} title="m" startupStatus={startupStatus} />);
    const f = lastFrame() ?? "";
    expect(f).toMatch(/status/);
    expect(f).toMatch(/GitHub login.*connected/);
    expect(f).toMatch(/web search.*via WebIQ/);
    expect(f).toMatch(/worker.*ready/);
  });
  it("folds the username + Copilot plan into the GitHub line when present", () => {
    const startupStatus = { github: "connected" as const, webSearch: "webiq" as const, worker: "ready" as const,
      clients: { claude: true, codex: false }, identity: "Can Wang (canwa_microsoft)", plan: "Copilot Enterprise" };
    const { lastFrame } = render(<App registry={reg()} title="m" startupStatus={startupStatus} />);
    const f = lastFrame() ?? "";
    expect(f).toMatch(/GitHub login.*connected.*canwa_microsoft.*Copilot Enterprise/);
  });
});

describe("TUI: /status folds in identity + plan from accountInfo", () => {
  it("shows the fresh username + plan on the live status card", async () => {
    const accountInfo = vi.fn(async () => ({ identity: "Can Wang (canwa_microsoft)", plan: "Copilot Enterprise" }));
    const { stdin, lastFrame } = render(
      <App registry={reg()} title="m" githubStatus={async () => "connected"} webSearchBackend={() => "copilot"} accountInfo={accountInfo} />,
    );
    await tick();
    stdin.write("/status");
    await tick();
    stdin.write("\r");
    await tick(80);
    expect(accountInfo).toHaveBeenCalled();
    expect(lastFrame() ?? "").toMatch(/GitHub login.*connected.*canwa_microsoft.*Copilot Enterprise/);
  });
});

describe("TUI: HUD web search indicator", () => {
  it("shows the webiq backend when WebIQ is enabled", () => {
    const { lastFrame } = render(<App registry={reg()} title="m" webSearchBackend={() => "webiq"} />);
    const f = lastFrame() ?? "";
    expect(f).toMatch(/web .*✓ webiq/);
    expect(f).not.toContain("/web-search-support");
  });
  it("shows unavailable with the /webiq hint when no backend is usable", () => {
    const { lastFrame } = render(<App registry={reg()} title="m" webSearchBackend={() => "unavailable"} />);
    const f = lastFrame() ?? "";
    expect(f).toMatch(/web .*✗ \/webiq/);
  });
});

describe("TUI: model picker", () => {
  it("/model opens the picker and lists models with context windows", async () => {
    const loadModels = async () => ["gpt-4o", "claude-opus-4.8"];
    const modelLimits = { "gpt-4o": 128000, "claude-opus-4.8": 1_000_000 };
    const { stdin, lastFrame } = render(<App registry={reg()} title="m" loadModels={loadModels} modelLimits={modelLimits} />);
    await tick();
    stdin.write("/model");
    await tick();
    stdin.write("\r");
    await tick(80);
    const f = lastFrame() ?? "";
    expect(f).toContain("select chat model");
    expect(f).toMatch(/1M|128K/);
  });

  it("shows mapping arrows but submits the native Claude id", async () => {
    const selected: string[] = [];
    const loadModels = async () => ["gpt-5.6-sol", "claude-opus-5"];
    const { stdin, lastFrame } = render(<App registry={reg()} title="m" loadModels={loadModels}
      modelLimits={{ "gpt-5.6-sol": 1_100_000, "claude-opus-5": 1_100_000 }}
      modelLabels={{ "claude-opus-5": "claude-opus-5 → gpt-5.6-sol" }} onModelChange={(m) => selected.push(m)} />);
    await tick(); stdin.write("/model"); await tick(); stdin.write("\r"); await tick(80);
    expect(lastFrame() ?? "").toContain("claude-opus-5 → gpt-5.6-sol");
    stdin.write("\x1b[B"); await tick(); stdin.write("\r"); await tick(80);
    expect(selected).toEqual(["claude-opus-5"]);
  });
});

describe("TUI: /setup-claude mapped model picker", () => {
  it("shows Claude-to-GPT mapping labels and applies the native Claude id", async () => {
    const applied: string[] = [];
    const setup = { apply: vi.fn(async (_client: string, _scope: string, model: string) => {
      applied.push(model);
      return { path: "/tmp/settings.json", changed: ["ANTHROPIC_MODEL"] };
    }) };
    const loadModels = async () => ["gpt-5.6-sol", "claude-opus-5"];
    const { stdin, lastFrame } = render(<App registry={reg()} title="m" loadModels={loadModels} setup={setup as any}
      modelLimits={{ "gpt-5.6-sol": 1_100_000, "claude-opus-5": 1_100_000 }}
      modelLabels={{ "claude-opus-5": "claude-opus-5 → gpt-5.6-sol" }} />);
    await tick(); stdin.write("/setup-claude"); await tick(); stdin.write("\r"); await tick(80);
    const picker = lastFrame() ?? "";
    expect(picker).toContain("claude-opus-5 → gpt-5.6-sol");
    expect(picker.indexOf("claude-opus-5 → gpt-5.6-sol")).toBeLessThan(picker.indexOf("gpt-5.6-sol"));
    stdin.write("\r"); await tick(); // first item is the mapped alias -> scope
    stdin.write("\r"); await tick(80); // global -> apply
    expect(applied).toEqual(["claude-opus-5"]);
  });
});

describe("TUI: /claude-map compatibility toggle", () => {
  it("shows status and all mappings without changing state", async () => {
    const setClaudeMap = vi.fn(async () => {});
    const { stdin, lastFrame } = render(<App registry={reg()} title="m" claudeMapEnabled={() => false} setClaudeMap={setClaudeMap} />);
    await tick(); stdin.write("/claude-map"); await tick(); stdin.write("\r"); await tick(80);
    const f = lastFrame() ?? "";
    expect(f).toMatch(/claude map.*off/i);
    expect(f).toContain("claude-opus-5 → gpt-5.6-sol");
    expect(setClaudeMap).not.toHaveBeenCalled();
  });

  it("persists a state change, restarts, and prints the client refresh hint", async () => {
    const setClaudeMap = vi.fn(async () => {});
    const { stdin, lastFrame } = render(<App registry={reg()} title="m" claudeMapEnabled={() => false} setClaudeMap={setClaudeMap} />);
    await tick(); stdin.write("/claude-map on"); await tick(); stdin.write("\r"); await tick(80);
    expect(setClaudeMap).toHaveBeenCalledWith(true);
    expect(lastFrame() ?? "").toMatch(/reopen.*\/model|restart Claude/i);
  });

  it("switches an unavailable persisted Claude chat model to a live mapped alias on enable", async () => {
    const changed: string[] = [];
    const setClaudeMap = vi.fn(async () => {});
    const loadModels = async () => ["gpt-5.6-sol", "claude-opus-5"];
    const { stdin, lastFrame } = render(<App registry={reg()} title="m" initialModel="claude-opus-4.8"
      loadModels={loadModels} modelLabels={{ "claude-opus-5": "claude-opus-5 → gpt-5.6-sol" }}
      claudeMapEnabled={() => false} setClaudeMap={setClaudeMap} onModelChange={(m) => changed.push(m)} />);
    await tick(); stdin.write("/claude-map on"); await tick(); stdin.write("\r"); await tick(120);
    expect(changed).toEqual(["claude-opus-5"]);
    expect(lastFrame() ?? "").toMatch(/chat model.*claude-opus-5/i);
  });

  it("rejects invalid arguments without persisting or restarting", async () => {
    const setClaudeMap = vi.fn(async () => {});
    const { stdin, lastFrame } = render(<App registry={reg()} title="m" claudeMapEnabled={() => false} setClaudeMap={setClaudeMap} />);
    await tick(); stdin.write("/claude-map maybe"); await tick(); stdin.write("\r"); await tick(80);
    expect(setClaudeMap).not.toHaveBeenCalled();
    expect(lastFrame() ?? "").toContain("usage: /claude-map [on|off]");
  });

  it("reports a saved preference but incomplete activation when restart fails", async () => {
    const setClaudeMap = vi.fn(async () => { throw new Error("restart failed"); });
    const { stdin, lastFrame } = render(<App registry={reg()} title="m" claudeMapEnabled={() => false} setClaudeMap={setClaudeMap} />);
    await tick(); stdin.write("/claude-map on"); await tick(); stdin.write("\r"); await tick(80);
    const f = lastFrame() ?? "";
    expect(f).toMatch(/preference.*saved/i);
    expect(f).toMatch(/restart failed|\/restart/i);
    expect(f).not.toMatch(/✓.*enabled/i);
  });
});

describe("TUI: /network access mode", () => {
  const localhostInfo = { mode: "localhost" as const, key: null, lanUrl: null };
  const lanInfo = { mode: "lan" as const, key: "SECRETKEY", lanUrl: "http://192.168.1.5:7891" };

  it("HUD shows the localhost posture by default and ⚠ LAN when exposed", () => {
    const a = render(<App registry={reg()} title="m" networkInfo={() => localhostInfo} />);
    expect(a.lastFrame() ?? "").toMatch(/net .*localhost/);
    const b = render(<App registry={reg()} title="m" networkInfo={() => lanInfo} />);
    expect(b.lastFrame() ?? "").toMatch(/net .*LAN/);
  });

  it("/network opens the panel and switching to LAN reveals the key + URL and restarts the worker", async () => {
    let mode: "localhost" | "lan" = "localhost";
    const info = () => (mode === "lan" ? lanInfo : localhostInfo);
    const setAccessMode = vi.fn(async (m: "localhost" | "lan") => { mode = m; return info(); });
    const { stdin, lastFrame } = render(<App registry={reg()} title="m" networkInfo={info} setAccessMode={setAccessMode} rotateKey={async () => info()} clientModels={() => ({ claude: "claude-opus-4-8[1m]", codex: "gpt-5.5" })} />);
    await tick();
    stdin.write("/network");
    await tick();
    stdin.write("\r");            // open the panel
    await tick(60);
    expect(lastFrame() ?? "").toMatch(/network access/);
    stdin.write("\r");           // first item = "switch to LAN"
    await tick(80);
    const f = lastFrame() ?? "";
    expect(setAccessMode).toHaveBeenCalledWith("lan");
    expect(f).toMatch(/LAN mode/);
    expect(f).toContain("SECRETKEY");        // key revealed so it can be copied to other machines
    expect(f).toContain("192.168.1.5:7891"); // LAN URL shown
    expect(f).toContain("/anthropic");       // protocol path spelled out (Claude Code can't connect without it)
    expect(f).toContain("/openai");          // and for Codex
    // Paste-ready remote config blocks for both clients, with the key in the RIGHT slot.
    expect(f).toContain("~/.claude/settings.json");      // Claude block header
    expect(f).toContain("ANTHROPIC_API_KEY");            // key slot for Claude
    expect(f).toContain("~/.codex/config.toml");         // Codex block header
    expect(f).toContain("experimental_bearer_token");    // key slot for Codex
  });

  it("from LAN, the first action switches back to localhost (private)", async () => {
    let mode: "localhost" | "lan" = "lan";
    const info = () => (mode === "lan" ? lanInfo : localhostInfo);
    const setAccessMode = vi.fn(async (m: "localhost" | "lan") => { mode = m; return info(); });
    const { stdin, lastFrame } = render(<App registry={reg()} title="m" networkInfo={info} setAccessMode={setAccessMode} rotateKey={async () => info()} />);
    await tick();
    stdin.write("/network"); await tick(); stdin.write("\r"); await tick(60);
    stdin.write("\r");          // first item = "switch to localhost"
    await tick(80);
    expect(setAccessMode).toHaveBeenCalledWith("localhost");
    expect(lastFrame() ?? "").toMatch(/localhost mode/);
  });
});

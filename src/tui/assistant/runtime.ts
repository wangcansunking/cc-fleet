import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { buildActions, type AssistantActions } from "./tools.js";
import { formatModelList } from "../../shared/format.js";
import type { DaemonClient } from "../daemon-client.js";

export interface AssistantConfig {
  client: DaemonClient;
  workerBaseUrl: string;   // e.g. http://127.0.0.1:7991  (Anthropic inbound)
  apiKey: string;          // copilot-reverse server key (worker ignores/accepts in M1)
  model: string;           // e.g. claude-opus-4-8 (router remaps to a Copilot model)
  maxInputTokens?: number; // conservative default context window; drives auto-compaction
  modelLimits?: Record<string, number>; // per-model real windows; preferred over maxInputTokens
  // Optional capabilities exposed to the assistant as tools (wired in production, omitted in tests).
  listModels?: () => Promise<string[]>;
  setupClient?: (client: "claude" | "codex", scope: "global" | "project", model: string) => Promise<{ path: string; changed: string[] }>;
}

// Injectable seam for the SDK's query(); production uses the real one (default).
// Tests inject a fake to exercise on-chat -> runtime -> consumption without
// spawning the bundled Claude Code CLI subprocess or calling live Copilot.
export type QueryFn = typeof query;

const empty = z.object({});

// Setup is a config write — require both so the assistant must confirm scope+model, never assume.
const requiredSetupShape = z.object({
  scope: z.enum(["global", "project"]),
  model: z.string(),
}).shape;

function sdkTools(actions: AssistantActions, cfg: AssistantConfig) {
  const tools = [
    tool("get_status", "Get the proxy worker status and restart history", empty.shape, async () => ({ content: [{ type: "text", text: await actions.get_status({}) }] })),
    tool("restart_worker", "Restart the proxy worker", empty.shape, async () => ({ content: [{ type: "text", text: await actions.restart_worker({}) }] })),
    tool("run_doctor", "Run copilot-reverse health checks", empty.shape, async () => ({ content: [{ type: "text", text: await actions.run_doctor({}) }] })),
    tool("recent_requests", "List recent proxied requests", empty.shape, async () => ({ content: [{ type: "text", text: await actions.recent_requests({}) }] })),
    tool("recent_errors", "List recent failed/cut requests with their messages (incl. stream runaways)", empty.shape, async () => ({ content: [{ type: "text", text: await actions.recent_errors({}) }] })),
    tool("metrics", "Show request totals, error count, and per-model average latency", empty.shape, async () => ({ content: [{ type: "text", text: await actions.metrics({}) }] })),
  ];

  const listModels = cfg.listModels;
  if (listModels) {
    tools.push(tool("list_models", "List the Copilot models available through the proxy, with their context windows", empty.shape, async () => ({
      content: [{ type: "text", text: formatModelList(await listModels(), cfg.modelLimits) }],
    })));
  }

  const setupClient = cfg.setupClient;
  if (setupClient) {
    for (const client of ["claude", "codex"] as const) {
      const label = client === "claude" ? "Claude Code" : "Codex";
      // scope+model are REQUIRED (not defaulted): config writes are not reversible-by-undo, so the
      // assistant must confirm both with the user first rather than silently writing the global scope
      // with the current model. The prompt tells it to ask; making the args required enforces it.
      tools.push(tool(`setup_${client}`, `Configure ${label} to use the proxy. REQUIRES scope ("global"=all projects / "project"=here) AND model — ask the user for both before calling; do not assume.`, requiredSetupShape, async (args: { scope: "global" | "project"; model: string }) => {
        const r = await setupClient(client, args.scope, args.model);
        return { content: [{ type: "text", text: `configured ${label} (${args.scope}) with model ${args.model} — wrote ${r.path}; keys: ${r.changed.join(", ") || "(no change)"}` }] };
      }) as unknown as (typeof tools)[number]);
    }
  }

  return tools;
}

// Runs one assistant turn, streaming assistant text to `print`. Pass an AbortController to make
// the turn interruptible (esc) — aborting ends the stream.
export async function runAssistantTurn(cfg: AssistantConfig, prompt: string, print: (line: string) => void, queryFn: QueryFn = query, abortController?: AbortController): Promise<void> {
  // Dogfood: route the agent SDK through copilot-reverse's own Anthropic endpoint -> Copilot.
  process.env.ANTHROPIC_BASE_URL = cfg.workerBaseUrl;
  process.env.ANTHROPIC_API_KEY = cfg.apiKey;

  // The bundled Claude Code engine assumes a ~200K window and only auto-compacts near it,
  // but the routed Copilot model's real window is often far smaller -> a single turn can
  // overflow and the upstream rejects with context_length_exceeded. Mirror agent-maestro:
  // size auto-compaction to the model's real window, compact early, and drop the billing
  // attribution header that breaks prompt caching on a non-Anthropic gateway.
  const contextWindow = cfg.modelLimits?.[cfg.model] ?? cfg.maxInputTokens;
  if (contextWindow) process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(contextWindow);
  // 80% keeps the compaction trigger under the model's input budget even when the window above is
  // the full context window (e.g. 1M ctx vs ~936K prompt budget on the 1M Claude models).
  process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE ?? "80";
  process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = "0";

  const actions = buildActions(cfg.client);
  const mcp = createSdkMcpServer({ name: "copilotReverse", tools: sdkTools(actions, cfg) });

  const response = queryFn({
    prompt,
    options: {
      model: cfg.model,
      mcpServers: { copilotReverse: mcp },
      // Keep the request small so a single turn never overflows a modest Copilot window:
      //  - tools: [] -> disable ALL built-in Claude Code tools (Bash/Task/Read/Edit/…), whose huge
      //    descriptions otherwise bloat every request and overflow the model -> Copilot 400. The
      //    copilot-reverse MCP tools (via mcpServers) remain available. (`allowedTools` only gates
      //    permission; `tools` is what actually removes them from the request.)
      //  - settingSources: [] -> do NOT load the cwd's CLAUDE.md / project memory / settings.
      tools: [],
      settingSources: [],
      systemPrompt:
        "You are copilot-reverse's built-in assistant for the local Copilot proxy. Be concise. " +
        "When the user expresses an intent you have a tool for, CALL THE TOOL instead of explaining. " +
        "Tools: get_status, restart_worker, run_doctor, recent_requests, recent_errors, metrics, list_models " +
        "(models + context windows), setup_claude / setup_codex (configure those clients). " +
        "SETUP RULE: setup_claude/setup_codex WRITE config and need scope (global=all projects / project=here) " +
        "AND model. Before calling, confirm BOTH with the user — if unstated, ask (offer list_models). Never assume. " +
        "E.g. 'list models' -> list_models; 'set up claude' -> ask scope+model, then setup_claude.",
      permissionMode: "bypassPermissions",
      includePartialMessages: true,
      ...(abortController ? { abortController } : {}),
    },
  });

  // Stream token-by-token from partial-message events for a live, SSE-like feel. Once any
  // delta has streamed, skip the final complete text block so the answer isn't printed twice.
  // If partial events never arrive (e.g. a stubbed transport), fall back to the full block.
  let streamed = false;
  for await (const message of response) {
    if (message.type === "stream_event") {
      const ev = message.event;
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
        streamed = true;
        print(ev.delta.text);
      }
    } else if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text" && !streamed) print(block.text);
      }
    } else if (message.type === "result" && message.subtype !== "success") {
      // Don't swallow a failed turn: surface the SDK's terminal error subtype.
      print(`assistant error: ${message.subtype}`);
    }
  }
}

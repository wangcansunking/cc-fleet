import { claudeCopilotReverseEnv } from "./clients.js";
import { PROVIDER_ID } from "./codex-toml.js";

// Paste-ready REMOTE client config blocks for LAN mode. When the user exposes the proxy on the LAN,
// other machines need their Claude/Codex config pointed at this host's LAN URL AND must carry the
// access key — in the RIGHT slot (Claude: ANTHROPIC_API_KEY; Codex: experimental_bearer_token). These
// builders produce exactly what local `/setup` writes (via claudeCopilotReverseEnv / the codex-toml
// shape), only with the LAN host + real key swapped in for loopback + the "copilot-reverse-local"
// placeholder — so a user can copy a block verbatim into a remote machine's config file.
//
// Pure + IO-free: the caller (the /network LAN card) passes the live lanUrl + key + each client's
// pinned model; everything here is string assembly, so it's fully unit-tested.

// Defaults when this machine hasn't pinned a model for a client yet — the same friendly ids the
// pickers show. claude-opus-4-8[1m] is canonicalized through claudeCopilotReverseEnv anyway.
const DEFAULT_CLAUDE_MODEL = "claude-opus-4-8[1m]";
const DEFAULT_CODEX_MODEL = "gpt-5.5";

export interface RemoteConfigInput {
  lanUrl: string;        // e.g. http://172.22.80.1:7991 — the address other machines reach (NetworkInfo.lanUrl)
  key: string;           // the access key the gate requires off-box (NetworkInfo.key — non-null in LAN)
  claudeModel?: string;  // this machine's pinned Claude model, if any (readClientStatus)
  codexModel?: string;   // this machine's pinned Codex model, if any
  // The selected models' real context windows, when known (from the live model limits). Threaded
  // through so the remote config sizes context exactly like local setup does — Claude gets
  // CLAUDE_CODE_AUTO_COMPACT_WINDOW, Codex gets model_context_window — instead of the remote client
  // assuming a default ~200K window for a 1M model. Undefined (limits not loaded yet) → field omitted,
  // same as a local setup run before the limits resolve.
  claudeContextWindow?: number;
  codexContextWindow?: number;
}
export interface RemoteConfigBlock { client: "claude" | "codex"; path: string; lines: string[] }

// Claude → ~/.claude/settings.json `env`. Reuse claudeCopilotReverseEnv so the env set (the
// ANTHROPIC_MODEL [1m] canonicalization, auto-compact window, gateway model discovery, attribution
// flags) matches local setup — only the base URL + key differ. Rendered as the JSON the user pastes
// under settings.json.
export function remoteClaudeBlock(input: RemoteConfigInput): RemoteConfigBlock {
  const base = `${input.lanUrl}/anthropic`;
  const env = claudeCopilotReverseEnv(base, input.key, input.claudeModel ?? DEFAULT_CLAUDE_MODEL, input.claudeContextWindow);
  const json = JSON.stringify({ env }, null, 2);
  return { client: "claude", path: "~/.claude/settings.json", lines: json.split("\n") };
}

// Codex → ~/.codex/config.toml provider block. Mirrors applyCodexToml's emitted shape (the native
// config the standalone Codex CLI reads): top-level model/provider keys (plus model_context_window
// when the window is known), then the provider table with the LAN base URL and the key inlined as
// experimental_bearer_token (Codex sends it as a Bearer).
export function remoteCodexBlock(input: RemoteConfigInput): RemoteConfigBlock {
  const base = `${input.lanUrl}/openai`;
  const model = input.codexModel ?? DEFAULT_CODEX_MODEL;
  const lines = [
    `model = "${model}"`,
    `model_provider = "${PROVIDER_ID}"`,
    ...(input.codexContextWindow ? [`model_context_window = ${input.codexContextWindow}`] : []),
    "",
    `[model_providers.${PROVIDER_ID}]`,
    `name = "copilot-reverse"`,
    `base_url = "${base}"`,
    `wire_api = "responses"`,
    `requires_openai_auth = false`,
    `experimental_bearer_token = "${input.key}"`,
  ];
  return { client: "codex", path: "~/.codex/config.toml", lines };
}

export function remoteConfigBlocks(input: RemoteConfigInput): RemoteConfigBlock[] {
  return [remoteClaudeBlock(input), remoteCodexBlock(input)];
}

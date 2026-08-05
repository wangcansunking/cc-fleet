# Claude Model Map Specification

## Problem

Some Copilot accounts advertise GPT 5.x models but no usable Claude models. Claude Code and Claude Desktop still work best when the Anthropic gateway advertises canonical Claude model IDs: their native model picker, context sizing, thinking UI, and tool protocol all key off those IDs.

copilot-reverse needs an opt-in compatibility mode that presents native Claude identities to Anthropic clients while executing each request on a known GPT backend. The existing behavior must remain unchanged unless the user explicitly enables the mode.

## User interface

The copilot-reverse TUI exposes one command:

- `/claude-map` — show the current `on`/`off` state and the complete preset map.
- `/claude-map on` — persist enabled state and restart the worker.
- `/claude-map off` — persist disabled state and restart the worker.

The command is listed by `/help` and slash autocomplete. Repeating the current state is idempotent. Any other argument returns `usage: /claude-map [on|off]`, does not change preferences, and does not restart the worker.

A successful state change tells the user to reopen Claude's `/model` picker and to restart Claude Code or Claude Desktop if their discovery cache remains stale. The command never deletes or rewrites a client's private discovery cache.

If persistence succeeds but the worker restart fails, the TUI reports both facts: the preference was saved, but activation is incomplete until `/restart` succeeds. It must not claim that the new routing behavior is already active.

## Preset mapping

| Claude client model | Copilot backend |
|---|---|
| `claude-haiku-4-5` | `gpt-5.4` |
| `claude-sonnet-4-6` | `gpt-5.5` |
| `claude-opus-4-8` | `gpt-5.6-luna` |
| `claude-opus-5` | `gpt-5.6-sol` |
| `claude-sonnet-5` | `gpt-5.6-terra` |

`[1m]` is a Claude Code client suffix, not part of a map key. Resolution strips it before consulting the map.

## Default and persistence

The feature defaults to `off` for a missing, unreadable, corrupt, or non-boolean preference. Upgrading copilot-reverse therefore changes no discovery or routing behavior.

The state is persisted in the existing `prefs.json` store. Writing it preserves chat-model and change-banner preferences.

The worker snapshots the state at startup. A TUI toggle restarts the worker through the existing supervisor control API so the saved state takes effect atomically for new requests.

## Discovery behavior

### Disabled

Both discovery endpoints and request resolution behave exactly as before this feature:

- Anthropic `/anthropic/v1/models` canonicalizes real Copilot Claude IDs and passes non-Claude IDs through.
- OpenAI `/openai/models` lists real Copilot model IDs.
- No preset alias is synthesized or resolved.

### Enabled

OpenAI discovery remains unchanged and lists only real Copilot model IDs.

Anthropic discovery retains every real Copilot model entry and appends a Claude alias only when its mapped GPT target is present in the live Copilot model list. A missing target hides its alias; there is no silent fallback to a different GPT model.

Synthesized entries use canonical Claude IDs and native display names (`Opus 5`, `Sonnet 5`, and so on). Claude Code and Desktop must therefore look native: the mapping arrow is not included in Anthropic `display_name`.

The copilot-reverse TUI model picker is intentionally more diagnostic. It retains original GPT rows and labels available aliases as `claude-opus-5 → gpt-5.6-sol`, without changing the submitted model value.

## Routing behavior

When enabled, request resolution follows this order:

1. strip the optional `[1m]` suffix;
2. resolve an exact preset Claude alias whose backend is live;
3. apply the existing user `modelMap` exact entry;
4. use existing fuzzy matching;
5. apply the existing `*` fallback or pass through.

When disabled, step 2 is absent.

Unavailable aliases are not resolved even if a caller manually submits one. This preserves the discovery invariant: the compatibility layer never promises a backend that discovery did not confirm.

The resolved GPT ID is placed in the canonical request before provider selection. Consequently endpoint selection (`/chat/completions` versus `/responses`), reasoning support, metrics, and upstream errors all use the real GPT backend ID.

## Capability and context semantics

A synthesized alias inherits its backend GPT model's live context limit. That limit determines:

- whether the canonical Claude ID carries `[1m]`;
- the context window displayed by the copilot-reverse picker;
- `CLAUDE_CODE_AUTO_COMPACT_WINDOW` written by Claude setup;
- local and LAN setup context sizing.

The Claude alias's historical/default window must not override the real GPT backend. If no live limit is available, the alias is still routable but no fabricated numeric setup limit is written; canonical fallback behavior remains available for the ID itself.

## Non-goals

- No arbitrary user-edited mapping table in this version.
- No changes to OpenAI/Codex model names or routing.
- No interception of Claude Code's own slash commands.
- No automatic Claude cache deletion.
- No claim that a GPT backend has Claude model quality or identical model-specific behavior; only the Anthropic client protocol and UI remain native.

## Acceptance criteria

1. With no preference, the full existing discovery and routing suites remain unchanged.
2. Enabling the mode persists across restart and disabling restores old behavior.
3. Anthropic discovery includes only aliases whose exact GPT targets are live, while retaining original GPT entries.
4. OpenAI discovery never contains synthesized aliases.
5. A real Anthropic request using a published alias reaches the provider as the mapped GPT ID and follows that backend's endpoint/reasoning capabilities.
6. Alias context metadata comes from the backend GPT limit.
7. `/claude-map` status/toggle/usage and `/model` arrow labels are covered by TUI interaction tests.
8. Hermetic E2E covers discovery-to-provider routing in both feature states.
9. Real CLI E2E drives `claude -p` through one available alias and records `SKIP`, never failure, if none of the preset GPT targets is available.

# Flexible Claude model map

**Date:** 2026-09-05  
**Status:** implementation contract

## 1. Outcome

A hub owner can route Claude-compatible model aliases to any exact model ID returned by live Copilot discovery without waiting for a cc-fleet release. cc-fleet retains a versioned built-in recommendation set, while user entries can add aliases, override built-ins, or disable individual aliases. The same persisted configuration drives Worker routing, the local TUI/setup flow, and the loopback dashboard.

The mapping is hub-global Worker configuration. Every local or devtunnel client that sends inference through the hub observes the same alias semantics; it is not copied into fleet profiles and there is no per-device mapping layer.

## 2. Persisted format and migration

The store is `~/.cc-fleet/claude-map.json`:

```json
{
  "version": 1,
  "enabled": true,
  "entries": [
    { "alias": "claude-opus-6", "backend": "gemini-4-pro" },
    { "alias": "claude-haiku-4-5", "disabled": true }
  ]
}
```

The root object and every entry are strict. The only supported schema version is `1`.

A user entry is exactly one of:

- `{ "alias": string, "backend": string }` — add or override;
- `{ "alias": string, "disabled": true }` — disable an alias.

No credential or provider token is stored in this file or returned by its management interfaces.

When `claude-map.json` is absent, `prefs.json.claudeMapEnabled === true` supplies the enabled state and the user-entry list is empty. The first mapping mutation or on/off mutation writes the new file; all new writes go only to the new store. `prefs.json` remains readable for migration but is not updated.

Writes use a temporary file in the same directory, mode `0600`, followed by rename. The final file is also forced to mode `0600` where the platform supports it. Entries are sorted by alias for deterministic output.

A malformed file, duplicate normalized alias, or unknown version is rejected as one whole document. Runtime reads fail closed by returning mapping disabled, no user entries, built-in effective rows for management visibility, and an actionable warning. No subset of a corrupt document is accepted and the file is not overwritten automatically.

## 3. Identifiers and validation

Aliases are normalized by trimming surrounding whitespace and stripping one terminal `[1m]`. The stored alias must then:

- start with `claude-`;
- contain at least two non-empty hyphen-delimited segments after `claude`;
- use only lowercase ASCII letters, digits, dots, and hyphens;
- match `^claude-[a-z0-9][a-z0-9.-]*(?:-[a-z0-9][a-z0-9.-]*)+$`.

Backends are trimmed exact identifiers. They must be non-empty, at most 200 characters, contain no ASCII control or whitespace characters, and differ from the normalized alias. Backends are not restricted to a provider family: GPT, Gemini, Grok, Claude, and future Copilot IDs are all valid. Configured backends are never fuzzy matched.

Aliases and backends are each capped at 200 characters, and a document may contain at most 256 user entries. Duplicate aliases after normalization reject the entire write. Display names continue to derive from the alias through the existing canonical model formatter.

## 4. Effective mapping and precedence

`BUILTIN_CLAUDE_MODEL_MAP` contains the five versioned defaults:

| Alias | Backend |
|---|---|
| `claude-haiku-4-5` | `gpt-5.4` |
| `claude-sonnet-4-6` | `gpt-5.5` |
| `claude-opus-4-8` | `gpt-5.6-luna` |
| `claude-opus-5` | `gpt-5.6-sol` |
| `claude-sonnet-5` | `gpt-5.6-terra` |

Effective mappings are computed by alias:

1. Start with the current built-in entries.
2. Apply each user entry.
3. A `{ alias, backend }` entry replaces the built-in backend or adds a new alias.
4. A `{ alias, disabled: true }` entry keeps the row visible but makes it unroutable.

Each effective row reports `source: "builtin" | "user"` and `status: "available" | "unavailable" | "disabled"` when combined with live discovery. A user override has `source: "user"`; an untouched default has `source: "builtin"`.

Removing an entry means removing only the user operation. A built-in alias therefore falls back to the current built-in default; a user-only alias disappears. Reset removes every user entry and preserves the enabled flag.

A user operation remains authoritative across upgrades. A later built-in change cannot override an existing user backend or disabled entry.

## 5. Runtime routing and discovery

The Worker reads one validated snapshot at process startup and injects the resulting effective mappings into `Router`. It does not perform filesystem I/O on request paths. Every successful management mutation restarts the Worker so the next process sees the new snapshot.

Mapping applies only when all of the following are true:

- the global map is enabled;
- Copilot discovery completed successfully with a live model list;
- the effective entry is not disabled;
- the configured backend appears in that live list by exact string equality.

When those conditions hold:

- Anthropic discovery publishes the canonical alias, including a derived `[1m]` suffix when the backend limit exceeds 800,000 tokens;
- an alias request resolves to the exact backend;
- context-window lookup uses the backend limit;
- request metrics record the actual backend ID.

When a target is unavailable, the configuration remains persisted and visible as `unavailable`, but the alias is omitted from Anthropic discovery and is not specially routed. If a later Worker start receives that target from live discovery, it becomes available automatically without another edit.

OpenAI discovery always contains only real upstream model IDs and is unaffected. If live discovery itself contains the same Claude alias, map mode replaces its Anthropic discovery metadata and routing semantics only when the configured backend is available. Disabled/unavailable entries do not suppress a real upstream model with the same ID; they merely add no mapping behavior.

`[1m]` is accepted on alias requests by stripping one suffix before lookup. A configured backend is forwarded exactly as stored and is never passed through fuzzy matching.

## 6. TUI and local setup

The TUI reads the same store and effective map as the Worker. The command forms are:

```text
/claude-map
/claude-map on
/claude-map off
/claude-map set <claude-alias> <backend>
/claude-map disable <claude-alias>
/claude-map remove <claude-alias>
/claude-map reset
```

`/claude-map` shows the global enabled state, any store warning, and every effective row with source and current availability. `set`, `disable`, `remove`, and `reset` use the store's validation and semantics. `remove` returns a not-found error if there is no user operation for that alias. Mutations that make no semantic change are valid and report that no change was needed.

The TUI refreshes live model discovery before assigning availability when possible. An unavailable target is accepted and reported as saved but hidden until discovery reports it. Every successful mutation calls the existing supervisor restart interface. If persistence succeeds but restart fails, the command reports both facts explicitly: the setting is saved and will apply on the next successful Worker start.

The model picker, setup writer, stale-model healing, labels, and context-window lookup all use the same effective mappings. The model written into Claude client configuration remains the alias; only Worker routing uses the backend.

## 7. Local dashboard management interface

The supervisor owns an injected Claude-map administrator separate from `FleetAdmin`, so model-map management works even when the hub role is disabled. The loopback management routes are:

- `GET /api/claude-map`
- `PUT /api/claude-map`
- `POST /api/claude-map/reset`

The GET response contains:

```json
{
  "enabled": true,
  "entries": [{
    "alias": "claude-opus-5",
    "backend": "gpt-5.6-sol",
    "source": "builtin",
    "status": "available",
    "hasOverride": false
  }],
  "userEntries": [],
  "liveBackendIds": ["gpt-5.6-sol"],
  "warning": null
}
```

A disabled row omits `backend`, has `status: "disabled"`, `source: "user"`, and `hasOverride: true`. `liveBackendIds` contains exact real Copilot IDs; synthesized aliases are removed from this list.

PUT replaces the complete user-entry list and enabled state in one atomic write:

```json
{ "enabled": true, "entries": [/* user operations */] }
```

Reset clears user entries and leaves enabled unchanged. Both mutations use the existing JSON, same-origin, CSRF, and body-size protections. Invalid input returns `400` with `code: "invalid_request"` and does not write or restart. A persistence failure returns `500` with `code: "write_failed"`. A successful write invokes Worker restart and returns the new sanitized state. Since restart initiation is synchronous in the existing monitor interface, later readiness is observed through normal status polling.

The dashboard has a **Claude map** view with:

- an on/off control;
- effective rows showing alias, backend, built-in/user source, and available/unavailable/disabled state;
- add/edit/disable, remove override, reset-to-defaults, and save-and-restart actions;
- a backend datalist populated from live IDs while still accepting exact IDs not currently live;
- browser-side validation matching server constraints, with the server remaining authoritative;
- amber styling and explanatory text for unavailable rows, muted styling for disabled rows, and explicit restart interruption text.

Edits remain local until **Save & restart**. Cancel/reload restores the last persisted response. Empty, default-only, overridden, disabled, unavailable, and large valid maps must render without script errors on desktop and mobile.

## 8. Errors and safety

- Mapping configuration never crosses the public fleet gateway and is never part of a profile apply frame.
- Management routes remain on loopback port `7990`; no route is added to the devtunnel gateway.
- Responses and logs contain no GitHub token, Copilot token, device token, LLM key, or file contents unrelated to this store.
- Bad persisted data cannot silently enable or partially alter routing.
- A backend absent from discovery cannot be reached through a configured alias.
- Mutation persistence happens before restart; a failed restart does not roll back a valid file.

## 9. Verification contract

Implementation is complete only when all of the following pass:

1. Pure resolver and store tests cover defaults, add, override, disable, remove/reset fallback, normalization, duplicate aliases, invalid identifiers, deterministic writes, legacy migration, corrupt/unknown-version fail-closed behavior, and file permissions where testable.
2. Worker/router E2E covers arbitrary backend families, exact availability gating, later availability, alias collision, context limits, metrics backend IDs, `[1m]`, map-off behavior, and unchanged OpenAI discovery.
3. Supervisor integration tests cover GET/PUT/reset, CSRF/origin/media-type guards, invalid requests, no-secret responses, no-write/no-restart on failure, and restart after successful persistence.
4. TUI interaction tests cover every command form, status rendering, invalid input, unavailable warning, idempotence, persistence failure, and saved-but-restart-failed messaging.
5. Dashboard tests and a real browser run cover defaults, add/edit/disable/remove/reset, cancel/reload, validation, unavailable styling, many rows, desktop/mobile layout, and zero console/network errors.
6. The Docker HTTP matrix starts the real supervisor/Worker with a temporary map file and proves discovery, route, metrics, disabled/unavailable behavior, OpenAI isolation, and management-triggered restart.
7. A real authenticated CLI run uses a currently live arbitrary backend, invokes Claude through a fresh alias, and verifies reset/fallback. Optional unavailable external dependencies may skip only with a recorded reason.
8. `npm run build`, `npm test`, and `npm run test:e2e` finish with zero failures, and `e2e/RESULTS.md` records the run.
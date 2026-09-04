# M4 — devtunnel + fleet dashboard

**Date:** 2026-09-03
**Status:** implementation contract

## 1. Outcome

A hub owner can keep one `cc-fleet` supervisor running, enable a persistent Microsoft Dev Tunnel
from the local dashboard, and manage the fleet without editing files. A node can join through the
public HTTPS URL, receive config, and use the hub's Copilot-backed Anthropic/OpenAI endpoints without
a GitHub login of its own.

This milestone includes the non-agent part of the dashboard originally scheduled for M6. It does
not include the pi dashboard agent or OS boot-service installers.

## 2. Fixed boundaries

| Local port | Owner | Reachability |
|---|---|---|
| `7990` | supervisor API + dashboard | loopback only, never tunnelled |
| `7991` | Copilot worker | loopback by default; existing explicit LAN mode remains supported |
| `7992` | fleet gateway | loopback; the only port mapped by devtunnel |

The gateway exposes exactly:

- `POST /control/device/code`
- `POST /control/device/token`
- `GET /control/events`
- `POST /control/msg`
- `/anthropic/**` proxied as a byte stream to `127.0.0.1:7991`
- `/openai/**` proxied as a byte stream to `127.0.0.1:7991`
- `GET /healthz` returning only `{ "ok": true }`

Every other path returns `404`. In particular `/`, `/api/**`, dashboard HTML, profile operations,
approval, adoption, revocation and tunnel management never appear on the public gateway.

A single persistent tunnel maps local port `7992` with protocol `http`; Microsoft terminates public
TLS. cc-fleet creates it with a `cc-fleet` label and anonymous client access. Anonymous tunnel
access is acceptable only because both application planes below fail closed.

Microsoft Dev Tunnels is public preview and has no SLA. The dashboard must display that limitation.

## 3. Authentication domains

### 3.1 Control plane

The existing device authorization flow remains:

1. The node receives a 256-bit `deviceCode` and a human-readable `userCode`.
2. A human approves or denies the named request on the local hub dashboard/CLI.
3. Only an approved, unexpired, unredeemed `deviceCode` obtains a per-device token.
4. The token is valid only for its own `deviceId`; revocation kills the open SSE stream and all future
   requests.

The dashboard approval button shows hostname, OS, agent version and short code, then requires a
second click. The user explicitly chose not to require retyping the short code.

### 3.2 LLM plane

Every gateway request under `/anthropic/**` or `/openai/**`, including requests tunnelled back to a
loopback socket, requires the separate fleet LLM key:

- Anthropic/Claude: `x-api-key: <key>`
- OpenAI/Codex: `Authorization: Bearer <key>`

Comparison is constant-time after a length check. Missing/wrong keys return `401` before body
buffering or any worker/provider call. If no key is configured, return `503` fail-closed.

The LLM key is not a device token. Revoking a device removes control access but does not rotate the
fleet-wide LLM key; the dashboard offers explicit key rotation. Rotation republishes desired state
to active devices so their managed client config is updated. The key must never occur in dashboard
GET responses, profile JSON, logs, inventory, reports or tunnel state.

## 4. Runtime roles and lifecycle

Runtime state is persisted in `~/.cc-fleet/runtime.json`:

```json
{ "hubEnabled": true }
```

Node role is inferred from a valid `fleet-node.json`. Hub and node roles may coexist on one machine.

- `cc-fleet hub` creates the starter profile if needed, enables hub role and ensures the detached
  supervisor is running. `--foreground` retains a diagnostic/test foreground server.
- `cc-fleet join <url>` performs authorization, persists node credentials, ensures the supervisor is
  running, asks it to start/reload the node runtime, then exits.
- The supervisor owns worker (only where a GitHub login exists/hub needs it), hub/gateway, node agent
  and tunnel manager. It closes every child/socket/watcher on shutdown.
- A transient node link failure retries with bounded exponential backoff. `401` or `403` is terminal:
  node state becomes `auth-failed`, no new authorization request is created, and a human must join
  again.
- The tunnel host process is single-instance. An unexpected exit enters backoff and reconnects the
  same persistent tunnel ID/URL. Disable stops hosting but keeps the cloud tunnel; delete is a
  separate confirmed operation that deletes the cloud resource and local record.
- No systemd/launchd/Task Scheduler installation is included. The detached supervisor is started by
  cc-fleet commands and does not promise OS-boot startup.

## 5. Dev Tunnel adapter

No SDK dependency is introduced; the official `devtunnel` CLI is the compatibility boundary.
Commands use `spawn`/`spawnSync` with `shell:false` and argument arrays.

Required operations:

| Operation | Command shape |
|---|---|
| availability | `devtunnel --version` |
| login state | `devtunnel user show --json` |
| interactive login | `devtunnel user login --use-device-code-auth --json` |
| create | `devtunnel create --allow-anonymous --labels cc-fleet --description ... --json` |
| add port | `devtunnel port create <id> -p 7992 --protocol http --request-timeout 0 --json` |
| inspect | `devtunnel show <id> --json`; `devtunnel port list <id> --json` |
| host | `devtunnel host <id>` (long-running, URL parsed from output) |
| delete | `devtunnel delete <id> --force --json` |

State is `disabled | cli-missing | signed-out | provisioning | connecting | online | backoff | failed`.
CLI errors are bounded, first-line actionable errors; raw auth tokens are never returned. The
manager tolerates preview CLI JSON field naming differences but never guesses a tunnel ID from an
unlabelled tunnel.

If the CLI is missing, the dashboard presents official platform-specific install commands but does
not run them. If signed out, an explicit Login action starts device-code login and streams the code
and verification URL to the local dashboard.

## 6. Profile and apply protocol

`PROTO_VERSION` is bumped because apply/report frames change incompatibly.

The non-secret profile shape gains optional client defaults and per-device overrides:

```jsonc
{
  "version": 12,
  "clients": {
    "claude": { "model": "claude-opus-5[1m]", "contextWindow": 1000000 },
    "codex":  { "model": "gpt-5.6-sol", "contextWindow": 1000000 }
  },
  "groups": { "full": { "skills": [], "rules": [], "mcpServers": [] } },
  "assignments": { "laptop-home": "full" },
  "devices": {
    "laptop-home": {
      "add": { "skills": [] },
      "remove": { "skills": [] },
      "override": {
        "claude": { "model": "claude-sonnet-5[1m]", "contextWindow": 1000000 },
        "codex": { "model": "gpt-5.6-terra", "contextWindow": 1000000 }
      }
    }
  }
}
```

Models must be non-empty strings; context windows, when present, are positive integers. Resolution
is group → add/remove → per-device client override. An unassigned device still receives no apply and
is never resurrected by an override.

An authenticated apply frame contains:

```jsonc
{
  "t": "apply",
  "proto": 2,
  "version": 12,
  "state": { "skills": [], "rules": [], "mcpServers": [] },
  "clients": {
    "baseUrl": "https://...devtunnels.ms",
    "apiKey": "<fleet LLM key>",
    "keyRevision": 3,
    "claude": { "model": "...", "contextWindow": 1000000 },
    "codex": { "model": "...", "contextWindow": 1000000 }
  }
}
```

`clients` is omitted when the tunnel is not online or defaults are not configured; config sync must
not erase a previously working managed endpoint merely because the tunnel is transiently offline.
The public base URL is injected at runtime and the key comes from `network.json`; neither is stored
in `profile.json`.

Node application reuses existing writers:

- `claudeCopilotReverseEnv` + `applyClaude("global", ...)`
- `applyCodexToml(...)`

Before the first managed write, exact originals of `~/.claude/settings.json` and
`~/.codex/config.toml` (including non-existence) are snapshotted atomically under
`~/.agents/.cc-fleet/client-backup/`. Reapply changes only cc-fleet-managed fields/provider table.
Restore/leave-fleet restores those exact originals and never deletes unrelated user content.

An applied report includes client status (`changed | unchanged | skipped | error`) per client,
`keyRevision`, and `needsRestart` when a running client session must restart to observe config.
Secrets never occur in reports.

## 7. Profile draft, diff, publish and rollback

The local management service is revisioned:

- `readLive()` → validated profile + SHA-256 revision.
- `saveDraft(raw, baseRevision)` validates and atomically writes a draft only. A stale base revision
  returns conflict. ProfileService and CLI mutations share a lock/revision protocol; direct external
  editors do not participate, so operators should use the dashboard/CLI for concurrent writes.
- `previewDraft()` calculates every assigned/enrolled device's effective before/after state. Output
  lists item IDs added/removed/changed and client model changes; it never includes file contents,
  MCP config values, endpoint key or token hashes.
- `publishDraft(expectedRevision)` re-checks revision, sets `version = live.version + 1` regardless of
  draft value, snapshots the old live profile, atomically replaces live, and triggers normal publish.
- `rollback(historyId, expectedRevision)` publishes historical content as a new monotonically higher
  version. Version never goes backwards.
- Adoption uses the same revisioned atomic publish service and does not touch the shared dashboard
  draft. It cannot clobber dashboard/CLI mutations; a direct editor save is detected before replacement
  when it occurs before the final compare, but portable filesystems offer no atomic compare-and-swap
  with an uncooperative editor.

History keeps the latest 20 profile snapshots in `~/.cc-fleet/profile-history/`.

## 8. Local dashboard API

All endpoints exist only on loopback supervisor port `7990`.

GET routes:

- `/api/bootstrap` → per-process CSRF token and product/version (no secrets)
- `/api/fleet/summary`
- `/api/fleet/enrolments`
- `/api/fleet/devices`
- `/api/fleet/pending`
- `/api/fleet/profile/live`
- `/api/fleet/profile/draft`
- `/api/fleet/profile/preview`
- `/api/fleet/profile/history`
- `/api/fleet/tunnel/status`

Mutation routes:

- `POST /api/fleet/enrolments/:requestId/approve|deny`
- `POST /api/fleet/devices/:deviceId/revoke`
- `POST /api/fleet/pending/:deviceId/:kind/:id/adopt|reject`
- `PUT /api/fleet/profile/draft`
- `POST /api/fleet/profile/publish`
- `POST /api/fleet/profile/rollback`
- `POST /api/fleet/tunnel/login|enable|disable|delete|rotate-key`
- `POST /api/fleet/node/reload`

Every mutation requires:

1. JSON content type where a body exists;
2. same-origin `Origin` matching the request's loopback host;
3. `x-cc-fleet-csrf` equal to the per-process token;
4. zod validation and bounded body size;
5. an explicit confirmation value for publish, rollback, revoke, adopt, key rotation and tunnel
   deletion (deletion uses `DELETE <tunnelId>`).

Errors use `{ "error": "...", "code": "..." }`; revision races are HTTP 409. Responses never expose
`deviceCodeHash`, `tokenHash`, device token, LLM key or tunnel auth tokens.

## 9. Dashboard UI

The dependency-free local page has tabs/sections:

1. **Overview** — worker, hub, node and tunnel state; public URL; counts and warnings.
2. **Tunnel** — CLI/login state, device-code login, enable/disable/delete, URL, reconnect state,
   application-auth posture and preview/no-SLA warning. It never displays the LLM key.
3. **Enrolments** — waiting identity/code/expiry; approve/deny modal with second confirmation.
4. **Devices** — online/last seen/version/apply/inventory/conflicts/client config/needs-restart;
   revoke modal.
5. **Pending** — full pushed content preview, target group, adopt/reject confirmation.
6. **Profile** — structured groups/items/assignments/device model overrides plus synchronized advanced
   JSON; save draft; per-device diff; publish confirmation; history and rollback.
7. **Health & requests** — existing worker/GitHub/models/metrics/errors panels.

The page handles empty, loading, single, many, malformed input, stale revision, network failure,
retry, cancel and duplicate actions. It is responsive at 375px and desktop widths and uses semantic
labels/dialogs/status regions.

## 10. Safety and non-goals

- No dashboard route is public.
- No secret is embedded in a URL, HTML, GET response, log or profile.
- No shell command incorporates an untrusted string; all child processes use argv arrays.
- No automatic approval, adoption, publish, revoke, key rotation or cloud tunnel deletion.
- No automatic `winget`, curl installer, systemd, launchd or Task Scheduler change.
- No pi agent or `setup-pi` in this milestone.
- Dev Tunnel is a developer preview dependency, not represented as production-grade HA.

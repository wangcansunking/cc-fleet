# E2E test cases

End-to-end scenarios that wire the **real** worker + supervisor + TUI modules together the way
the daemon does (worker metric sink → supervisor SQLite → control API), using a fake Copilot
provider so no live network/token is needed. Specs: the per-topic `e2e/*.e2e.test.ts` files
(`proxy`, `model-vision`, `tools`, `multiturn`, `responses`, `control-setup`), sharing the
fixtures in [`helpers.ts`](./helpers.ts).

**Policy: every code update must keep all e2e cases green.** Run with `npm run test:e2e`
(`npm test` also runs them — the suite is included in the default vitest run).

| ID | Scenario | Expected result |
|----|----------|-----------------|
| EP-01 | Anthropic `POST /v1/messages` with `stream: true` | SSE contains `message_start`, a `text` delta, and `message_stop` |
| EP-02 | OpenAI `POST /v1/chat/completions` | `choices[0].message.content` is the assistant text |
| EP-03 | `POST /v1/messages/count_tokens` | `200` with `input_tokens > 0` (lets clients time auto-compaction) |
| EP-04 | `/v1/messages` carrying an Anthropic **server-side tool** (`web_search_20250305`) | request completes `200` — the built-in tool is dropped, so the client never hangs waiting for a `tool_result` |
| EP-05 | A failing provider stream | worker emits `event: error` (not a silent close) **and** the supervisor records the failure with its message, visible at `GET /api/requests` / dashboard |
| EP-06 | `GET /` on the supervisor | `200` HTML dashboard page |
| EP-07 | `/logs` slash command | lists recent request errors with their messages |
| EP-08 | `/dashboard` and `/report` slash commands | open the dashboard URL and a prefilled GitHub issue URL in the browser |
| EP-09 | `/reset-claude` after `setup` wrote config | removes exactly the `ANTHROPIC_*` keys copilot-reverse added, preserving the rest |
| EP-10 | two concurrent Anthropic streams | each `message_start` carries a UNIQUE message id (no dedupe-to-first) |
| EP-11 | Anthropic stream | `message_start` seeds a non-zero `input_tokens` estimate (context bar not stuck at 0%) |
| EP-12 | provider returns usage | `message_delta` reports `input_tokens` (prompt − cached), `output_tokens`, `cache_read_input_tokens` |
| EP-13 | OpenAI stream with usage | a usage chunk with `total_tokens` is emitted before `[DONE]` |
| EP-14 | OpenAI stream fails mid-flight | an `error` chunk is emitted, not a silent close |
| EP-15 | dated Anthropic id (`claude-opus-4-8-20251101`) | fuzzy-matched to the available Copilot model |
| EP-16 | `claude-opus-4.8[1m]` request | the `[1m]` suffix is stripped before forwarding |
| EP-17 | Anthropic image block | round-trips through the proxy as image content (vision) |
| EP-18 | mixed text+tool stream | text@0, tool@1, `stop_reason=tool_use` |
| EP-19 | non-stream tool_use response | maps to Anthropic `tool_use` content |
| EP-19b | extended-thinking stream | thinking block @0 (`thinking_delta`+`signature_delta`) before text @1 |
| EP-19c | client thinking budget | `thinking.budget_tokens` → canonical `reasoning.effort` reaches the provider |
| EP-20 | OpenAI assistant tool_call + tool result | both reach the provider as canonical blocks |
| EP-21 | failed request | error message persists in `request_log`, queryable via `/api/requests` |
| EP-22 | control API | exposes status, doctor, requests endpoints |
| EP-23 | fresh db | round-trips a recorded request (migration-safe schema) |
| EP-24 | `setup-claude` global | HUD status reports configured (user scope); `[1m]` + window written |
| EP-25 | `setup-codex` | writes native `~/.codex/config.toml` with `model_context_window` |
| EP-26 | reset after 1M setup | removes every key including the 1M-window keys |

### Codex `/responses` (EP-27 … EP-38)

The OpenAI Responses API end-to-end through a booted worker (Codex speaks only this). Hermetic — fake
provider, no network. Spec: `responses.e2e.test.ts`, `describe("E2E: Codex /responses")`.

| ID | Scenario | Expected result |
|----|----------|-----------------|
| EP-27 | non-stream `/openai/responses` | `object:"response"`, `status:"completed"`, an `output_text` message item, `usage` totals |
| EP-28 | streaming `/openai/responses` | ordered `response.created → output_item.added → content_part.added → output_text.delta → …done → response.completed`, monotonic `sequence_number`, final `usage` |
| EP-29 | streaming tool call | `function_call` item + `function_call_arguments.delta/.done`, args reassemble |
| EP-30 | non-stream tool call | maps to a `function_call` output item with `call_id`/`name`/`arguments` |
| EP-31 | prior `function_call` + `function_call_output` in `input` | round-trips to the provider as `tool_use` + `tool_result` |
| EP-32 | `input_image` content part | round-trips to the provider as an image block |
| EP-33 | `instructions` | becomes a `system` message |
| EP-34 | hosted `web_search` tool + a function tool | `web_search` passes through as a hostedTool; the function tool is kept |
| EP-35 | expired token | `401` with `error.type:"error"` (login hint) |
| EP-36 | mid-stream failure | a `data: {"type":"error"}` frame, not a silent close |
| EP-37 | a `/responses` request | recorded in the supervisor `request_log` with `endpoint:"/openai/responses"` |
| EP-38 | `gpt-4o[1m]` model | the `[1m]` suffix is stripped before forwarding |
| EP-42 | tools carried in an `additional_tools` input item (Codex 0.145+ / gpt-5.6) | the tools reach the provider (not dropped); the `additional_tools` item never leaks as a message (#4231) |
| EP-43 | prior `custom_tool_call` + `custom_tool_call_output` in `input` | round-trip to the provider as `tool_use` (raw-string input wrapped as `{input}`) + `tool_result` (#4231) |

### Claude model compatibility map (EP-44 … EP-47)

The map is opt-in and snapshots the persisted preference at worker startup. Hermetic tests inject a live
model list and fake provider so discovery and resolved routing are proven without Copilot quota.

| ID | Scenario | Expected result |
|----|----------|-----------------|
| EP-44 | map disabled, Anthropic + OpenAI discovery | existing real-model lists are unchanged; no preset Claude alias is synthesized |
| EP-45 | map enabled with only some preset GPT targets live | Anthropic discovery retains real models and adds only aliases whose exact targets are live; OpenAI discovery adds none |
| EP-46 | Anthropic request using a published `[1m]` Claude alias | provider receives the mapped GPT ID, not the alias; metrics also record the GPT backend |
| EP-47 | mapped backend advertises a ~1.1M window | alias discovery/setup metadata uses that backend window and carries the canonical `[1m]` suffix |

### Fleet control plane — M1 tracer (CF-01 … CF-10)

The hub→node control loop over **real HTTP** on an ephemeral port: a hub serving a hand-written
`profile.json`, a node enrolling with a pre-shared token, and skills landing on disk. No Copilot, no
tunnel, no GitHub login — which is the point: `control/` imports nothing from `worker/`
(docs/design.md §2), so the whole plane is exercisable on its own. Spec:
[`control-m1.e2e.test.ts`](./control-m1.e2e.test.ts) and
[`docs/specs/2026-08-13-control-m1-tracer.md`](../docs/specs/2026-08-13-control-m1-tracer.md).

| ID | Scenario | Expected result |
|----|----------|-----------------|
| CF-01 | node connects to a hub holding a profile | the profile's skill is written to `<claudeHome>/skills/<id>/`, agent reports `applied` |
| CF-02 | hub's `profile.json` is edited | the node's file reflects the edit in **under 5 seconds** (the M1 exit criterion) |
| CF-03 | node finishes an apply | the hub records `applied` with the version, write and delete counts |
| CF-04 | node has a skill the profile does not declare | full takeover deletes it, and the pre-apply state is in `<claudeHome>/.cc-fleet/backups/` |
| CF-05 | hub has no assignment for this hostname | nothing on the node changes and no backup is taken — an unregistered machine is left alone |
| CF-06 | apply runs | `commands/`, `projects/`, `CLAUDE.md` and `.claude.json` are untouched |
| CF-07 | node presents the wrong token | `401`; with no hub token configured at all, everything is refused (fail-closed) |
| CF-08 | `profile.json` becomes unparseable mid-session | the last good profile stays in force on the node; a later valid edit recovers |
| CF-09 | node is offline while the profile changes | it converges on reconnect (the hub re-pushes on connect, not only on change) |
| CF-10 | assigned group becomes empty | `skills/` is emptied — distinct from CF-05's "not managed" |

### Multi-turn continuity (EP-39 … EP-41)

The Anthropic/OpenAI wire is **stateless** — the client (Claude Code on `--resume`, or an interactive
REPL) replays the entire prior conversation in `messages` on every turn. So a follow-up turn only
"remembers" the first if the proxy faithfully forwards that replayed history. These capture what
reached the provider on turn 2 and assert the turn-1 exchange survived translation. Hermetic — fake
provider. Spec: `multiturn.e2e.test.ts`, `describe("E2E: multi-turn continuity")`.

| ID | Scenario | Expected result |
|----|----------|-----------------|
| EP-39 | Anthropic turn 2 body `[user, assistant, user]` (what `--resume` replays) | both the turn-1 user fact AND the assistant reply reach the provider — 2 user + 1 assistant messages, content intact |
| EP-40 | OpenAI chat turn 2 with prior history | same history round-trip on `/openai/chat/completions` |
| EP-41 | streaming turn 2 with prior history | prior turns reach the provider on the streamed path too (interactive-REPL wire is identical) |

## What each case protects (regressions it would catch)

- **EP-01/EP-02** — core proxy translation (OpenAI/Anthropic ⇄ Copilot canonical), streaming framing.
- **EP-03** — the count_tokens endpoint Claude Code relies on; missing → 404 → compaction mis-times.
- **EP-04** — the "infinite hang on server-side tools" class of bug (agent-maestro #163/#150).
- **EP-05** — the headline fixes: no silent stream-close, and request-error capture end-to-end.
- **EP-06** — dashboard route stays mounted.
- **EP-10/EP-11/EP-12/EP-13** — the usage/id fixes: unique message id (different asks → different answers), non-zero context bar, real token usage.
- **EP-15/EP-16** — model resolution (fuzzy match + 1M `[1m]` suffix).
- **EP-17** — vision passthrough (images not dropped).
- **EP-18/EP-19/EP-20** — tool-call translation in both directions.
- **EP-39/EP-40/EP-41** — multi-turn continuity: a resumed/interactive conversation's prior turns are replayed by the client and must survive translation, or every follow-up ("what did I just say?") silently loses context.
- **EP-24/EP-25/EP-26** — the full setup→status→reset lifecycle for both clients.
- **CF-04/CF-05/CF-06** — the blast radius of full takeover. These are the cases where a bug costs a user work they cannot get back: deleting a skill with no backup, wiping a machine nobody registered, or reaching outside `skills/` into history and credentials.
- **CF-07/CF-08** — the two ways a control plane turns into a weapon: an open one (no token → anyone pushes executable instructions), and one that broadcasts a half-saved profile (which, under full takeover, reads as "delete everything").

## Live integration tests (opt-in, real Copilot)

[`copilot-live.integration.test.ts`](./copilot-live.integration.test.ts) hits the REAL Copilot
endpoints end-to-end (GitHub token exchange → worker → adapter → api.githubcopilot.com). It is
**not** part of `npm test` — run it with `npm run test:integration`. Every case auto-skips when no
GitHub login is on disk (so CI stays hermetic). Coverage: token exchange, model discovery (incl. a
real 1M-window model), OpenAI completion, Anthropic streaming with **different questions → different
answers** (the unique-id regression guard), real `message_delta` usage, and count_tokens.
- **EP-07/EP-08/EP-09** — TUI command wiring: logs/error visibility, dashboard/report, config reset.

## Real CLI Docker e2e (opt-in, real `claude` + `codex`)

The fullest test: the **actual `claude` and `codex` CLIs** drive the **real worker daemon** inside a
Linux container, with a real GitHub token (and optional WebIQ key) mounted. See
[`docker/README.md`](./docker/README.md) — built/run via `e2e/docker/Dockerfile.cli` + `cli-e2e.sh`,
not part of `npm test`. It writes a markdown report after each run. Checks:

| Scenario | Path | Passes when |
|----------|------|-------------|
| `codex exec` | `/openai/responses` | the model returns `CODEX_OK` |
| `claude -p` | `/anthropic/v1/messages` | the model returns `CLAUDE_OK` |
| `claude` web search | gateway `web_search` loop → WebIQ | a grounded answer (a Rust `1.x` version), no error |
| codex multi-line | `/openai/responses` | two-line reply preserved (`LINE_ONE`/`LINE_TWO`) |
| claude constrained | `/anthropic/v1/messages` | `6*7` → `42` |
| `[1m]` model id | resolveModel strip | `gpt-4o[1m]` still answers `ONEM_OK` |
| model discovery | `/anthropic/v1/models` | picker gets dashed `claude-opus-4-8[1m]`, no dotted ids leak |
| canonical opus | `/anthropic/v1/messages` | `claude-opus-4-8[1m]` resolves to Copilot opus + answers `OPUS_OK` |
| setup default model | `claudeCopilotReverseEnv` | the default ANTHROPIC_MODEL is dashed `claude-opus-4-8[1m]` + answers `DEFAULT_OK` |
| newly-shipped 1M model | `/v1/models` + `claudeCopilotReverseEnv` | when upstream advertises `claude-opus-5[1m]`, the picker badges it 1M, setup emits the `[1m]` id (window-driven, not a hardcoded list), and it answers `OPUS5_OK`; `SKIP`s if opus-5 is absent from the account |
| multi-turn `--resume` | `-p` turn 1 → `-p --resume <session_id>` turn 2 | turn 2 recalls the turn-1 codeword (`HORIZON`) — real conversation memory survives the proxy; `SKIP`s if the CLI omits `session_id` |
| effort echoed (modern wire) | `/anthropic/v1/messages` | `output_config.effort` low/medium/high/xhigh/max each echoes in `x-copilot-reverse-effort` |
| effort legacy budget | `/anthropic/v1/messages` | legacy `thinking.budget_tokens=16000` still maps to `high` |
| `claude --effort max/low` | real CLI effort knob | the turn still answers `6*7`→`42` at both levels (high effort doesn't break a turn) |
| large Claude history | `/anthropic/v1/messages` | a ~400-line pasted-history turn answers `BIGHIST_OK` and NEVER emits `does not support Responses API` (safety-net must not mis-route a big Claude turn to /responses) |
| Claude + image | `/anthropic/v1/messages` | a Claude id + a REAL 64x64 image block (pasted history + screenshot) round-trips: Copilot Claude SEES the image and names its colour (`red`), and the turn NEVER emits the misleading `does not support Responses API` (before the fix, an image turn that 400'd on /chat with an `invalid_request_body` body was mis-retried on /responses) |
| codex tool loop | `codex exec -s workspace-write` → `/openai/responses` | codex issues a real shell `function_call`, its output round-trips as `function_call_output`, and the file `codex_proof.txt` (contents `CODEX_TOOL_OK`) exists on disk — the filesystem is the oracle, immune to JSONL event-shape drift (guards the "stream closed before response.completed" tool-translation regression class) |
| claude vision OCR (small) | `claude -p --allowedTools Read` → `/anthropic/v1/messages` | claude reads an in-container 5KB PNG with a baked-in token and reports `VISION7` — proves the real Read-tool → image → Copilot vision path SEES pixels (byte short-circuit, no re-encode). SKIPs if vision unentitled |
| claude vision OCR (downscale legibility) | `claude -p --allowedTools Read` | claude reads a 2.6MB PNG (>1.5MB gate) and still reports `BIGTEXT9` — proves the PR #44 decode+re-encode ladder keeps the image LEGIBLE, not just smaller |
| unknown / typo'd model | `ANTHROPIC_MODEL=not-a-real-model-xyz claude -p` | a nonsense id (fuzzy < 0.6 → forwarded verbatim → Copilot 404) degrades to a bounded `is_error` and RETURNS within 90s (rc≠124), never hanging to the turn timeout — the one model-resolution branch http-e2e can't reach |
| codex native web_search | `codex exec -c model=gpt-5 -c features.web_search=true` | the hosted `web_search` tool passes through (`responses-inbound.ts` HOSTED_TOOL_TYPES) and returns a grounded Rust `1.x` version. SKIPs if the token lacks gpt-5 web_search entitlement or the knob drifted |
| codex gpt-5.6 `additional_tools` | `codex exec -c model=gpt-5.6 --dangerously-bypass-approvals-and-sandbox` → `/openai/responses` | codex 0.145+ sends its tools inside an `additional_tools` item (not top-level `tools`); the worker must extract them so a real shell tool loop runs and `codex56_proof.txt` (contents `CODEX56_OK`) is written. SKIPs if gpt-5.6 is absent from the account. Guards the #4231 tool-less-narration regression that cases 12/16 (default model, old wire shape) can't catch |

## HTTP edge-case Docker e2e (hermetic — no real Copilot)

Boots the **real** worker (:7891) + supervisor (:7890) and drives them over HTTP on a dummy token, so
error paths, supervision lifecycle, and the crash-guard regression run without a real token or quota.
`e2e/docker/Dockerfile.http` + `http-e2e.mjs`; runs on every CI push. Checks: malformed JSON→400,
>20mb→413, unknown route→404, models/healthz/count_tokens shapes, status/doctor/requests/dashboard,
restart recovery, dead-socket broadcast churn survival, and a deterministic `EventBus` isolation guard
that **fails on a reverted PR #8** (throwing subscriber must not escape `emit`). It also checks model
discovery: `/anthropic/v1/models` advertises Claude families as dashed canonical ids + display + a
`[1m]` badge (`claude-opus-4-8[1m]`) and never leaks Copilot's dotted ids — so Claude Code's native
picker lights up. The `/doctor` self-check is asserted to carry the web-search + models checks (light
mode is upstream-free with no per-model `model:` pings; `?ping=1` adds them on demand), and the
dashboard's new `/api/clients` + `/api/models` data endpoints are checked. It also drives a real
failing request, reads the stored metric back, and renders it through the real `dist` TUI formatter
(`oneLine`) to assert the `/logs` line carries no embedded newline — a multi-line upstream body (a 502
HTML page) once shattered the bordered card. Finally it inserts >100 rows straight into the
supervisor's own SQLite DB and asserts `/api/metrics` rolls up the WHOLE `request_log` (total > 100,
24h window ≤ all-time, and a pre-100 failure still surfaces in `recentErrors`) — proving `/metrics` is
no longer capped at the last 100 requests. Real round-trips run only when a real token is mounted.

It also asserts the **image downscale** (fixes `model_max_prompt_tokens_exceeded`): a large
high-entropy PNG (1800×1200 noise, so it can't run-length compress — a realistic screenshot) is posted
to `count_tokens`, and the reported estimate must land far below the raw base64 byte count, proving the
worker decoded → downscaled → re-encoded the image before it would ever reach Copilot. A second check
nests the SAME image inside a `tool_result` (the real generate-readme-cover-images 502 — a Bash tool
that emitted a screenshot) and asserts it's downscaled there too. A third builds a 1568×1400 image
whose long edge is already within the pixel cap but whose bytes are huge, asserting it's STILL shrunk —
proving the gate is on bytes, not dimensions. Quota-free (no upstream call), so all run on the dummy
token.

It also asserts **context editing** (fixes `413 Request Entity Too Large` on long browser-harness
sessions): 12 screenshot turns, each already UNDER the per-image resize cap (so resize passes them
through untouched) but collectively far over the cumulative budget, are posted to `count_tokens`.
The estimate must land far below the raw sum of all screenshots — proving old tool screenshots were
CLEARED (replaced with a placeholder, most-recent-3 kept), not merely resized. A precondition check
confirms each screenshot really was under the resize cap, so what shrank the count was clearing, not
per-image downscaling. Two further checks assert the property that actually prevents the 413: the edited
payload (tokens×4 bytes) fits under the probed **5 MiB** gateway wall, and — for the issue-52 follow-up —
a request with a **~700k-token conversation PLUS screenshots** still fits, proving the image budget is
DYNAMIC (it shrinks as non-image text grows, clearing more screenshots to keep the WHOLE body under the
wall). The real-CLI matrix mirrors both: a ~9.5MB screenshot pile, and a ~700k-token-text + screenshots
turn, each against live Copilot must not 413 and must still read the most-recent (green) screenshot.

This black-box path caught two bugs nothing else did: a Codex tool-translation `400` (a `custom`/
`tool_search` tool forwarded nameless → Copilot rejects → "stream closed before response.completed"),
and empty terminal Responses events (`output_*.done` carried no text → Codex rendered nothing).

It also covers the **network access modes** (#25): the worker auth gate reads `network.json` lazily,
so the harness flips the posture on disk mid-run and asserts over real HTTP. The key is enforced **only
for requests that arrive from off-box** — a request over loopback is never challenged, in either mode.
So the loopback-driven checks assert the *local* side of the policy: localhost serves with no key, and
**LAN still serves the local machine with no key** (a wrong key is ignored too; even keyless-LAN keeps
loopback open — fail-closed is a remote property). The genuinely-remote checks run in the bind-boundary
block below, over the container's LAN IP: a remote request with a missing key (401), a wrong key (401),
a **same-length** wrong key (401 — exercises the constant-time compare, not just the length check), a
valid key via both `Authorization: Bearer` and `x-api-key` (200), a keyless **oversized** body → 401
**not** 413 (gate before the body parser), and a keyless remote against a keyless-LAN worker → **503**
fail-closed. `/healthz` stays open behind the gate. The loopback-exemption decision is TCP-layer only
(`req.socket.remoteAddress`, covering `127/8`, `::1`, and `::ffff:127.x`), never a spoofable header —
unit-tested in `isLoopbackAddr`.

It also pins the **bind boundary** — the kernel-level reason localhost mode is "you can't even
connect", not a 401. The harness boots a throwaway worker bound to `127.0.0.1` and raw-TCP-probes it
on the container's non-loopback IPv4: the connect is **refused** (no socket on that interface — the
request never reaches the HTTP/auth layer), while loopback stays reachable. It then boots the same
worker bound to `0.0.0.0` (LAN's bind) and confirms it **is** reachable on that exact LAN address — and
runs the full remote key matrix over it, plus a contrast check that the very same exposed worker still
serves **loopback** with no key. Same IP, same probe, only the bind host changes → open↔refused proves
the boundary, not just the config value. (Skipped only if the container has no non-loopback IPv4.)

It also pins the **EADDRINUSE regression** that left the daemon wedged `unhealthy`. The harness forks
the REAL `dist/worker` with a Node IPC channel (so the `disconnect` guard is armed, exactly as a
supervisor-spawned worker), confirms the port is held while connected, then drops the channel with
`child.disconnect()` — the same `disconnect` event an abnormally-dead supervisor leaves behind — and
asserts the orphaned worker exits and **releases the port** (raw-TCP probe flips `open → refused`)
rather than squatting it and starving the next worker's `listen` on the same port. A companion check
asserts the daemon is still `ready` (never flipped to `unhealthy`) after the rapid `/api/restart`
churn, covering the manual-restart kill/respawn race fixed in `restartManually()`.

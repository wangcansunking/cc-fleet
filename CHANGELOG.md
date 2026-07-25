## v0.19.0 — 2026-07-25

fix(codex): make tools work again on Codex 0.145+ (gpt-5.6 family) — issue #4231.

Two problems, both fixed:

1. **Tools were dropped.** Newer Codex no longer puts tools at the top level of a `/responses` request — it carries them inside an `additional_tools` item in `input`. The Responses translator ignored that item, so the model reached Copilot with zero tools and could only narrate its tool calls as text ("I'm unable to access a shell tool"). We now merge `additional_tools` into the tool list.

2. **Custom tools were mistranslated.** Codex's primary tool `exec` is a `custom` tool (freeform-string input, not JSON). We were flattening it to a JSON-schema function, so the model emitted empty `{}` and Codex rejected the reply ("tool exec invoked with incompatible payload"). Copilot's `/responses` natively accepts `{type:"custom"}` tools and returns a `custom_tool_call` (verified live), so we now round-trip custom tools end-to-end: pass them through as `custom`, translate `custom_tool_call` / `custom_tool_call_output` history both ways (raw-string input), and stream them back as `custom_tool_call` + `custom_tool_call_input.delta/.done` events instead of function_call.

Verified against a live `codex exec -m gpt-5.6-luna`: a real shell tool loop now runs through the proxy (single-step and multi-step create→read-back), with the filesystem as oracle.

## v0.18.0 — 2026-07-08

feat(status): show the logged-in GitHub user and Copilot plan on the status card. The GitHub line now reads e.g. `✓ connected · Can Wang (canwa_microsoft) · Copilot Enterprise` — the username comes from GitHub `/user`, and the plan (derived from the `sku` on the Copilot token exchange we already perform, so no extra request) is mapped to a friendly label. Both are best-effort: a failed or pending lookup, an expired login, or a signed-out state simply omits them.

## v0.17.0 — 2026-07-08

feat(skills): add `/setup-skill` — install a bundled agent skill into Claude Code (`~/.claude/skills/` global or `./.claude/skills/` project) via an interactive picker. Ships one curated skill, `analyze-session-create-issue`, which walks the agent through turning a session into a well-formed GitHub issue. Installs are idempotent and non-destructive to other skills.

## v0.16.3 — 2026-07-03

Fix the 413 that returns on screenshot-heavy sessions with a large conversation (issue #52 follow-up). The 413 is on the WHOLE request body, but context editing budgeted only image bytes against a fixed 3.5MB cap — so a ~700k-token transcript (~2.7MB of text) plus 3 kept screenshots (~3.15MB) still exceeded Copilot's 5 MiB gateway wall. The image allowance is now DYNAMIC: `GATEWAY_ENTITY_LIMIT (5 MiB) − SAFETY_MARGIN − nonImageBytes`, capped by the fixed budget for the common small-text case. Big text automatically clears more screenshots (700k text → keep 1 image; 900k text → keep 0), keeping the total body under the wall for any text size. Adds a reactive fallback: if the gateway STILL returns 413, force-clear every screenshot and retry once before surfacing the error (both the streaming and non-streaming Anthropic paths). New unit tests (dynamic budget across text sizes, `forceClearAllScreenshots`, `is413Error`, and end-to-end reactive-retry through the Express app for both stream and non-stream) + an http-e2e assertion that big-text + screenshots fits under 5 MiB.

## v0.16.2 — 2026-07-03

fix(worker): fast-fail an unknown/typo'd model id instead of freezing the turn (#50 P1). An upstream 4xx (e.g. `model_not_supported`) was masked as a retriable 502/`api_error`, so clients that retry (Claude Code, the Anthropic SDK) backed off to their 90s turn timeout and froze. The worker now carries the upstream status through a typed `UpstreamError` and surfaces a permanent 4xx as a terminal `invalid_request_error` (HTTP 400 on the non-stream path; a terminal `error` SSE frame on the stream path), while genuine 5xx/network/429 stay retriable 502s — honoring the never-freeze north-star.

fix(responses): finalize a streamed function_call with its full call_id + name + arguments so Codex actually runs the tool (#50 P2). The terminal `response.function_call_arguments.done` and `response.output_item.done` events (and the `function_call` item inside `response.completed.output`) were emitted with only `{type,id,status}` — missing `name` and `arguments`. Codex reads those terminal events to learn which shell command to run, so a nameless/argless call was silently skipped: every real Codex tool loop (`codex exec` writing a file, running a command) completed with no action. `ResponsesSSE` now retains each call's `callId`+`name` and emits the complete item on every terminal event, matching the OpenAI Responses spec. Verified end-to-end: `codex exec -s workspace-write` now writes the file through the proxy.

## v0.16.1 — 2026-07-02

Fix context editing still 413ing on long screenshot sessions: the cumulative image budget was 6MB — ABOVE Copilot's gateway HTTP entity limit, which was probed at exactly 5 MiB (a ~4.95MB body returns 400/accepted, a 5.00MB body returns 413). Because the budget sat above the wall, context editing believed an over-limit payload was "within budget" and forwarded it straight into a 413. Lower `IMAGE_PAYLOAD_BUDGET` to 3.5MB (≥1.5MB headroom under the 5 MiB wall for text, tool schemas, and JSON overhead). Also make `keep` a preference, not a hard floor: if the most recent 3 screenshots alone still exceed the budget, clearing now breaks through the floor (oldest-first, up to and including the newest) so the body always fits — a request that still 413s is strictly worse than one missing a recent screenshot. Adds a regression test that the budget stays below the probed gateway limit, a floor-break test, and an http-e2e assertion that the edited payload fits under 5 MiB.

## v0.16.0 — 2026-07-02

Context editing for images: clear old tool screenshots before they reach Copilot, fixing `413 Request Entity Too Large` (relayed as a 502) on long browser-harness / agentic sessions. A stateless wire re-sends the whole history every turn, so a loop that screenshots each step accretes base64 until Copilot's gateway rejects the request body at the HTTP layer — a byte-size limit that per-image downscaling alone can't satisfy. The worker now does what Anthropic's backend does server-side (`clear_tool_uses_20250919`): keep the most recent 3 tool screenshots at full fidelity and replace older ones with a placeholder once the cumulative image payload exceeds budget, oldest-first and only as much as needed. Runs on both the Anthropic and OpenAI send paths (and `count_tokens`, so the estimate matches what's sent). Also adds a 413 hint pointing the user at `/compact` / fewer images.

## v0.15.0 — 2026-07-02

Model picker: drive the 1M-context `[1m]` badge from each model's real upstream context window instead of a hardcoded id set, and generalise the friendly-name mapping to any Claude family + single- or two-segment version. Fixes `claude-sonnet-5` (was showing as a bare id with no 1M badge despite being a 1M model upstream) and makes any future 1M model render correctly with zero code changes. Inbound resolution and non-1M models (Opus/Sonnet/Haiku 4.5 at 200K) are unaffected.

## v0.14.2 — 2026-07-02

chore(package): drop README images from the npm tarball (reference them via GitHub raw URLs) — shrinks the published package from 288 kB to 67 kB

## v0.14.1 — 2026-07-01

fix(worker): only route to Copilot's Responses API when a model advertises it, and only send `reasoning_effort` to models that support it.

Two related upstream-routing bugs, both surfaced by the real-CLI e2e:

1. **Responses mis-routing.** A `/chat` 400 whose body matched the responses-only hint regex (`does not support …`, `invalid_request_body`) tripped the safety net into retrying on `/responses` — which is gpt-5-class only. For a Claude *or* gpt-4o turn that retry then 400'd ("model X does not support / is not supported via Responses API"), masking the real `/chat` error. The `/responses` route (primary and both 400 safety nets) is now gated on the live endpoint map positively listing `/responses` for the model, so only gpt-5.x / mai-code ever go there; every other model surfaces its true `/chat` failure.

2. **`reasoning_effort` sent to models that reject it.** `claude -p` defaults to gpt-4o and sends `effort=high`, but gpt-4o doesn't advertise `reasoning_effort` → every turn 400'd (`invalid_reasoning_effort`) — previously hidden behind bug 1. The adapter now gates the `/chat` `reasoning_effort` field on the model's advertised capability (from `/models`), defaulting to "send" only until discovery resolves so a supported model's reasoning turn is never silently dropped.

## v0.14.0 — 2026-07-01

Downscale oversized images before they reach Copilot, fixing `model_max_prompt_tokens_exceeded` (a 502 relayed to the client) when a large image is in play. Copilot's `/chat` has no vision tiler for Claude models — it bills an inline `data:...;base64,...` URL as plain text at ~char/4, so a single full-resolution image (~9MB base64 ≈ 2.3M tokens) overflows the model's prompt limit. The worker now takes over the job the real Anthropic backend does for us: decode → downscale → re-encode as JPEG, collapsing the payload before send.

The gate and the target are **bytes, not pixels** — because base64 length is exactly what Copilot bills. Images already under a per-image byte budget (~1.5MB) are forwarded byte-identical without even decoding (so small images cost nothing), and an over-budget image is downscaled to a 1568px edge AND stepped down through a JPEG quality/resolution ladder until the encoded result actually fits the budget. This closes the gap a pixel-only gate leaves open: a high-detail photo whose long edge is already within the cap but whose bytes are huge (the "I read a normal-looking image and still got a 502" case) is now shrunk too.

Crucially this covers images returned **inside a `tool_result`** (a Bash command or MCP tool that emits a screenshot) — the real-world trigger, where the image was previously flattened into the tool result's text string and so bypassed both resize and token counting entirely. `tool_result` now carries structured images end-to-end: preserved on the Anthropic/OpenAI inbound paths, downscaled + counted, and forwarded inline on the Copilot `tool` message (which Copilot accepts — probed). The Responses path, whose `function_call_output` can't carry an image, notes the omission instead of shipping raw base64.

Runs on every image path (`/anthropic/v1/messages`, `/openai/chat/completions`, `/openai/responses`) and in `count_tokens`, so Claude Code's context sizing and the actual request agree. `estimateTokens` also now counts image bytes at all (top-level and inside tool results); it previously ignored images, under-reporting by millions and letting the client ship an oversized prompt straight into the 502.

Performance is bounded: a text-only request costs ~0.04ms and an under-budget image ~0.002ms (byte short-circuit, no decode), so normal traffic is unaffected. A persistent oversized image in history — re-sent every turn, and hit by both `count_tokens` and `messages` — is decoded and re-encoded only ONCE: results are cached by content (LRU), turning a ~2s/turn cost into a first-turn-only cost (measured ~4.3s cold → ~45ms warm).

## v0.13.0 — 2026-06-30

feat(reasoning): extended thinking + reasoning-effort passthrough. A `thinking`-enabled Anthropic request (or an OpenAI `reasoning_effort`) now drives the model's reasoning, and the chain-of-thought streams back as a native Anthropic thinking block (thinking_delta + signature_delta) ahead of the answer — so Claude Code renders its thinking panel through the proxy. The signed continuation token (reasoning_opaque) round-trips across tool-call turns to preserve reasoning context. Effort is also forwarded on the /responses path for gpt-5 models. Verified end-to-end against live Copilot.

## v0.12.0 — 2026-06-30

feat(tui): LAN switch now shows paste-ready remote client config (Claude + Codex)

Switching `/network` to LAN used to dump the URL + key and a one-line "send it as
`Authorization: Bearer`" hint, leaving the user to hand-assemble each remote machine's config and
guess which slot the key goes in. The LAN success card now renders **paste-ready config blocks** for
both clients, with the key already in the correct place:

- **Claude** → `~/.claude/settings.json` `env` block (key in `ANTHROPIC_API_KEY`)
- **Codex** → `~/.codex/config.toml` provider block (key in `experimental_bearer_token`)

Blocks are built by a new pure helper (`tui/setup/remote-config.ts`) that reuses the same
`claudeCopilotReverseEnv` / codex-toml shape local `/setup` writes, so a remote config matches what
local setup produces — only the LAN host + real key replace loopback + the local placeholder. Each
block uses the model this machine has pinned for that client (falling back to sensible defaults) and
its real context window when known (Claude `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, Codex
`model_context_window`), so the remote client sizes context like the local one instead of assuming a
default ~200K window for a 1M model. If the LAN IPv4 can't be determined, the card falls back to a
`<this-machine-LAN-IP>` placeholder instead of crashing.

## v0.11.1 — 2026-06-30

fix(worker,supervisor): stop three recurring 502/crash failures behind `/doctor` and the daemon

- **EADDRINUSE crash loop → daemon "unhealthy"**: a forked worker no longer orphans when its
  supervisor dies abnormally (terminal closed/killed/crashed). The worker now exits on IPC
  `disconnect`, releasing `:7891` instead of squatting it so the next supervisor's worker can't
  bind. The supervisor's manual restart also waits for the old worker to fully exit before spawning
  the replacement, closing the kill/respawn race that hit the same `listen EADDRINUSE :7891`.
- **502 `Cannot read properties of undefined (reading 'message')`**: the Copilot adapter's non-stream
  `complete()` guards an empty `choices` array (a content-filtered turn or a 1-token ping) and
  returns an empty completion instead of throwing.
- **502 `Invalid 'max_output_tokens'` on responses-only models (e.g. gpt-5.5)**: `max_output_tokens`
  is clamped up to the Responses API minimum of 16, so `/doctor`'s 1-token ping (and Claude Code's
  connection probe) no longer 400s.

Docker HTTP e2e gains an EADDRINUSE regression block (orphaned worker releases its port when the IPC
parent drops; daemon stays `ready` through restart churn); new units cover the empty-choices guard,
the `max_output_tokens` floor, and the restart-waits-for-exit ordering.

## v0.11.0 — 2026-06-30

fix(tui): `/logs` and `/metrics` no longer shatter their bordered card when an upstream error carries newlines (a Copilot 502 returns a whole HTML page). Errors are flattened to a single line at the source (`errorDetail`) and again where the commands render them, and `OutputCard` now splits any multiline content into separate rows as a final backstop.

feat(doctor+dashboard): `/doctor` is now a real self-check and the web dashboard shows current data. `/doctor` reports GitHub login, worker liveness, the resolved web-search backend (copilot/webiq/unavailable), model discovery, and — on the on-demand TUI run — a per-configured-model connectivity ping (one real 1-token request per model the clients are actually set to use). The 2s dashboard poll uses the cheap upstream-free checks (`/api/doctor` without `?ping`), so it never burns quota. The dashboard is redesigned for parity with the TUI: it counts a runaway-tagged 200 as an error (shared `isError` rule, not just `status>=400`), and adds GitHub login, web-search backend, advertised models (with `[1m]` badges), and per-scope Claude/Codex client config panels via new `/api/clients` and `/api/models` endpoints.

fix(tui): `/metrics` now shows real totals instead of capping at the last 100 requests. The card aggregated a 100-row fetch, so once you crossed 100 requests it always read "100 reqs" and every derived number (errors, tokens, est. cost, per-model) was bounded to a meaningless sliding window. Metrics are now computed in SQL over the whole `request_log` via a new `/api/metrics` endpoint, and the card shows both **all-time** and **last 24h** rollups. As a bonus, `/logs`, `/report`, and the built-in assistant's `metrics`/`recent_errors` tools now read errors from a dedicated SQL query over the full table, so a failure that scrolled past the last-100-requests window still shows up.

The browser **dashboard** (served at `/` on :7890) had the same bug on its own surface: it derived totals from the capped `/api/requests` fetch, so it stuck at "total 100", and its "Recent requests" panel was a flat dump of the last 30 rows (for a healthy proxy, 30 identical `200`s — no signal). The dashboard now renders the `/api/metrics` SQL rollup: real **all-time + last 24h** totals and a **per-model breakdown** (reqs / errors / avg ms / tokens) replacing the flat dump. Recent errors come from the full-table SQL query, so failures past the last-100 window show here too.

Finally, a consistency pass across every surface that renders these metrics (the `/metrics` card, the `/metrics` + `/logs` slash commands, the dashboard, and the assistant's `metrics`/`recent_errors` tools): token-count and cost formatting are now a single shared `fmtTokens`/`fmtCost` (the assistant tool previously printed raw `39602000↑ $649.870` instead of `39602.0k↑ $649.87`), the assistant's `recent_errors` now flattens multi-line upstream bodies through `oneLine()` like the other surfaces, and the "no errors" empty state reads the same (`everything's green ✓`) everywhere.

Also fixes the **`/metrics` card flicker**: the 2s status poll re-read the config files and called `setStatus` with a fresh object every tick, which defeated React's bail-out and repainted the whole frame — and when the tall metrics card overflowed the terminal, Ink repainted with a full clear, so the card visibly flickered every 2 seconds even when nothing changed. The poll now compares the freshly-read status by value (`sameStatus`) and keeps the previous object when it's unchanged, so an idle tick produces zero re-renders. The worker/GitHub badges still update live on a real change.

## v0.10.1 — 2026-06-30

fix(tui): the "what's new" banner now shows **one line per recent version**, each surfacing that version's main change — instead of flattening all changes from the newest version (which let a single bundled release fill every slot). For a version that bundled several changesets it picks the headline change (a `feat`/`perf`, or hand-written prose, over a `fix`/`chore`; ties broken by length), so e.g. v0.9.0 shows the network access-modes feature rather than the release-plumbing fix.

## v0.10.0 — 2026-06-30

feat(tui): the startup "what's new" banner now shows the real recent headlines (top 3 across recent releases, version-tagged) instead of a generic "type /changes" pointer — so a freshly shipped feature is actually visible on launch rather than the banner looking empty. `/changes` now lists every change in a bundled release: `gen-changes` captures all paragraphs of each release (not just the first), so a headline feature merged alongside a plumbing fix is no longer hidden. Each release renders as a header with one bullet per change.

## v0.9.0 — 2026-06-30

fix(release): update CHANGELOG before the build so the just-released version appears in `/changes`. gen-changes.mjs runs in prebuild and reads CHANGELOG, but the workflow appended the new entry only after publish — so each release's own notes lagged one version behind. CHANGELOG is now written before build; changesets are still consumed after publish.

feat(tui): `/metrics` now renders a styled card — a colored summary row (reqs · errors · tokens↑↓ · est. cost) over an aligned per-model table — instead of flat gray lines. Numbers carry accent/state colors, labels are dimmed, models sort by request count.

feat(network): explicit access modes — **localhost** (default, loopback only — private to this machine) vs **LAN** (`/network` to enable). LAN exposes the worker proxy on the network and requires a key on every request **from another machine** — `Authorization: Bearer <key>` or `x-api-key` — rejecting a remote request without it (`401`) before any upstream call. Your own machine keeps working over `127.0.0.1` with no key, so local Claude/Codex need no change when you flip to LAN (the local-vs-remote decision is TCP-layer only, never a spoofable header). It's **fail-closed**: enabling LAN auto-generates a key (no keyless LAN), and a remote request is refused (`503`) if a key ever goes missing — never an open relay. The key (timing-safe compare) is read per request, so rotation needs no restart; flipping the mode restarts the worker to rebind the socket. The supervisor control plane stays on localhost regardless. New `/network` panel, a `/config` row, and a `net` HUD indicator.

## v0.8.0 — 2026-06-29

Map Copilot model ids to the canonical ids Claude Code's native /model picker recognises, so models show friendly names and the 1M-context badge instead of bare ids. Outbound, `/anthropic/v1/models` dashes claude ids (`claude-opus-4.8` → `claude-opus-4-8[1m]`) and tags opus 4.6/4.7/4.8 + sonnet 4.6 as 1M; setup's default ANTHROPIC_MODEL is dashed the same way so the picker matches it; inbound, requests resolve back to the real Copilot model. GPT/o3 pass through unchanged.

## v0.7.0 — 2026-06-29

feat(tui): `/metrics` now reports token usage (in/out) and an estimated cost per model and overall — the worker records prompt/completion tokens for every request (persisted in SQLite), and cost is a list-price estimate (Copilot is flat-fee). User messages also get a highlighted bar in the transcript so they stand out from muted system notes and assistant output.

## v0.6.0 — 2026-06-29

feat(tui): add a `/changes` command listing the 10 most recent releases (version, date, summary) with a link to the full CHANGELOG, and refocus the startup "what's new" banner on important messages — it now points to `/changes` instead of advertising a bug fix, and still self-suppresses after 3 launches.

## v0.5.5 — 2026-06-29

ci: gate PRs on a changeset. A pull request with no file in `.changes/` now fails the `changeset` check, so merges can't silently skip the release (the v0.5.3 freeze). Docs/test-only PRs opt out with a `no-changeset` label.

## v0.5.4 — 2026-06-29

fix(worker): stop the empty-tool-call loop ("call: call: call:…") that froze sessions. Inline-XML blocks that recover no tool are now passed through verbatim instead of silently swallowed; nameless `function_call` items on the /responses path are dropped instead of streamed as a blank `call:`; and the runaway deadline now covers tool-call streams, not just text — a model looping on tool calls is cut cleanly instead of relaying forever.

## v0.5.3 — 2026-06-29

Fix inline tool-call XML (`<invoke name=…>`) leaking as literal text instead of running. The extractor that recovers these blocks only ran on the chat path when the request declared tools, and never on the Codex `/responses` path. It now runs always-on across both streaming and non-stream paths, so a follow-up turn or a `/responses` model can no longer dump raw XML into the reply.

## v0.5.2 — 2026-06-29

Fix the daemon going permanently dead during dogfooding. The worker had no `unhandledRejection` handler, so a stray floating rejection silently killed it (exit 1, empty stderr) on Node ≥15; once that happened 5×/60s the supervisor marked it `unhealthy` and gave up forever, leaving a running daemon with a dead worker. The worker now handles `unhandledRejection`, writes the cause to stderr *before* the IPC report (so crashes are no longer blind), the supervisor persists each crash to `crash.log`, and `unhealthy` now recovers: after a 30s cooldown it resets the window and tries again instead of staying down.

## v0.5.1 — 2026-06-28

Fix the app dropping back to the shell during concurrent use. The TUI and supervisor share one process, but several synchronous throw sites had no handler — most importantly an SSE write to a client socket that died between broadcasts (likely with multiple clients connected), which crashed the whole process. Each broadcast listener is now isolated and a dead SSE connection is dropped instead of retried; `readGhToken` returns null on a corrupt/locked read instead of throwing on the heartbeat tick; and a process-level backstop logs any remaining stray throw/rejection to `~/.copilot-reverse/crash.log` and keeps the TUI alive.

## v0.5.0 — 2026-06-28

Add a GitHub-token heartbeat: the supervisor now re-checks every ~60s whether the stored GitHub login still works, and the TUI footer shows a live `github ✓` / `✗ /login` badge — so an expired or revoked login surfaces within ~60s instead of only on the next failed request or a manual `/status`. A transient network/rate-limit hiccup is distinguished from a real auth failure, so the badge never flips on a single blip.

## v0.4.0 — 2026-06-26

Codex `/responses` support, web search via Microsoft Web IQ, and a tool-call recovery fix:

- **Codex**: implement the OpenAI Responses API (`POST /openai/responses`) so Codex (which dropped `wire_api="chat"`) connects. Responses-only models (gpt-5.5, gpt-5.3-codex, …) are auto-routed via each model's `supported_endpoints` with a `/chat` 400 fallback. Codex's native `web_search` runs server-side on Copilot with citations.
- **Web search**: routed through Microsoft Web IQ. Set the key with `/webiq` (get one at https://webiq.microsoft.ai/profiles/); `/webiq clean` clears it. With no key, the tools return a message pointing to `/webiq`. A keyless gpt-5-mini "borrow" backend exists behind a flag but is disabled by default (gpt-5-mini is currently congested on Copilot; Web IQ is sub-second). Status card + HUD show the active backend.
- **Fix**: recover tool calls whose `antml:`-namespaced `<invoke>` sentinel is split across stream chunks (previously leaked as literal text).

## v0.3.0 — 2026-06-26

Restore `web_search` and `web_fetch` for Claude Code through the gateway: the worker now runs these tools internally against Microsoft Web IQ in a transparent agentic loop, and a new `/web-search-support` command stores the WebIQ API key.

## v0.2.1 — 2026-06-25

Fix `/login` hanging with no output: the device-code prompt is now shown immediately while authorization is pending, instead of being buffered behind the blocking token poll.

## v0.2.0 — 2026-06-23

Recover tool calls that some models emit as inline XML text into structured tool calls, and add changeset-driven automatic versioning + npm publish on merge to master.


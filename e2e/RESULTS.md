# E2E results

Latest run of the end-to-end suite. Regenerate after every code change with `npm run test:e2e`
and update this file (paste the summary).

- **2026-08-13 (fleet control plane — M1 tracer bullet)** — the first end-to-end slice of the control
  plane: `cc-fleet hub` serves a hand-written `profile.json`, `cc-fleet join` enrolls a machine with a
  pre-shared token, and a skill edited on the hub lands on the node's disk seconds later. Apply is
  full-takeover over `~/.claude/skills` only, with a complete backup taken before every mutation (and
  none taken for a no-op, so a reconnect storm cannot flush the 10-slot rollback window) plus
  `cc-fleet restore` for local rollback. `control/` imports nothing outside itself — enforced by a test
  that scans every import specifier, not by convention — so the whole plane runs with no tunnel, no
  GitHub login and no Copilot subscription. Verification: **869/869 full Vitest tests**,
  **65/65 Vitest E2E** (10 new control cases CF-01…CF-10 over real HTTP on an ephemeral port),
  TypeScript build clean. Manually driven for real through the CLI in two processes with separate
  `USERPROFILE`/`CLAUDE_HOME` roots: unauthenticated `GET /control/events` → `401`, enrol → skill
  written, a pre-existing unmanaged skill deleted **and** recovered from the backup, `CLAUDE.md` left
  untouched, a live `profile.json` edit applied within ~3s (`applied v2 (+2 / -0)`), and
  `cc-fleet restore` rolling the node back. That manual run also surfaced a duplicate `fs.watch` event
  fanning a redundant publish to the whole fleet; the store now compares file content and stays quiet
  when a save changed nothing. No Docker case: `control/` is not mounted on the supervisor yet, so the
  existing http-e2e harness (worker + supervisor) has nothing to assert against — coverage lands with
  M2. Real CLI Docker e2e **could not run in this environment**: `npm ci` inside the container fails at
  `registry.npmjs.org` with `ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE` (corporate TLS interception — the
  container has no corp root CA; the host resolves the same package fine). Confirmed **pre-existing and
  unrelated to this change**: the identical failure reproduces with `master`'s `package.json` +
  `package-lock.json` in a bare `node:22` container. The gate still needs a run on a network without
  TLS inspection, or an image that trusts the corp CA, before this branch merges.

- **2026-08-05 (opt-in Claude model map for GPT-only Copilot accounts)** — `/claude-map on|off`
  persists an explicit default-off compatibility mode. When enabled, Anthropic discovery retains the
  real GPT rows and adds only native Claude aliases whose exact GPT targets are live; alias requests
  resolve before provider selection, so endpoint/reasoning/context capabilities and metrics use the
  actual GPT backend. Missing targets are hidden and OpenAI/Codex discovery is unchanged. Verification:
  **742/742 full Vitest tests**, **55/55 Vitest E2E**, TypeScript build clean; Docker HTTP edge E2E
  **76/76 passed**; real Docker CLI E2E against live Copilot **0 FAIL (`✅ ALL PASSED`)**, including
  Claude Code 2.1.220 discovery of `claude-opus-5[1m]`, a real `claude -p` turn through
  `gpt-5.6-sol`, multi-turn resume, tools, effort, image transport, and Codex regressions (**34/34 recorded checks passed**). Optional OCR
  and latest-image colour-quality assertions record SKIP under mapped GPT vision; request validity and
  no-413 guards remain hard PASS gates. Follow-up setup regression coverage proves `/setup-claude`
  renders the same `Claude → GPT` labels and writes the native Claude alias (not the backend id), while
  enabling the map heals an unavailable persisted TUI model to the first live alias.

- **2026-07-03 (context editing DYNAMIC budget + reactive 413 retry — issue #52 follow-up)** — issue #52
  showed the 413 returns when a screenshot-heavy session ALSO carries a large conversation. The 413 is on
  the whole request body, but context editing budgeted only image bytes against a fixed 3.5MB cap — so a
  ~700k-token transcript (~2.7MB text) + 3 kept screenshots (~3.15MB) ≈ 5.9MB still blew the 5 MiB wall.
  Fix: the image allowance is now DYNAMIC — `GATEWAY_ENTITY_LIMIT (5 MiB) − SAFETY_MARGIN − nonImageBytes`,
  capped by the fixed budget for the common small-text case. Verified on issue #52's exact 9 images: 343k
  text → keep 3 (4.46MB), 500k → keep 2 (4.04MB), 700k → keep 1 (3.79MB), 900k → keep 0 (3.43MB) — always
  under the wall. Plus a REACTIVE fallback: if the gateway still 413s, force-clear every screenshot and
  retry once (streaming path retries on the first-pull 413 before any content_block is written; non-stream
  wraps the complete() call) instead of relaying a 502. New unit tests (dynamic budget across text sizes,
  `forceClearAllScreenshots`, `is413Error`, and end-to-end reactive-retry through the Express app for both
  stream and non-stream) + an http-e2e assertion that big-text + screenshots fits under 5 MiB. 604 unit
  tests green; docker http-e2e ALL PASSED (68); `tsc` clean.
- **2026-07-03 (#50 P2 — codex tool loop + vision OCR: cli-e2e goes all-green)** — the two remaining
  real-CLI reds from #50 are resolved, and the matrix grew 4 new cases. **Full real-CLI docker e2e vs
  live Copilot: 31 PASS / 0 FAIL / 2 SKIP (`✅ ALL PASSED`)** — the 2 skips are graceful degradation
  (web_search needs a WebIQ key not mounted). Combined with #50 P1 (unknown-model fast-fail), the entire
  cli-e2e matrix is green. New cases added, all passing live: **codex multi-step tool loop** (create →
  read back, proving `function_call_output` feeds the next turn, not just a single shot) and **codex
  unknown-model fast-fail** (the /responses side of the never-freeze north-star — a typo'd Codex model
  returns bounded, rc≠124, never hangs).
  - **Codex tool loop (real proxy bug, fixed).** `codex exec -s workspace-write "create a file …"`
    completed with the file never written. Root cause isolated by capturing the live `/responses`
    stream: the model DID emit a `shell_command` function_call, but our terminal events —
    `response.function_call_arguments.done`, `response.output_item.done`, and the `function_call` inside
    `response.completed.output` — carried only `{type,id,status}`, **dropping `name` and `arguments`**.
    Codex reads those terminal events to learn which command to run, so a nameless/argless call was
    silently skipped. Verified against the OpenAI Responses reference (Context7): each must carry the
    COMPLETE call. `ResponsesSSE` now retains each call's `callId`+`name` and emits the full item on
    every terminal event. **Verified end-to-end: `codex_proof.txt` is now written with `CODEX_TOOL_OK`
    and codex replies `DONE`.** New strict unit test asserts all three terminal events carry
    call_id+name+arguments (the old test only checked event-type strings were present — which is how the
    gap shipped).
  - **Vision OCR (test-fixture bug, not a proxy bug).** Both fixtures 400'd with `validating image item:
    image media type not supported`. Direct upstream probing (real token) proved: the EXACT Jimp fixture
    sent to a **Claude** model returns its baked token (`VISION7`) — vision + our media type are healthy —
    but Copilot's **gpt-4o rejects ANY inline image** (PNG and JPEG alike) with that exact string. The
    vision case was running under the default `ANTHROPIC_MODEL=gpt-4o`, which has no image entitlement.
    Fix is in the test: pin the vision case to `claude-sonnet-4.6` (a real user doing OCR picks a
    vision-capable model). No proxy change needed.
  - **Unit + vitest e2e: 639/639 green** (adds the strict ResponsesSSE terminal-event test).

- **2026-07-03 (unknown-model fast-fail — fixes #50 P1 90s freeze)** — a typo'd / unknown model id hit
  an upstream 400 (`model_not_supported`, confirmed <1s upstream by direct probe), but the worker masked
  EVERY non-auth error as a retriable **502 / `api_error`** in all three request handlers. A client that
  retries a 502-class error (Claude Code, the Anthropic SDK) backed off to its **90s turn timeout and
  froze** (`rc=124`) — the exact never-freeze north-star violation. Fix: the adapter now throws a typed
  `UpstreamError(status, …)` at every non-ok throw site, and a shared `classifyError` maps a **permanent
  4xx** (not 429/408) to a **terminal** surface — HTTP **400** + `invalid_request_error` on the Anthropic
  path (both non-stream body and the stream `error` SSE frame) — so the client fails fast; genuine
  5xx/network/429 stay retriable 502s. The OpenAI/Responses paths keep their flat `{type:"error"}` shape
  (Codex's contract) and fast-fail via the **status code** only. **Unit + vitest e2e: 638/638 green**
  (adds adapter `UpstreamError`/`isTerminalUpstream` coverage + 3 anthropic-server cases: terminal 4xx →
  invalid_request_error SSE, non-stream 400 not 502, retriable 5xx stays 502/api_error). **HTTP edge
  docker e2e: hermetic gate 64/64 green**; real-token golden adds 4 #50 assertions — `unknown model →
  terminal 400 (not 502)`, `→ invalid_request_error type`, `fast-fails <15s`, `(stream) → terminal
  invalid_request_error frame` — **all PASS**. **Real-CLI docker e2e (real token): the #50 P1 cases now
  PASS** — `unknown-model rc=1 is_error=true` (returned fast, was `rc=124` hang) → `unknown model returns
  (did not hang to timeout)` + `unknown model surfaces a bounded error`. The 3 remaining FAILs (codex
  tool loop, 2× vision OCR `image media type not supported`) are the **pre-existing P2s #50 documents as
  out-of-scope** — same failures on master, distinct code paths, upstream/entitlement causes; this change
  neither touches nor regresses them (it does make the vision 400 surface as a clean terminal 400 rather
  than a masked 502).

- **2026-07-03 (context editing budget FIX — the 413 came back)** — the context-editing fix still 413'd
  on real long screenshot sessions. Root cause: `IMAGE_PAYLOAD_BUDGET` was 6MB, but Copilot's gateway
  HTTP entity limit was never measured — I PROBED it at exactly **5 MiB** (5,242,880 bytes): a ~4.95MB
  body returns 400 (accepted, model-name-only error), a 5.00MB body returns 413. Because the 6MB budget
  sat ABOVE the 5 MiB wall, context editing believed an over-limit payload was "within budget" and
  forwarded it straight into a 413. Two fixes: (1) lower the budget to **3.5MB** (≥1.5MB headroom under
  the wall for text/tools/JSON); (2) make `keep` a PREFERENCE not a hard floor — if the most recent 3
  screenshots alone exceed budget, clearing now breaks through the floor oldest-first (up to and
  including the newest), since a body that still 413s is strictly worse than one missing a recent shot.
  New tests: budget-below-gateway-limit regression, floor-break behavior, an http-e2e assertion that the
  edited payload (tokens×4 bytes) fits under 5 MiB, and a strengthened real-CLI case #16 — 10 high-entropy
  noise screenshots (~0.95MB each, **~9.5MB unedited**, over the wall) posted to live Copilot must not
  413 AND Claude still reads the most-recent green screenshot. (The pre-fix 6MB budget would have left
  ~6MB and still 413'd this.) 597 unit tests green; docker http-e2e ALL PASSED (67); `tsc` clean.

- **2026-07-02 (context editing — fixes `413 Request Entity Too Large` (relayed 502) on long
  browser-harness / agentic sessions)** — a browser-harness loop emits one screenshot per step, and the
  stateless wire re-sends the WHOLE history every turn, so cumulative base64 grows until Copilot's
  gateway rejects the request body at the HTTP layer (a byte-size limit, distinct from the token limit
  the image-downscale fix targets — per-image resize alone can't satisfy it). The real Anthropic backend
  handles this server-side via context editing (`clear_tool_uses_20250919`): keep the most recent few
  tool results, replace older ones with a placeholder. Claude Code relies on it and keeps sending the
  full history; Copilot has no such layer. We now sit where that layer would: new `core/context-edit.ts`
  keeps the most recent 3 tool screenshots at full fidelity and, once the cumulative image payload
  exceeds a ~6MB budget, clears older ones oldest-first (image → placeholder text) and only as much as
  needed — lossless no-op when under budget, and it never touches top-level (user-attached) images, only
  tool results. Wired AFTER resize on all send paths (`/anthropic/v1/messages`, `/openai/chat/completions`,
  `/openai/responses`) AND `count_tokens`, so the estimate matches what's sent. Also adds a 413
  `errorHint` (`request too large — /compact or send fewer/smaller images`). New unit suite
  `tests/core/context-edit.test.ts` (7 cases: no-op under budget, keep-floor, oldest-first, minimal
  edit, multi-image unit clear, top-level untouched, idempotent) + a 413 hint case + a hermetic http-e2e
  check (12 accumulated screenshots, each under the per-image cap, `count_tokens` lands far below the raw
  sum — proving clearing, not resizing). Plus a **real-CLI docker case**: an 11-screenshot browser-loop
  history posted to live Copilot never 413s AND Claude still reads the most-recent (green) screenshot —
  proving old cleared, recent kept, end-to-end. 588 unit tests green; docker http-e2e ALL PASSED (63);
  `tsc` clean. (The same real-CLI run shows the 5 pre-existing FAILs documented in the PR #48 entry
  below — codex tool loop, 2× vision OCR, 2× unknown-model — untouched by this change.)
- **2026-07-02 (capability-driven 1M badge + generalised model names — PR #48)** — the picker's `[1m]`
  badge now follows each model's real upstream context window (`fetchModelOneMSupport`, injected into
  `toCanonical` as an `is1M` oracle) instead of a hardcoded set, and the friendly-name regex accepts any
  Claude family + single- OR two-segment version. Fixes `claude-sonnet-5` (was a bare id with no badge
  despite being 1M upstream). **Unit + vitest e2e: 632/632 green. HTTP edge docker e2e: 64/64 green**
  (adds `sonnet-5 present / friendly "Sonnet 5" / [1m] badge` on the hermetic gate). **Real-CLI docker
  e2e (real token):** the two new sonnet-5 cases PASS — `picker advertises sonnet-5 with friendly name`
  and `canonical sonnet-5 [1m] id resolves to Copilot + answers` (a real `claude -p` turn). The run also
  shows 5 FAILs (codex tool loop, 2× vision OCR `image media type not supported`, 2× unknown-model 90s
  timeout) — **these are pre-existing and unrelated to this change: a from-scratch `master` (de42276)
  baseline run reproduces the exact same 5 failures**, all in cases this PR never touched, all pointing
  at upstream/environment (Copilot 400 on images, upstream latency on an invalid id, codex tool loop).
  This change adds only passing coverage; it introduces no new failures.

- **2026-07-01 (image downscale — fixes `model_max_prompt_tokens_exceeded` 502 on pasted/tool images)**
  — a large image came through as a multi-MB base64 data URL that Copilot's `/chat` bills as PLAIN TEXT
  (~char/4, it has no vision tiler for Claude models), so one ~9MB image ≈ 2.3M tokens overflowed the
  model's prompt limit and the upstream 400 relayed as a 502. Confirmed by inspecting the real
  `generate-readme-cover-images` session: the culprit was a 3.13MB PNG returned **inside a Bash
  `tool_result`**, which was being flattened into the tool result's text string — invisible to token
  counting and untouched by resize. We now take over the job the real Anthropic backend does for us: a
  new `core/image-resize.ts` decodes → downscales to a 1568px long edge → re-encodes JPEG (jimp),
  collapsing a high-entropy image ~6x (measured: 2.88M→486K tokens on a 1800×1200 noise PNG). The gate
  and target are BYTES, not pixels (base64 length is what Copilot bills): images under a ~1.5MB
  per-image budget are forwarded byte-identical without decoding, and an over-budget image is
  downscaled AND stepped down a JPEG quality/resolution ladder until it actually fits — closing the gap
  where a high-detail photo already within the pixel cap (a "normal-looking" read image) still 502'd.
  Images returned inside a `tool_result` are now preserved structurally end-to-end (Anthropic + OpenAI
  inbound → resize + count → forwarded inline on the Copilot `tool` message, which Copilot accepts —
  probed live). Wired into all image paths (`/anthropic/v1/messages`, `/openai/chat/completions`,
  `/openai/responses`) AND `count_tokens`, so Claude Code's context sizing matches the request actually
  sent. `estimateTokens` now counts image bytes at all — top-level AND inside tool results (it
  previously ignored images, under-reporting by millions). A persistent oversized image (re-sent every
  turn, hit by both count_tokens and messages) is decoded once and cached by content — ~4.3s cold →
  ~45ms warm — so it's not re-encoded every turn; text-only requests cost ~0.04ms. New unit suite
  `tests/core/image-resize.test.ts` (11 cases incl. the tool_result path, the within-edge-but-heavy
  byte-gate case, and the content cache) + anthropic-inbound/adapter/tokens coverage + three hermetic
  http-e2e checks (a large image, one nested in a tool_result, and a within-edge heavy image, all
  proving `count_tokens` lands far below raw base64). 612 unit/integration tests green; docker http-e2e
  ALL PASSED (61); `tsc` clean.


- **2026-06-30 (effort actually works — output_config.effort + observability header, #33)** — a live
  capture of Claude Code 2.1.195's real wire showed modern clients send a TOP-LEVEL
  `output_config: { effort }` with `thinking: {type:"adaptive"}` and NO `budget_tokens`; the initial
  impl only read `thinking.budget_tokens`, so switching effort was a silent no-op (every level collapsed
  to a fabricated `medium`). New `resolveReasoning(output_config, thinking)` reads the effort the user
  actually picked (precedence: disabled→off; output_config.effort; legacy budget; else none). The proxy
  now echoes the resolved effort in an `x-copilot-reverse-effort` response header — real observability
  (`curl -i` shows the applied effort) and the deterministic, quota-free signal the e2e asserts on
  (output length can't be — upstream surfaces reasoning non-deterministically). Hermetic http-e2e checks
  all five levels + legacy budget map + plain-turn-no-header; cli-e2e adds the modern-wire header matrix
  over real HTTP plus `claude --effort max/low` proving the real CLI knob drives a working turn. 596
  unit/integration tests green; `tsc` clean.

- **2026-06-30 (extended thinking / reasoning channel, #33)** — added a reasoning axis end-to-end:
  `thinking`/`reasoning_effort` inbound → `reasoning_effort` (chat) / `reasoning: {effort}` (responses)
  upstream → `reasoning_text`/`reasoning_opaque` deltas parsed → native Anthropic thinking blocks
  (`thinking_delta` + `signature_delta`) relayed ahead of the answer, with the opaque continuation token
  round-tripping across tool turns. New hermetic cases **EP-19b** (thinking stream → thinking block @0
  before text @1) and **EP-19c** (client thinking budget → canonical effort reaches the provider); a
  docker http-e2e golden case (real Claude round-trip → native thinking block over the socket); and a
  live integration guard. Both real-upstream tests RETRY across attempts and assert reasoning on a turn
  that reasons, because the upstream surfaces `reasoning_text` non-deterministically (~3/5 runs) — the
  answer is always asserted, a no-reasoning run degrades to a note. `tsc` clean.

- **2026-06-30 (502/crash triage: empty choices, max_output_tokens floor, EADDRINUSE orphan)** — three
  independent failures the user hit in a real Claude session, all surfacing in the dashboard error log.
  (1) The daemon wedged **unhealthy** under a `listen EADDRINUSE :7891` crash loop: a forked worker
  doesn't die when its supervisor dies abnormally, so an orphan kept holding `:7891` and every respawn
  failed to bind. Fixed with a worker IPC-`disconnect` guard (orphan exits, frees the port) plus a
  supervisor `restartManually()` that waits for the old worker's `exit` before spawning (closes the
  kill/respawn port race — the reason a manual `restart` could itself trigger the conflict). (2) A
  non-stream Copilot 200 with an **empty `choices`** array threw `Cannot read properties of undefined
  (reading 'message')` → 502 (the `/doctor` ping path); the adapter now treats it as an empty
  completion. (3) Responses-only models (gpt-5.5) 400'd on the `/doctor` 1-token ping because the
  Responses API requires `max_output_tokens ≥ 16`; we clamp the floor. New units: empty-choices guard
  (adapter), `max_output_tokens` floor (responses body), restart-waits-for-exit ordering (monitor
  lifecycle); the fake worker mirrors the real `disconnect` guard. Docker HTTP e2e gains an EADDRINUSE
  regression block (fork the real worker with an IPC channel, drop the channel, assert the port is
  released; daemon stays `ready` through restart churn) — validated against the real `dist/worker`
  on-host (Docker daemon was down). Full suite **550 passed** (65 files), build clean.

- **2026-06-30 (/metrics real totals, no 100-row cap)** — `/metrics` aggregated a 100-row `/api/requests`
  fetch, so `total` was `min(rows, 100)` — "100 reqs" was a display ceiling, and errors/tokens/cost/
  per-model were all bounded to a meaningless sliding window. Now rolled up in SQL over the WHOLE
  `request_log`: new `aggregateRequests(db, sinceMs?)` + `recentErrorRows(db, limit)`, a new
  `/api/metrics` endpoint serving `{all, day, recentErrors}`, and `withCost()` to add list-price cost in
  the TUI. The card shows **all-time + last 24h**. `/logs` and `/report` also switched to the dedicated
  SQL error query, so a failure that scrolled past the last-100-requests window still shows. The
  assistant's own `metrics` / `recent_errors` SDK tools were moved onto the same `/api/metrics` rollup,
  so the agent reports the same real totals the card does (not a capped `requests()` fetch). The browser
  **dashboard** (`/` on :7890) had the bug on its own surface too — it derived totals from the capped
  `/api/requests` fetch (stuck at "total 100") and its "Recent requests" panel was a flat dump of 30
  identical 200s; it now renders the `/api/metrics` rollup (all-time + 24h totals + a per-model
  breakdown), errors from the full-table SQL query. A consistency pass unified token/cost formatting
  across every metrics surface (card, /metrics, /logs, dashboard, assistant tools) behind shared
  `fmtTokens`/`fmtCost`, routed the assistant's `recent_errors` through `oneLine()`, and aligned the
  empty-state wording. New units:
  `db` aggregate/error-rows (4), `withCost` (2), shared `fmtTokens`/`fmtCost` (2), api `/api/metrics`
  all-time+day (2), dashboard real totals + per-model + runaway-200 via `/api/metrics` (2); fixtures
  updated to the server-shaped `MetricsResponse`. HTTP docker e2e gained 4 checks (insert >100 rows into
  the supervisor's own DB, assert `/api/metrics` total>100, day≤all, a pre-100 failure surfaces, and the
  dashboard HTML wires to `/api/metrics` not the capped `/api/requests`) — **30 passed** (was 26). Full
  suite **489 passed** (62 files), build clean.

- **2026-06-29 (/doctor self-check + dashboard parity)** — `/doctor` graduated from 2 checks
  (github-auth, worker) to a real self-check: GitHub login, worker, resolved web-search backend
  (copilot/webiq/unavailable), model discovery, and — on the on-demand TUI run (`?ping=1`) — a real
  1-token connectivity ping per client-configured model. The check logic is a pure injected-probe
  function (`buildDoctorChecks`) so it's fully unit-tested; the 2s dashboard poll uses the cheap
  upstream-free path so it never burns quota. Two code-review fixes landed before merge: the light
  github-auth check reuses the heartbeat's CACHED status (a fresh GitHub token exchange every 2s would
  trip GitHub's rate limit — the heartbeat runs on 60s for exactly this reason; the live exchange is
  reserved for the on-demand `?ping` run), and `pingViaProxy` got a 20s AbortController timeout so a
  hung upstream fails fast instead of blocking `/doctor` for minutes. The dashboard was redesigned for
  parity with the TUI: errors now count `status>=400 || error!=null` (shared isError — runaway-tagged
  200s show, the old dashboard silently dropped them), plus new GitHub-login, web-search,
  advertised-models (`[1m]` badges), and per-scope client-config panels via new `/api/clients` +
  `/api/models`. New units: `doctor` (9, incl. live-vs-cached flag), `doctor-probes` (7, incl. timeout),
  api (`/api/clients`, `/api/models`, `?ping` passthrough, models degrade-to-empty), dashboard parity.
  HTTP docker e2e gained 6 checks (web-search + models named checks, light has no per-model ping,
  `?ping` returns, clients/models endpoints) — **26 passed** (was 20). Full suite **477 passed**
  (62 files), build clean.

- **2026-06-29 (/logs card multiline fix)** — A Copilot 502 returns a whole HTML error page; its
  ~400-char body (newlines + inline styles) was stored as the request's metric error and rendered by
  `/logs` as one "line" inside a bordered Ink card, so the embedded newlines mis-measured the Yoga box
  and the border bled across the screen. Fixed at three layers: a new `oneLine()` formatter collapses
  any whitespace run (newlines/CR/tabs) to single spaces + truncates; `errorDetail` (adapter) applies
  it at the source so the *stored* upstream error is already one line; `/logs` and both `/metrics`
  paths re-flatten where they render; and `OutputCard` now explodes any multiline line into separate
  rows (`cardRows`) as a final backstop. New units: `oneLine` (format), `cardRows` (app), an adapter
  502-HTML test, two slash `/logs`+`/metrics` flatten tests. HTTP docker e2e gained a real check: drive
  a failing request → read the real stored metric → render it through the real `dist` formatter → assert
  no newline (**20 passed**, was 18). Full suite **454 passed** (60 files), build clean.

- **2026-06-30 (LAN exempts loopback — only remote needs the key)** — Refined the LAN gate: a request
  is challenged for the key ONLY when it arrives from off-box. Requests over loopback
  (`127/8`, `::1`, `::ffff:127.x`) are always served unauthenticated, in both modes — so the user's own
  on-machine Claude/Codex keep working with no key when they flip to LAN; only genuinely remote callers
  must present it (missing/invalid → 401, no-key-configured → 503 fail-closed). The local-vs-remote
  decision is TCP-layer only (`req.socket.remoteAddress`), never a spoofable header (`X-Forwarded-For`
  etc.) — `express` `trust proxy` stays off and the socket address is read directly. New pure
  `isLoopbackAddr` (handles IPv4-mapped-IPv6, fail-safe on unknown → non-local) with 6 unit cases;
  `requireAccess` takes an injectable `isLocal` so tests simulate a remote peer. `http-e2e.mjs` now
  splits the matrix: loopback checks assert local-is-exempt; the full remote key matrix (401/401/
  same-length-401/200×2/oversized-401/503 + a loopback-still-open contrast) runs over the container's
  LAN IP in the bind-boundary block. Suite **481 passed**, build clean.

- **2026-06-29 (network access modes)** — New explicit access posture (#25): `localhost` (default,
  loopback only — behavior unchanged, now a named mode) vs `lan` (worker proxy binds `0.0.0.0`, every
  request must carry a key or it's rejected `401` before any upstream call). The supervisor control API
  (:7890) stays loopback always — the control plane is never exposed. Auth is a minimal shared key
  (timing-safe; `Authorization: Bearer` or `x-api-key`), read lazily so rotation needs no restart; the
  bind change is applied by restarting the worker. **Fail-closed**: entering LAN mints a key if none
  exists (the store refuses keyless LAN), and the gate refuses all requests (`503`) if LAN is ever
  active with no key. As defense-in-depth the gate ALSO requires a key whenever the worker is bound to
  a non-loopback interface (`exposed`), regardless of what the mode file momentarily says — closing the
  fail-open window on a lan→localhost switch (the socket stays on `0.0.0.0` until the restart rebinds).
  New `src/shared/network.ts` + `workerBindHost`, `src/worker/auth.ts` (mounted
  before the body parser, `/healthz` stays open), a `bindHostProvider` in `WorkerMonitor`, and a
  `/network` TUI panel (+ `/config` row, HUD `net` indicator). Covered by network-store, worker-auth
  (incl. the `exposed` backstop + a same-length-key check for the constant-time compare),
  monitor-lifecycle (bind host echoed), and TUI-interaction unit tests, plus access-mode HTTP
  edge-case checks in `http-e2e.mjs` (gate-before-body-parser: a keyless oversized body → 401 not 413;
  and a **bind-boundary** probe — a 127.0.0.1-bound worker is raw-TCP **refused** on the container's
  LAN IP while a 0.0.0.0-bound one is reachable there but still 401s keyless, proving localhost is
  "can't even connect", not just unauthorized). Suite **472 passed**, e2e **43 passed**, build clean.

- **2026-06-29 (canonical model ids)** — `/anthropic/v1/models` now maps Copilot's dotted ids to the
  dashed canonical ids Claude Code's native picker recognises (`claude-opus-4.8` → `claude-opus-4-8[1m]`,
  friendly display, `[1m]` for opus 4.6/4.7/4.8 + sonnet 4.6); inbound `resolveModel` strips `[1m]` and
  fuzzy-maps back to the dotted Copilot id. setup's default ANTHROPIC_MODEL also goes through the canonical
  map (was dotted `claude-opus-4.8[1m]` → picker couldn't match → stuck on "Opus 4 1M"). New
  `model-canonical` unit + router round-trip; HTTP e2e asserts no dotted ids leak + opus carries `[1m]`;
  CLI e2e drives the real `claude` through `claude-opus-4-8[1m]` AND the setup-default model. Suite
  **433 passed**, HTTP e2e **18 passed**, CLI e2e **all passed**, build clean.

- **2026-06-29 (native /model picker)** — setup writes CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
  so Claude Code populates /model from our /anthropic/v1/models; ANTHROPIC_MODEL[1m] stays the 1M
  default and does NOT lock the picker (verified vs docs). Reset clears the new key. Picker lists
  claude* ids; CC >=2.1.129. Project suite **422 passed**, e2e **43 passed**, build clean.

- **2026-06-29 (TUI UX batch)** — Status shows per-scope client model (not just a check); chat
  setup tools require scope+model (ask before write); added recent_errors/metrics chat tools for
  command parity; /report body restructured to the #5 template; heartbeat interval configurable;
  versioned "what's new" banner shown ~3 launches. Project suite **421 passed**, e2e **43 passed**, build clean.

- **2026-06-29 (runaway → /report)** — A guard trip now finishes 200 but tags the metric with a
  runaway reason (repetition/max_output/deadline) on all three backends. `recentErrors`/`aggregate`
  treat any tagged 200 as an error, and `/report` builds a "Stream runaways" section + a dedicated
  title so users file a prefilled issue (like #5) when a model degenerates. New unit tests in
  report/metrics-agg/anthropic-server. Project suite **417 passed**, build clean.

- **2026-06-29 (stream runaway guards)** — Added `RunawayGuard` (repetition + max-output cap) + a
  120s wall-clock deadline to all three streaming backends (Anthropic, OpenAI chat, OpenAI Responses).
  A degenerate upstream ("code\ncode\ncode…", never stops) is now cut to a clean `max_tokens` turn
  instead of freezing the session. Covered by `tests/core/stream-guard.test.ts` + an anthropic-server
  integration test (5000-delta source, asserts `emitted < 5000` and `stop_reason: max_tokens`). Full
  e2e: **43 passed / 0 failed**, project suite 414 passed, build clean.

- **2026-06-29 (Docker e2e matrix + CI wiring)** — Added a third Docker e2e driver: a hermetic HTTP
  edge-case matrix (`e2e/docker/Dockerfile.http` + `http-e2e.mjs`) that boots the **real** worker +
  supervisor on a dummy token and drives them over HTTP — 15 checks covering proxy errors (malformed
  JSON→400, >20mb→413, 404, models/healthz/count_tokens), supervision lifecycle (status/doctor/
  requests/dashboard/restart-recovery), and a deterministic `EventBus` isolation guard that **fails on
  a reverted PR #8** (verified: 15/15 with the guard, 2 fail without). Extended `cli-e2e.sh` with codex
  multi-line, claude constrained-numeric, and a `[1m]` model-id round-trip (now 7 real-CLI checks, all
  pass with a token mounted). New CI `docker-e2e` job runs http-e2e hermetically every push and gates
  the real-CLI run on a `CR_GH_TOKEN` secret. Hermetic suite green: `npm test` → **406 passed**, build
  clean. (HTTP edge cases are quota-free; only the golden round-trips + cli-e2e need a real token.)

- **2026-06-29 (crash-guard hardening + code-review fixes)** — Guarded the synchronous throw sites
  that could kill the single-process TUI+supervisor app (a dead-socket SSE write inside `EventBus.emit`,
  a corrupt/locked `creds.json` read on the heartbeat tick), and added a process-level
  `unhandledRejection`/`uncaughtException` backstop that logs to `~/.cc-fleet/crash.log` and keeps
  the TUI alive. A `/code-review` pass surfaced six follow-ups, all fixed: `CopilotTokenStore` now reads
  its GitHub token through a provider (a transient null can't poison the store for the session — it
  raises a clean 401 and recovers on the next read, instead of sending `authorization: token null`); the
  backstop uses a shared, size-capped/rotating crash logger and a 5-in-10s circuit breaker that exits for
  a clean restart on a storm; the heartbeat's defensive catch now logs instead of swallowing silently;
  the signed-out gate checks token-file existence (`hasGhTokenFile`) so a transient lock no longer reads
  as "signed out"; and the SSE route subscribes before the hello frame. Full suite green: `npm test` →
  **406 passed** (57 files), tsc build clean. Both Docker e2e suites pass against real services with a
  token (+ WebIQ key) mounted: heartbeat container (`e2e/docker/Dockerfile`) → **all 4 states passed**
  (connected/signed-out/expired/HTTP, real GitHub 401); real CLI container (`Dockerfile.cli`) →
  **4/4 passed** (`codex exec → /openai/responses → CODEX_OK`, `claude -p → /anthropic → CLAUDE_OK`,
  `claude` gateway web search → grounded "1.96.0", no tool leak) — confirming the worker's plain-string
  `CopilotTokenStore` path still works under the new union-typed constructor.

- **2026-06-28 (real CLI Docker e2e + 2 Codex bugs fixed)** — Added a true black-box e2e: the actual
  `claude` and `codex` CLIs run inside a `node:22` container against the real worker daemon
  (`e2e/docker/Dockerfile.cli` + `cli-e2e.sh`), with a real token (+ WebIQ key) mounted. All three
  checks pass: `codex exec → /openai/responses → CODEX_OK`, `claude -p → /anthropic → CLAUDE_OK`,
  and `claude` gateway web search → a grounded answer ("1.96.0"). The driver writes a markdown report
  after each run (`/out/report.md`). This path **caught two bugs nothing else did**: (1) Codex sends
  `custom`/`tool_search` tools that the inbound translator forwarded nameless → Copilot 400 "Missing
  required parameter: tools[N].name" → "stream closed before response.completed"; fixed by keeping
  `custom` tools as named tools and allow-listing only nameless hosted tools (`web_search`). (2) The
  `ResponsesSSE` terminal events carried empty text, so Codex completed the turn but rendered nothing;
  fixed by replaying the accumulated text in `output_text.done` / `content_part.done` /
  `output_item.done` and populating `response.completed.response.output`. Also added 12 hermetic
  in-process Codex `/responses` cases (EP-27…EP-38) as fast regression. No secrets are committed —
  the only key in any file is the placeholder `copilot-reverse-local`; real creds/keys mount at
  runtime and report artifacts are gitignored. Full suite green: `npm test` → **394 passed**
  (56 files), tsc build clean, real CLI Docker e2e → **all passed**.

- **2026-06-28 (GitHub-token heartbeat)** — Added a supervisor-side heartbeat that periodically (every
  60s, plus once ~2s after boot) checks whether the stored GitHub token still exchanges for a Copilot
  token, and surfaces the result via a new optional `github` field on `/api/status`. The TUI's existing
  2s status poll drives a live footer badge (`github ✓` / `✗ /login`), so an expired/revoked login
  shows within ~60s instead of only on the next failed request or a manual `/status`. Key design: a
  classifying `probeGithubAuth` distinguishes a definitive 401/403 (→ expired) from a transient
  timeout/5xx/network error (→ keep last-known-good), so a single GitHub hiccup never flips the badge;
  `nextGithubStatus` is a pure, sticky reducer. `signed-out` (no token) stays distinct from `expired`.
  New files: `src/supervisor/github-heartbeat.ts`, `tests/supervisor/github-heartbeat.test.ts`.
  **Real Linux container e2e** (`e2e/docker/`): a Docker image boots the real control API + a real
  `GithubHeartbeat.start()`, listens on a real port, and drives it over real HTTP (`GET /api/status`)
  against the real GitHub API — all four states pass, including `connected` (real token → real Copilot
  token exchange, mounted read-only) and `expired` (bad token → a real GitHub 401). Only the probe
  interval is shortened (now injectable) for the test. Full suite green: `npm test` → **378 passed**
  (56 files), `npm run test:e2e` → **31 passed** (4 files), container e2e → **all passed**, tsc build clean.

- **2026-06-26 (default to WebIQ; disable slow borrow)** — gpt-5-mini (the Claude "borrow" backend
  model) is badly congested on Copilot's `/responses`: repeated `503 "high demand"` and 20s–7min
  stalls measured live (one user search ran 437s). Same native search on gpt-5.4-mini/gpt-5.4/gpt-5.5
  is ~4s, and WebIQ is sub-second — so borrow is gated behind `COPILOT_WEB_SEARCH_ENABLED` (now
  `false`) and web search routes through WebIQ. `resolveWebSearchBackend(mode, hasKey)` →
  `copilot | webiq | unavailable` centralises the policy; the runner returns a fixed "run /webiq …"
  message (with the profile URL) when unavailable. Also: `borrowSearch` gained a 30s timeout (the
  missing one is why a stalled search hung the turn for minutes) and runs at `reasoning.effort:"low"`
  (~5-6x faster when it is used). status card + HUD show the resolved backend incl. unavailable.
  Codex's native `/responses` web_search is untouched. Verified live: Claude `web_search` routes
  through WebIQ end-to-end (`end_turn`, grounded Rust 1.96.0 answer, no tool_use leak); no-key path
  returns the `/webiq` guidance. Full suite green: `npm test` → **356 passed** (55 files),
  `npm run test:e2e` → **31 passed** (4 files), tsc build clean.

- **2026-06-26 (Phase 2: web-search backends)** — Web search now works out of the box for both
  clients, with no key. **Claude path**: the gateway borrows gpt-5-mini's native web_search internally
  (`borrow-search.ts`), extracts url_citation sources, and feeds them back — verified live through the
  worker's `/anthropic/v1/messages` with a `web_search_20250305` tool: returned a fresh grounded answer
  (Rust 1.96.0), `stop_reason: end_turn`, and NO tool_use block leaked to the client. **Codex path**:
  the hosted `web_search` tool is passed through both `/responses` translators (new
  `CanonicalRequest.hostedTools`) so Copilot runs it server-side — verified live: gpt-5.5 returns
  output items `reasoning/web_search_call/message` with citations. **Backend routing**: gateway runner
  picks per call — default "copilot" borrow, or "webiq" (forced WebIQ) when enabled; mode persisted in
  webiq.json, read lazily (no restart). **Commands**: removed `/web-search-support`; added hidden
  `/webiq` + `/webiq clean`; status card + HUD show the active backend. Full suite green: `npm test` →
  **350 passed** (55 files), `npm run test:e2e` → **31 passed** (4 files), tsc build clean.

- **2026-06-26 (outbound /responses routing)** — Newer Copilot models are served ONLY on /responses:
  live probe confirms `gpt-5.5` (and `gpt-5.3-codex`, `gpt-5.4-mini`, `mai-code-1-flash-internal`)
  report `supported_endpoints: ["/responses","ws:/responses"]` with no `/chat/completions`. Added the
  outbound translation module (`src/providers/copilot/responses-upstream.ts`), routed the adapter by
  `supported_endpoints` (with a `/chat` 400 `unsupported_api_for_model` → `/responses` retry net), and
  wired `fetchModelEndpoints` into the worker (lazy, same source as the model list). Verified live
  end-to-end against real Copilot: adapter `complete()`/`stream()` on gpt-5.5 hit /responses
  (`ROUTED_OK` / `STREAM_OK`); and through the worker over HTTP, `POST /openai/responses` non-stream
  returned `status: completed` + `output_text: E2E_RESPONSES_OK`, stream ran `response.created …
  response.completed`. gpt-4o still routes to /chat/completions. Full suite green: `npm test` →
  **329 passed** (54 files), `npm run test:e2e` → **31 passed** (4 files), tsc build clean.

- **2026-06-26 (split antml: sentinel)** — Fixed a recurrence of the text-emitted-tool-call bug: the
  `ToolCallExtractor` split-sentinel hold-back (`PREFIX_TOKENS`) listed only the bare `<invoke` /
  `<function_calls>` forms — the two namespaced slots were duplicated bare copies. Copilot streams
  Claude's `antml:`-namespaced tool call token by token, so an opening `<invoke` is routinely split
  across chunks; the partial tail wasn't held back, leaked as text, and the remainder no longer
  matched the trigger — the whole call rendered as a literal `<invoke …>` block (seen live as a
  `TaskUpdate` printed instead of executed). Derive the namespaced variants from the bare tokens so
  both are held back; added split-at-every-offset regression tests. Affects both outbound paths
  (Anthropic + the new `/responses` SSE) since they share the extractor. Full suite green: `npm test`
  → **312 passed** (53 files), `npm run test:e2e` → **31 passed** (4 files), tsc build clean.

- **2026-06-26 (Codex /responses)** — Fixed Codex startup: new Codex removed `wire_api = "chat"`
  (codex#7782) and requires `"responses"`, which makes it POST `{base_url}/responses`. Implemented the
  OpenAI Responses API at `POST /openai/responses` (new `src/core/responses-inbound.ts`: item-centric
  request → canonical, canonical → response object, and a stateful SSE emitter with `sequence_number`
  and the `response.created → output_item.added → content_part.added → output_text.delta → … →
  response.completed` event sequence). Codex config now writes `wire_api = "responses"` (base_url
  stays `…/openai`; Codex appends `/responses`). Verified live end-to-end against real Copilot:
  non-stream returns a completed `response` object with an `output_text` item; stream begins
  `response.created` and ends `response.completed` with `output_text.delta` in between. Full suite
  green: `npm test` → **294 passed** (52 files), `npm run test:e2e` → **31 passed**, tsc build clean.

- **2026-06-26** — Restored web_search / web_fetch for Claude Code through the gateway. The inbound
  translator now converts Anthropic's server-side web tools to function tools (instead of dropping
  them); a capped agentic loop in the Anthropic endpoint runs those tools internally against
  Microsoft Web IQ (`api.microsoft.ai`) and feeds results back, so the client only ever sees the
  final grounded answer (transparent). A new `/web-search-support` command stores the WebIQ key
  (data dir or `WEBIQ_API_KEY`, read lazily — no worker restart). Also added a startup status card
  (GitHub login state — connected/expired/signed-out, since the device-flow token has no real
  expiry — plus web search readiness, worker, and configured clients) and a live `web ✓/✗` indicator
  in the now two-line HUD footer. Verified live end-to-end (real Copilot + real WebIQ): a
  `web_search` request returned `stop_reason: end_turn` with a fresh answer and no tool_use block
  leaked to the client. Full suite green: `npm test` → **281 passed** (51 files), `npm run test:e2e`
  → **31 passed** (4 files), tsc build clean.

- **2026-06-25** — Fixed the `/login` deadlock: the slash command buffered the device code behind a
  blocking token poll, so the Repl showed nothing and the user could never authorize. Split device
  login into `beginDeviceLogin` (returns the code immediately) + `complete()` (polls), and gave the
  TUI a non-blocking `/login` branch that renders the verification URL + code first, then a
  completion card. Also hardened the failure path: auth errors (e.g. `incorrect_device_code`) render
  a clean error card instead of crashing the process, and a double Enter no longer starts two
  device-code flows. Added a pre-flight auth gate on chat: a signed-out or expired-login message is
  blocked immediately with a "run /login" hint instead of hanging until the 120s turn timeout. Full
  suite green: `npm test` → **242 passed** (47 files), `npm run test:e2e` → **31 passed** (4 files),
  tsc build clean.

- **2026-06-23** — Added `ToolCallExtractor` (recovers text-emitted `<function_calls>`/`<invoke>`
  tool calls into structured tool chunks) plus changeset-driven auto-release (build-time version
  injection, release workflow). Full suite green: `npm test` → **236 passed** (47 files), e2e all
  green, tsc build clean.

- **Date:** 2026-06-22 22:14 CST
- **Runner:** vitest 2.1.9 · Node v25.6.0
- **Command:** `npm run test:e2e`
- **Outcome:** ✅ 30 passed / 0 failed (4 files)

The e2e specs under `e2e/*.e2e.test.ts` (proxy, model-vision, tools, multiturn, responses,
control-setup) cover EP-01 … EP-41 — see [`cases.md`](./cases.md)
for the catalog. Plus the pre-existing smoke specs under `tests/e2e/` (m1-smoke ×2, m1a-smoke,
anthropic-mixed-stream).

```
Test Files  4 passed (4)
     Tests  30 passed (30)
```

## Full project suite

`npm test` (unit + integration + e2e): **215 passed**, tsc build clean.

## Live integration (opt-in)

`npm run test:integration` against the real Copilot API (local login required): **7 passed**
(token exchange, model discovery incl. 1M window, OpenAI completion, Anthropic streaming with
distinct answers, real message_delta usage, count_tokens). Auto-skips with no login.

# Linux container e2e — GitHub-token heartbeat

A real end-to-end test of the GitHub-token heartbeat, run inside a Linux container so it can exercise
the full HTTP path against the real GitHub API. The Windows host can't easily do this (port 7890 is
held by a running instance, and native-module / path quirks get in the way); the container has its own
network namespace and a Linux toolchain.

**What's real here:** the actual `createControlApp` control API, a real `GithubHeartbeat` started via
its real `start()`/`stop()`, a real TCP listener, real `fetch()` calls to GitHub's Copilot-token
endpoint, and real HTTP polling of `GET /api/status`. Only the probe interval is shortened (1.5s vs the
production 60s) so state transitions are observable in seconds. See [`heartbeat-e2e.mjs`](heartbeat-e2e.mjs).

## What it asserts

| State | How it's produced | Expected `github` |
|-------|-------------------|-------------------|
| connected   | a real token (mounted) is exchanged for a real Copilot token | `ok:true, hasToken:true, detail:"token valid"` |
| signed-out  | creds file removed | `ok:false, hasToken:false`, detail mentions `/login` |
| expired     | a bad token → a **real GitHub 401** | `ok:false, hasToken:true`, detail mentions expired/login |
| HTTP        | real `GET /api/status` | JSON carrying `workerState` + `github` |

The `connected` case is skipped (not failed) if no token is mounted.

## Run it

From the repo root:

```bash
docker build -f e2e/docker/Dockerfile -t copilot-reverse-e2e .

# Without a real token (connected case skipped):
docker run --rm copilot-reverse-e2e

# With your real token mounted read-only (all four cases):
#   Linux/macOS:
docker run --rm -v "$HOME/.cc-fleet/creds.json:/run/secrets/creds.json:ro" copilot-reverse-e2e
#   Windows (Git Bash) — disable path conversion and use a native path:
MSYS_NO_PATHCONV=1 docker run --rm \
  -v "C:/Users/<you>/.cc-fleet/creds.json:/run/secrets/creds.json:ro" \
  copilot-reverse-e2e
```

The token is mounted read-only at `/run/secrets/creds.json`; the driver copies it into a writable work
dir (`/tmp/cr-e2e`) so the signed-out / expired cases can rewrite creds without touching the mount.
Override the source path with `-e TOKEN_FILE=/some/path`.

Exit code `0` = all asserted states observed; non-zero = a failure (the failing check is printed).

---

# Real CLI e2e — claude + codex against the daemon

A true black-box end-to-end: the **actual `claude` (Claude Code) and `codex` CLIs** run inside the
container against the **real copilot-reverse worker daemon**, driven with real prompts, making real
Copilot (and WebIQ) calls. This is the only test that exercises the proxy exactly as the real clients
do — and it has already caught two bugs that curl and unit tests could not (a Codex tool-translation
400, and empty terminal Responses events that left Codex with no text). See
[`Dockerfile.cli`](Dockerfile.cli) + [`cli-e2e.sh`](cli-e2e.sh).

Uses `node:22` (Codex requires Node ≥22). Installs `@anthropic-ai/claude-code` + `@openai/codex`,
points Claude at `…/anthropic` (env) and Codex at `…/openai` (`~/.codex/config.toml`,
`wire_api="responses"`), boots `node dist/worker/index.js`, then asserts:

| check | path exercised | passes when |
|-------|----------------|-------------|
| `codex exec` | `/openai/responses` (real Codex CLI) | model returns `CODEX_OK` |
| `claude -p` | `/anthropic/v1/messages` (real Claude Code CLI) | model returns `CLAUDE_OK` |
| `claude` web search | gateway `web_search` loop → WebIQ | grounded answer (a Rust `1.x` version), no error |

The web-search check is skipped unless a WebIQ key is also mounted.

**No secrets are baked into the image** — the only key in any file is the placeholder
`copilot-reverse-local`. The real GitHub token and WebIQ key are mounted at runtime via `-v`.

```bash
docker build -f e2e/docker/Dockerfile.cli -t copilot-reverse-cli-e2e .

# Windows (Git Bash): MSYS_NO_PATHCONV=1 + native C:/ paths.
MSYS_NO_PATHCONV=1 docker run --rm \
  -v "C:/Users/<you>/.cc-fleet/creds.json:/root/.cc-fleet/creds.json:ro" \
  -v "C:/Users/<you>/.cc-fleet/webiq.json:/root/.cc-fleet/webiq.json:ro" \
  -v "C:/some/host/dir:/out" \
  copilot-reverse-cli-e2e

# Linux/macOS:
docker run --rm \
  -v "$HOME/.cc-fleet/creds.json:/root/.cc-fleet/creds.json:ro" \
  -v "$HOME/.cc-fleet/webiq.json:/root/.cc-fleet/webiq.json:ro" \
  -v "$PWD/out:/out" \
  copilot-reverse-cli-e2e
```

## Report

After every run the driver writes a markdown report to **`/out/report.md`** (mount `-v <hostdir>:/out`
to capture it on the host; also always at `/tmp/cli-e2e-report.md` inside the container). It records
the result, the component versions (copilot-reverse / codex / claude), and each check's status +
the real CLI reply. The report contains only CLI output (e.g. `CODEX_OK`, a version number) — never a
token. Report files are gitignored.


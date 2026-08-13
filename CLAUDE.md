# CLAUDE.md

Guidance for Claude Code when working in this repo.

## This repo is a fork

cc-fleet is a **superset successor** to
[copilot-reverse](https://github.com/wangcansunking/copilot-reverse), forked at upstream v0.21.0
with full git history. `upstream` remains a git remote — pull upstream fixes with
`git merge upstream/master`.

**Therefore: do NOT do global literal renames of `copilot-reverse` → `cc-fleet`.** A blanket rename
turns every future upstream merge into a conflict storm. Naming converges gradually, module by
module, only as each is touched for other reasons. The rebrand is deliberately limited to package
identity, bin name, data dir, README and CHANGELOG.

**Publishing is not wired yet.** `release.yml` / `publish.yml` are inherited from upstream and still
reference the old package. Do not run them until the npm identity for `cc-fleet` is set up.

## Workflow: prefer git worktrees

**For any new feature or bug fix, work in a dedicated git worktree — do not commit directly on `master`.**

- At the start of a feature/bugfix task, create a worktree (use the `EnterWorktree` tool, or `git worktree add`) and do all work there on a new branch.
- Keep `master` clean; open a PR from the worktree branch to merge.
- **NEVER merge a PR yourself unless the user explicitly asks you to.** Do not run `gh pr merge` (or merge via the API/UI) on your own initiative. Open the PR, report it, and STOP — the human reviews and decides when to merge. Merging is outward-facing and hard to reverse (it lands on `master` and triggers an npm publish), so it always requires an explicit user go-ahead for that specific PR. A prior "merge PR #N" does NOT authorize merging a later PR. When in doubt, leave it open and ask.
- Small, single-file edits, docs-only tweaks, or quick investigations don't need a worktree — use judgment.
- **Before merging any worktree branch, run the real CLI e2e (`cli-e2e`) against live Copilot and confirm it passes.** Build the image and run it with your token mounted read-only (see [`e2e/docker/README.md`](e2e/docker/README.md)) — on Windows/Git Bash that's `MSYS_NO_PATHCONV=1 docker run --rm -v "C:/Users/<you>/.copilot-reverse/creds.json:/root/.copilot-reverse/creds.json:ro" <image>`. This is the fidelity gate a merge must clear; the hermetic http-e2e alone is not sufficient. Skip only when nothing observable changed (pure docs/refactor).
- When the work is merged or abandoned, remove the worktree.
- **After a PR merges:** exit the worktree, `git push origin --delete <branch>`, remove the worktree, delete the local branch, then fast-forward `master` to the merged commit (`git fetch origin && git merge --ff-only origin/master`) so the next task branches from latest.

## Commit hygiene

- Stage by explicit path (`git add <path>`). **Never** `git add -A` / `git add .` — the tree is shared and may hold unrelated changes.
- Create new commits; don't amend published ones.

## Releases: every change must ship a changeset

**Every PR that changes behavior MUST add a changeset, or it will never publish.** Release is changeset-driven: `release.yml` runs on push to `master`, and with no file in `.changes/` the release job is skipped — no version bump, no `npm publish`. PRs merged without one silently leave npm stale.

- Scaffold one: `node scripts/changesets.mjs new <patch|minor|major> <slug>`, then edit the body (it lands in `CHANGELOG.md`).
- Choose: `patch` = fix, `minor` = feature, `major` = breaking. Highest level among pending changesets wins.
- Exempt only: docs/test-only tweaks with no shipped behavior change.

## Dev essentials

Requires Node >=20.

- Install / verify: `npm install && npm test && npm run build`
- Run the app locally: `npm run dev` (tsx on `src/`, no build needed)
- Tests: `npm test` (vitest, includes e2e) · `npm run test:e2e` (e2e only)
- **Every change must keep the full e2e suite green.** After a change, re-run and update [`e2e/RESULTS.md`](e2e/RESULTS.md). Case catalog: [`e2e/cases.md`](e2e/cases.md).
- **Prefer adding a docker e2e case for every change.** Two harnesses, two jobs:
  - **HTTP edge matrix** (`e2e/docker/http-e2e.mjs`) — hermetic, runs on a dummy token, drives the real worker+supervisor over HTTP. Add an assertion here when a change touches request/response, metrics, or supervision so regressions are caught with no quota spent. This is the always-on PR gate.
  - **Real CLI matrix** (`e2e/docker/cli-e2e.sh`) — the actual `claude` + `codex` CLIs against the daemon, making real Copilot calls. **This is the fidelity layer — favor growing it, and write cases the way a real user would actually drive the tool, not synthetic curl.** It has already caught bugs unit tests and curl could not (a Codex tool-translation 400, empty terminal Responses events).
- **When you add a CLI case, model both halves of reality: the reasonable need _and_ the edge case the user hits on the way.** Concretely, prefer cases that exercise:
  - **Real client behavior** — drive `claude -p` / `codex exec` with genuine prompts and the flags users actually pass (`--output-format json`, `--allowedTools`, `ANTHROPIC_MODEL=…`), not hand-rolled HTTP. If a user would do it through the CLI, test it through the CLI.
  - **The mainstream happy paths** — a plain chat round-trip, a model from the picker, tool use, web search, the `[1m]`/canonical-id resolution — the things that must never silently break.
  - **The edges a real user trips on** — multi-line / newline-framed replies, constrained answers, a model id that needs suffix-stripping, a tool-call that must translate both ways, a switched/aliased model, an empty or terminal stream event. Each of these maps to a past or plausible user-visible failure.
  - **Graceful degradation** — when an optional input is absent (e.g. no WebIQ key), the case should `SKIP` with a recorded reason, never hard-fail. Keep CI green for forks/no-secret runs.
- Skip a docker case only when nothing observable changed (pure docs/refactor).

## Architecture (3 processes, one terminal app)

- **TUI** (Ink) — the `cc-fleet` process: REPL + slash commands + a claude-agent-sdk assistant.
- **Supervisor** (:7890) — control API + SQLite + self-healing worker supervision.
- **Worker** (:7891) — OpenAI `/openai/chat/completions` + Anthropic `/anthropic/v1/messages` → Copilot, with tool-use translation both ways.
- **Control** (`src/control/`, not built yet) — the fleet control plane. See [`docs/design.md`](docs/design.md).
  **Hard constraint: `control/` must not import `worker/` or any Copilot-specific module.** It talks
  over an injected abstract duplex channel so it stays testable without a tunnel or a subscription.

Data dir: `~/.cc-fleet` (deliberately NOT `~/.copilot-reverse` — both products may coexist on one
machine and would otherwise fight over the same token, `network.json` and db).

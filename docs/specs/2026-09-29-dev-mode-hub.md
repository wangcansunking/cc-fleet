# Hub development mode from source

**Date:** 2026-09-29
**Status:** implementation contract

## Outcome and acceptance

1. From a fresh source checkout with dependencies installed but without `dist/`, `npm run dev -- hub` starts the full Hub on loopback: supervisor/dashboard `:7990`, Worker `:7991`, Fleet Gateway `:7992`. `npm run dev:hub` is a short alias for the same command. Output names the local dashboard and makes clear this mode stays attached to the terminal; Ctrl+C stops its services.
2. Dev Hub enables the persisted hub role and initializes the starter profile exactly as the existing `hub` command does. It does not provision a public tunnel automatically when the CLI is unavailable or signed out. When a supervisor is already running, reload its hub role rather than competing for the same ports; the command prints a clear "already running" message and does not claim to own that supervisor.
3. The existing compiled `node dist/cli/index.js hub` path keeps its detached supervisor behavior and `--foreground` keeps the standalone diagnostic HTTP hub behavior. `npm run dev` without arguments still launches the TUI. All management APIs stay loopback-only and the Gateway still rejects `/api/*`.
4. No change to fleet profile, enrolment, model routing, or credential storage is required. This is a startup-mode change, not a new public network path.

## Implementation

`src/cli/control.ts` distinguishes source execution from compiled execution using its own `import.meta.url` extension (`.ts` versus `.js`), not the existence of `dist/` (a previous build may coexist with source). `npm run dev -- hub` already passes through the existing `dev` script; `dev:hub` invokes that script with `hub`. `hub` without `--foreground` in source mode starts the supervisor in the current process, after setting the hub role, and waits for `startSupervisor().ready` before printing the dashboard URL. Reuse the existing process signal handlers to stop Worker, Gateway, and dashboard on Ctrl+C. The compiled CLI retains its existing `ensureDaemon` detached path.

`startSupervisor` resolves the Worker entry from the supervisor entry's source extension (`.ts`) or compiled extension (`.js`) so its existing `WorkerMonitor` can fork the appropriate file. Under tsx, `fork()` inherits the registered loader through `process.execArgv`; compiled Node stays unchanged.

## Verification

- First write an end-to-end process test that starts the actual dev CLI from source in a fresh temporary HOME (with dummy token), without `dist/` on the module path, waits for all three listeners, checks `/api/fleet/summary`, checks gateway `/api/*` is absent, and stops the CLI. It must be red before the code change and green afterward.
- Test the already-running branch and preserve existing compiled Hub and `--foreground` behavior with unit/integration coverage where practical.
- Run `npm run build`, the full `npm test` and `npm run test:e2e` suites, plus Dockerized source-only process fidelity (no build stage) where available.
- Update the user guide with both source commands and the compiled CLI distinction; update the E2E result log and add a minor changeset. Do not claim live public tunnel or Copilot inference in the dummy-token test.

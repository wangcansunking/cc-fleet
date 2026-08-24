import { PROTO_VERSION, parseHubMessage } from "../proto/index.js";
import type { Channel } from "../channel.js";
import { applyFleet } from "./apply.js";
import { project } from "./project.js";
import { migrateLegacyLayout } from "./migrate.js";
import { fleetDir, SKILLS } from "./store.js";
import { join } from "node:path";

// The node's half of the control loop: take what the hub says the machine should have, put it in the
// store, project it into the tools, tell the hub what happened.
//
// It owns no transport — a Channel is injected — so the whole loop is testable over an in-memory
// pair (docs/design.md §2). Everything destructive lives in applyFleet and project; this file is the
// glue and the honesty layer (a failed apply must be reported as failed, never silently swallowed).

export type AgentState = "connecting" | "applied" | "unassigned" | "error";
export interface AgentStatus {
  state: AgentState;
  version?: number;
  written?: number;
  deleted?: number;
  projected?: number;
  conflicts?: string[];
  lastError?: string;
}

export interface AgentOptions {
  /** The tool-agnostic store, ~/.agents */
  agentsHome: string;
  /** Projection target for Claude Code, ~/.claude */
  claudeHome: string;
  channel: Channel;
  deviceId: string;
  agentVersion: string;
  backup?: boolean;
  onStatus?: (status: AgentStatus) => void;
  onMigrate?: (movedIds: string[]) => void;
}

export interface RunningAgent {
  status(): AgentStatus;
  stop(): void;
}

export function startAgent(opts: AgentOptions): RunningAgent {
  let status: AgentStatus = { state: "connecting" };
  let stopped = false;

  const setStatus = (next: AgentStatus): void => {
    status = next;
    try { opts.onStatus?.(next); } catch { /* a reporting callback must not break the loop */ }
  };

  const off = opts.channel.onMessage((raw) => {
    if (stopped) return;
    const parsed = parseHubMessage(raw);
    // A frame we cannot understand is dropped, not guessed at. Applying a half-understood desired
    // state is destructive (full takeover), so silence is the safe failure here.
    if (!parsed.ok) return;

    if (parsed.msg.t === "unassigned") {
      // Do NOT apply an empty state — "not managed" and "managed with nothing" are different, and
      // conflating them would delete a bystander machine's skills.
      setStatus({ state: "unassigned" });
      return;
    }

    const { version, state } = parsed.msg;
    try {
      // Migration runs HERE, not at startup, because it needs the desired state to know which
      // pre-existing skills the hub already owns. See migrate.ts for why that filter matters.
      const migration = migrateLegacyLayout(opts.agentsHome, opts.claudeHome, new Set(state.skills.map((s) => s.id)));
      if (migration.moved.length) { try { opts.onMigrate?.(migration.moved); } catch { /* ignore */ } }

      // Applied unconditionally rather than only when `version` changed: the hub re-pushes on every
      // reconnect, and re-applying is how locally-drifted files get corrected. Both steps are no-ops
      // when nothing differs.
      const applied = applyFleet(opts.agentsHome, state, {
        backup: opts.backup,
        alsoBackup: [join(opts.claudeHome, SKILLS), join(opts.claudeHome, "CLAUDE.md")],
      });
      if (!applied.ok) {
        setStatus({ state: "error", lastError: applied.error });
        report({ version, ok: false, written: 0, deleted: 0, warnings: [], error: applied.error });
        return;
      }

      const projected = project(opts.agentsHome, opts.claudeHome);
      const warnings = [
        ...applied.warnings,
        // A shadowed skill is not an error, but it IS a difference between what the hub believes this
        // machine runs and what it actually runs. Silence here is how fleets drift undetected.
        ...projected.conflicts.map((id) => `local skill "${id}" overrides the fleet copy`),
      ];
      setStatus({
        state: "applied", version,
        written: applied.written.length, deleted: applied.deleted.length,
        projected: projected.written.length,
        conflicts: projected.conflicts,
      });
      report({ version, ok: true, written: applied.written.length, deleted: applied.deleted.length, warnings });
    } catch (e) {
      // Disk-level failure (home removed, permissions). Report it; never take the process down.
      const error = (e as Error).message;
      setStatus({ state: "error", lastError: error });
      report({ version, ok: false, written: 0, deleted: 0, warnings: [], error });
    }
  });

  function report(r: { version: number; ok: boolean; written: number; deleted: number; warnings: string[]; error?: string }): void {
    try { opts.channel.send({ t: "applied", proto: PROTO_VERSION, ...r }); }
    catch { /* the link is down; the node still applied, and will re-report on reconnect */ }
  }

  try {
    opts.channel.send({
      t: "hello", proto: PROTO_VERSION, deviceId: opts.deviceId,
      os: process.platform, agentVersion: opts.agentVersion, appliedVersion: 0,
    });
  } catch { /* not connected yet — harmless, the hub pushes state regardless */ }

  return {
    status: () => status,
    stop: () => { stopped = true; off(); },
  };
}

export { fleetDir };

import { PROTO_VERSION, parseHubMessage } from "../proto/index.js";
import type { Channel } from "../channel.js";
import { applySkills } from "./apply.js";

// The node's half of the control loop: take what the hub says the machine should have, put it on
// disk, tell the hub what happened.
//
// It owns no transport — a Channel is injected — so the whole loop is testable over an in-memory pair
// (docs/design.md §2). Everything destructive lives in applySkills; this file is the glue and the
// honesty layer (a failed apply must be reported as failed, never silently swallowed).

export type AgentState = "connecting" | "applied" | "unassigned" | "error";
export interface AgentStatus {
  state: AgentState;
  version?: number;      // last version successfully applied
  written?: number;
  deleted?: number;
  lastError?: string;
}

export interface AgentOptions {
  claudeHome: string;
  channel: Channel;
  deviceId: string;
  agentVersion: string;
  backup?: boolean;
  onStatus?: (status: AgentStatus) => void;
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
    // Applied unconditionally rather than only when `version` changed: the hub re-pushes on every
    // reconnect, and re-applying is how locally-drifted files get corrected. applySkills is a no-op
    // when nothing differs, so this costs nothing when there is nothing to do.
    let result;
    try {
      result = applySkills(opts.claudeHome, state, { backup: opts.backup });
    } catch (e) {
      // Disk-level failure (home removed, permissions). Report it; never take the process down.
      const error = (e as Error).message;
      setStatus({ state: "error", lastError: error });
      report({ version, ok: false, written: 0, deleted: 0, warnings: [], error });
      return;
    }

    if (!result.ok) {
      setStatus({ state: "error", lastError: result.error });
      report({ version, ok: false, written: 0, deleted: 0, warnings: [], error: result.error });
      return;
    }
    setStatus({ state: "applied", version, written: result.written.length, deleted: result.deleted.length });
    report({ version, ok: true, written: result.written.length, deleted: result.deleted.length, warnings: result.warnings });
  });

  function report(r: { version: number; ok: boolean; written: number; deleted: number; warnings: string[]; error?: string }): void {
    try { opts.channel.send({ t: "applied", proto: PROTO_VERSION, ...r }); }
    catch { /* the link is down; the node still applied, and will re-report on reconnect */ }
  }

  // Announce identity. The hub already knows the device id from the transport, but os/agentVersion
  // are what the M2 device list will show, and sending it here keeps the frame exercised.
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

import { fork, type ChildProcess } from "node:child_process";
import type { RestartPolicy, AppConfig } from "../shared/config.js";
import type { WorkerToSupervisor } from "../shared/ipc.js";
import type { WorkerState } from "../shared/control-types.js";

export interface RestartDecision { backoffMs: number; markedUnhealthy: boolean; crashesInWindow: number }

export class RestartController {
  private crashTimes: number[] = [];
  private consecutive = 0;
  constructor(private policy: RestartPolicy, private now: () => number = () => Date.now()) {}
  onCrash(): RestartDecision {
    const t = this.now();
    this.crashTimes.push(t);
    this.crashTimes = this.crashTimes.filter((ct) => t - ct < this.policy.windowMs);
    this.consecutive += 1;
    const backoffMs = Math.min(this.policy.baseBackoffMs * 2 ** (this.consecutive - 1), this.policy.maxBackoffMs);
    return { backoffMs, markedUnhealthy: this.crashTimes.length >= this.policy.maxCrashes, crashesInWindow: this.crashTimes.length };
  }
  reset(): void { this.consecutive = 0; this.crashTimes = []; }
}

export interface MonitorHooks {
  onStateChange(s: WorkerState): void;
  onCrash(d: RestartDecision, exitCode: number | null, stderrTail: string): void;
  onWorkerMessage(m: WorkerToSupervisor): void;
}

export class WorkerMonitor {
  private child?: ChildProcess;
  private controller: RestartController;
  private stderrTail = "";
  private state: WorkerState = "starting";
  private stopped = false;
  // The single pending respawn (crash backoff / unhealthy cooldown). Tracked so a manual restart or
  // stop() can CANCEL it — otherwise a backoff respawn fires alongside the restart's respawn and the
  // two race for :7991 (EADDRINUSE). Invariant: at most one respawn is ever scheduled at a time.
  private respawnTimer?: ReturnType<typeof setTimeout>;
  // True while a manual restart is waiting on the old worker's exit to spawn the replacement. A second
  // restart in that window must NOT spawn again (it would double-bind the port); the in-flight exit
  // handler already owns the next spawn, so we just let it proceed.
  private restartPending = false;
  // Optional: resolves the worker's BIND_HOST at EACH spawn from the live access mode (localhost →
  // loopback, lan → 0.0.0.0). Falls back to the static config.bindHost when not provided, so existing
  // callers/tests keep loopback. Because it's read per spawn, a manual restart after a mode change
  // re-binds the socket to the new posture.
  constructor(private config: AppConfig, private workerEntry: string, private hooks: MonitorHooks, private bindHostProvider?: () => string) {
    this.controller = new RestartController(config.restart);
  }
  start(): void { this.spawn(); }
  currentState(): WorkerState { return this.state; }
  private set(s: WorkerState): void { this.state = s; this.hooks.onStateChange(s); }
  private spawn(): void {
    this.set("starting");
    const bindHost = this.bindHostProvider?.() ?? this.config.bindHost;
    const child = fork(this.workerEntry, [], {
      env: { ...process.env, WORKER_PORT: String(this.config.workerPort), BIND_HOST: bindHost },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    this.child = child;
    this.stderrTail = "";
    child.stderr?.on("data", (d: Buffer) => { this.stderrTail = (this.stderrTail + d.toString()).slice(-4000); });
    child.on("message", (m: WorkerToSupervisor) => {
      if (m.type === "ready") { this.controller.reset(); this.set("ready"); }
      this.hooks.onWorkerMessage(m);
    });
    child.on("exit", (code) => {
      if (this.stopped) return;
      const d = this.controller.onCrash();
      this.hooks.onCrash(d, code, this.stderrTail);
      if (d.markedUnhealthy) {
        // Don't give up forever: a transient crash burst (token rotation, a flaky upstream) shouldn't
        // leave the daemon permanently dead. Mark unhealthy, then after a cooldown reset the window and
        // try once more — recovering on its own if the cause has passed.
        this.set("unhealthy");
        this.scheduleRespawn(this.config.restart.unhealthyCooldownMs, true);
        return;
      }
      this.set("crashed");
      this.scheduleRespawn(d.backoffMs, false);
    });
  }
  // Schedule the single pending respawn, replacing any already-pending one (cancel-then-set keeps the
  // at-most-one invariant). resetWindow clears the crash counter first (the unhealthy-cooldown path).
  private scheduleRespawn(delayMs: number, resetWindow: boolean): void {
    if (this.respawnTimer) clearTimeout(this.respawnTimer);
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = undefined;
      if (this.stopped) return;
      if (resetWindow) this.controller.reset();
      this.spawn();
    }, delayMs);
  }
  restartManually(): void {
    this.controller.reset(); this.stopped = false;
    // Cancel any pending crash/cooldown respawn — otherwise it fires alongside our respawn below and
    // the two race for the port. We own the next spawn now.
    if (this.respawnTimer) { clearTimeout(this.respawnTimer); this.respawnTimer = undefined; }
    // A restart is already waiting on the old worker's exit — its handler will spawn the replacement.
    // Spawning again here would double-bind :7991, so let the in-flight restart proceed.
    if (this.restartPending) return;
    const child = this.child;
    // A live child still holds :7991 until it actually exits. kill() is async, so spawning on the next
    // line (the old behavior) raced the dying worker → "listen EADDRINUSE :7991" → counted as a crash →
    // daemon marked unhealthy after a few restarts. Defer the spawn to the child's REAL exit so the
    // fresh worker only binds once the port is free. `connected` (IPC up) is the liveness signal: it
    // stays true for a killed-but-not-yet-exited child and is false once it's gone, so we don't arm an
    // exit listener that will never fire (which would wedge the daemon with no worker).
    if (child && child.connected) {
      this.restartPending = true;
      this.child = undefined;                       // detach: its later crash-path exit must not run
      child.removeAllListeners("exit");
      child.once("exit", () => { this.restartPending = false; if (!this.stopped) this.spawn(); });
      child.kill();
    } else {
      this.spawn();
    }
  }
  stop(): void {
    this.stopped = true;
    if (this.respawnTimer) { clearTimeout(this.respawnTimer); this.respawnTimer = undefined; }
    const child = this.child;
    if (!child || child.killed) return;
    // The IPC channel may already be torn down (e.g. right after a manual restart) — sending then
    // throws ERR_IPC_CHANNEL_CLOSED. Guard the graceful shutdown and fall back to a hard kill.
    try { if (child.connected) child.send({ type: "shutdown" }); } catch { /* channel already closed */ }
    child.kill();
  }
}

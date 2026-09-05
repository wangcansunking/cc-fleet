export interface RestartPolicy {
  maxCrashes: number;
  windowMs: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  // After the worker is marked unhealthy, wait this long then try ONCE more (resetting the window),
  // instead of giving up forever — so a transient crash burst doesn't leave the daemon dead.
  unhealthyCooldownMs: number;
}
export interface HeartbeatPolicy {
  // How often the supervisor re-checks the GitHub token, and how soon after boot the first check runs.
  intervalMs: number;
  initialDelayMs: number;
}
export interface AppConfig {
  bindHost: string;
  supervisorPort: number;
  workerPort: number;
  gatewayPort: number;
  restart: RestartPolicy;
  heartbeat: HeartbeatPolicy;
  // model remap: client model name -> Copilot model id. "*" is the fallback.
  modelMap: Record<string, string>;
  // GitHub "owner/repo" that /report files diagnostics issues against. Placeholder until set.
  reportRepo: string;
}

export function defaultConfig(): AppConfig {
  return {
    bindHost: "127.0.0.1",
    supervisorPort: 7990,
    workerPort: 7991,
    gatewayPort: 7992,
    restart: { maxCrashes: 5, windowMs: 60_000, baseBackoffMs: 500, maxBackoffMs: 8_000, unhealthyCooldownMs: 30_000 },
    // Token failure is rare and GitHub rate-limits, so a slow cadence is plenty; overridable for tests/tuning.
    heartbeat: { intervalMs: 60_000, initialDelayMs: 2_000 },
    // Empty = pass the requested model straight through to Copilot. Add entries (or "*") to remap.
    modelMap: {},
    // Set MAESTRO_REPORT_REPO=owner/repo to override where /report files diagnostics issues.
    reportRepo: process.env.MAESTRO_REPORT_REPO ?? "wangcansunking/copilot-reverse",
  };
}

// The host the WORKER PROXY (:7991) binds, derived from the access mode. localhost → loopback only
// (the default, unreachable from other machines); lan → all interfaces (0.0.0.0) so the LAN can reach
// it, gated by the mandatory key in the worker's auth middleware. NOTE: this governs ONLY the worker
// proxy. The supervisor control API (:7990 — restart/stop/dashboard) always stays on `bindHost`
// (loopback): the control plane is never exposed on the network, regardless of mode.
export function workerBindHost(mode: "localhost" | "lan", base: AppConfig = defaultConfig()): string {
  return mode === "lan" ? "0.0.0.0" : base.bindHost;
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };
export function mergeConfig(base: AppConfig, o: DeepPartial<AppConfig>): AppConfig {
  return {
    ...base,
    ...o,
    restart: { ...base.restart, ...(o.restart ?? {}) },
    heartbeat: { ...base.heartbeat, ...(o.heartbeat ?? {}) },
    modelMap: { ...base.modelMap, ...(o.modelMap ?? {}) } as Record<string, string>,
  };
}

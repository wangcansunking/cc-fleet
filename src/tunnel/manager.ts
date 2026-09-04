import type { LineProcess, TunnelDetails, TunnelUser } from "./cli.js";
import { parsePublicUrl } from "./cli.js";
import type { TunnelConfig } from "./store.js";

export type TunnelState = "disabled" | "cli-missing" | "signed-out" | "provisioning" | "connecting" | "online" | "backoff" | "failed";
export interface TunnelStatus {
  state: TunnelState;
  tunnelId?: string;
  publicUrl?: string;
  username?: string;
  error?: string;
  retryAt?: number;
}
export interface TunnelHostProcess extends LineProcess {}
export interface TunnelCli {
  available(): Promise<boolean>;
  user(): Promise<TunnelUser>;
  create(): Promise<string>;
  ensurePort(tunnelId: string, port: number): Promise<void>;
  show(tunnelId: string): Promise<TunnelDetails>;
  host(tunnelId: string): TunnelHostProcess;
  remove(tunnelId: string, force: boolean): Promise<void>;
  loginDeviceCode(onLine: (line: string) => void): TunnelHostProcess;
}
export interface TunnelManagerOptions {
  cli: TunnelCli;
  read(): TunnelConfig;
  write(config: TunnelConfig): void;
  onState?: (status: TunnelStatus) => void;
  retryMs?: number;
  maxRetryMs?: number;
  now?: () => number;
}

export class TunnelManager {
  private current: TunnelStatus = { state: "disabled" };
  private hostProcess: TunnelHostProcess | null = null;
  private loginProcess: TunnelHostProcess | null = null;
  private startPromise: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private generation = 0;
  private intendedStop = false;
  private retry: number;
  private readonly retryBase: number;
  private readonly retryMax: number;
  private readonly now: () => number;

  constructor(private readonly opts: TunnelManagerOptions) {
    this.retryBase = opts.retryMs ?? 1_000;
    this.retryMax = opts.maxRetryMs ?? 30_000;
    this.retry = this.retryBase;
    this.now = opts.now ?? Date.now;
    const config = opts.read();
    this.current = config.enabled
      ? { state: "connecting", tunnelId: config.tunnelId, publicUrl: config.publicUrl }
      : { state: "disabled", tunnelId: config.tunnelId, publicUrl: config.publicUrl };
  }

  status(): TunnelStatus { return { ...this.current }; }

  async start(): Promise<void> {
    const cfg = this.opts.read();
    if (!cfg.enabled || this.stopped) { this.set({ state: "disabled", tunnelId: cfg.tunnelId, publicUrl: cfg.publicUrl }); return; }
    return this.startOnce(false);
  }

  async enable(): Promise<void> {
    this.stopped = false;
    const cfg = this.opts.read();
    this.opts.write({ ...cfg, enabled: true, lastError: undefined });
    return this.startOnce(true);
  }

  private active(generation: number): boolean {
    return generation === this.generation && !this.stopped && this.opts.read().enabled;
  }

  private startOnce(allowCreate: boolean): Promise<void> {
    if (this.hostProcess || this.startPromise) return this.startPromise ?? Promise.resolve();
    this.startPromise = this.provisionAndHost(allowCreate).finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  private async provisionAndHost(allowCreate: boolean): Promise<void> {
    const generation = this.generation;
    if (!(await this.opts.cli.available())) { if (this.active(generation)) this.set({ state: "cli-missing" }); return; }
    if (!this.active(generation)) return;
    let user: TunnelUser;
    try { user = await this.opts.cli.user(); }
    catch (e) { if (this.active(generation)) this.fail(e); return; }
    if (!this.active(generation)) return;
    if (!user.loggedIn) { this.set({ state: "signed-out" }); return; }

    let cfg = this.opts.read();
    let tunnelId = cfg.tunnelId;
    try {
      if (!tunnelId) {
        if (!allowCreate) { this.set({ state: "failed", error: "tunnel is enabled but has no persistent tunnel id" }); return; }
        this.set({ state: "provisioning", username: user.username });
        tunnelId = await this.opts.cli.create();
        if (!this.active(generation)) return;
        cfg = { ...cfg, enabled: true, tunnelId };
        this.opts.write(cfg);
      }
      this.set({ state: "provisioning", tunnelId, publicUrl: cfg.publicUrl, username: user.username });
      await this.opts.cli.ensurePort(tunnelId, cfg.port);
      if (!this.active(generation)) return;
      const details = await this.opts.cli.show(tunnelId).catch(() => ({ tunnelId: tunnelId!, publicUrl: null }));
      if (!this.active(generation)) return;
      if (details.publicUrl) {
        cfg = { ...cfg, publicUrl: details.publicUrl };
        this.opts.write(cfg);
      }
      this.spawnHost(tunnelId, cfg.publicUrl, user.username);
    } catch (e) { if (this.active(generation)) this.fail(e); }
  }

  private spawnHost(tunnelId: string, publicUrl?: string, username?: string): void {
    if (this.hostProcess || this.stopped) return;
    this.intendedStop = false;
    this.set({ state: "connecting", tunnelId, publicUrl, username });
    const process = this.opts.cli.host(tunnelId);
    this.hostProcess = process;
    process.on("line", (line) => {
      const url = parsePublicUrl(line);
      if (!url) return;
      this.retry = this.retryBase;
      const cfg = this.opts.read();
      this.opts.write({ ...cfg, enabled: true, tunnelId, publicUrl: url, lastError: undefined });
      this.set({ state: "online", tunnelId, publicUrl: url, username });
    });
    process.on("exit", (code) => {
      if (this.hostProcess !== process) return;
      this.hostProcess = null;
      if (this.intendedStop || this.stopped || !this.opts.read().enabled) return;
      const delay = this.retry;
      this.retry = Math.min(this.retry * 2, this.retryMax);
      this.set({ state: "backoff", tunnelId, publicUrl: this.opts.read().publicUrl, error: `devtunnel host exited (${code ?? "unknown"})`, retryAt: this.now() + delay });
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (!this.stopped && this.opts.read().enabled) void this.startOnce(false);
      }, delay);
    });
  }

  loginDeviceCode(onLine: (line: string) => void = () => {}): TunnelHostProcess {
    this.loginProcess?.kill();
    const child = this.opts.cli.loginDeviceCode(onLine);
    this.loginProcess = child;
    child.on("exit", () => { if (this.loginProcess === child) this.loginProcess = null; });
    return child;
  }

  disable(): void {
    this.generation += 1;
    const cfg = this.opts.read();
    this.opts.write({ ...cfg, enabled: false });
    this.stopHosting();
    this.set({ state: "disabled", tunnelId: cfg.tunnelId, publicUrl: cfg.publicUrl });
  }

  async deleteTunnel(): Promise<void> {
    this.generation += 1;
    const cfg = this.opts.read();
    this.stopHosting();
    if (cfg.tunnelId) await this.opts.cli.remove(cfg.tunnelId, true);
    this.opts.write({ enabled: false, port: cfg.port });
    this.set({ state: "disabled" });
  }

  /** Test/diagnostic hook: kill only the host process so the normal exit/backoff path must recover. */
  interruptHost(): boolean {
    if (!this.hostProcess) return false;
    this.hostProcess.kill();
    return true;
  }

  stop(): void {
    this.generation += 1;
    this.stopped = true;
    this.loginProcess?.kill(); this.loginProcess = null;
    this.stopHosting();
  }

  private stopHosting(): void {
    this.intendedStop = true;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    const process = this.hostProcess;
    this.hostProcess = null;
    process?.kill();
  }

  private fail(e: unknown): void {
    const error = e instanceof Error ? e.message : String(e);
    const cfg = this.opts.read();
    this.opts.write({ ...cfg, lastError: error });
    this.set({ state: "failed", tunnelId: cfg.tunnelId, publicUrl: cfg.publicUrl, error });
  }

  private set(status: TunnelStatus): void {
    this.current = status;
    try { this.opts.onState?.({ ...status }); } catch { /* observer cannot break lifecycle */ }
  }
}

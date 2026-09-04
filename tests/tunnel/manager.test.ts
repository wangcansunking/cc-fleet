import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { TunnelManager, type TunnelCli, type TunnelHostProcess } from "../../src/tunnel/manager.js";
import type { TunnelConfig } from "../../src/tunnel/store.js";

class Host extends EventEmitter implements TunnelHostProcess {
  killed = false;
  kill(): void { this.killed = true; this.emit("exit", 0); }
  line(text: string): void { this.emit("line", text); }
  fail(code = 1): void { this.emit("exit", code); }
}

function fixture(over: Partial<TunnelCli> = {}, saved: Partial<TunnelConfig> = {}) {
  const hosts: Host[] = [];
  const cli: TunnelCli = {
    available: async () => true,
    user: async () => ({ loggedIn: true, username: "owner@example.com" }),
    create: async () => "fleet-id",
    ensurePort: async () => {},
    show: async () => ({ tunnelId: "fleet-id", publicUrl: null }),
    host: () => { const h = new Host(); hosts.push(h); return h; },
    remove: async () => {},
    loginDeviceCode: () => new Host(),
    ...over,
  };
  let config: TunnelConfig = { enabled: false, port: 7992, ...saved };
  const changes: any[] = [];
  const manager = new TunnelManager({
    cli,
    read: () => config,
    write: (next) => { config = next; },
    onState: (s) => changes.push(s),
    retryMs: 5,
    maxRetryMs: 10,
  });
  return { manager, cli, hosts, changes, config: () => config };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("TunnelManager lifecycle", () => {
  it("reports cli-missing without provisioning anything", async () => {
    const f = fixture({ available: async () => false });
    await f.manager.enable();
    expect(f.manager.status()).toMatchObject({ state: "cli-missing" });
    expect(f.hosts).toHaveLength(0);
  });

  it("reports signed-out and waits for an explicit login action", async () => {
    const create = vi.fn(async () => "x");
    const f = fixture({ user: async () => ({ loggedIn: false }), create });
    await f.manager.enable();
    expect(f.manager.status()).toMatchObject({ state: "signed-out" });
    expect(create).not.toHaveBeenCalled();
  });

  it("creates and persists one tunnel, configures one port, and becomes online from host output", async () => {
    const create = vi.fn(async () => "fleet-id");
    const ensurePort = vi.fn(async () => {});
    const f = fixture({ create, ensurePort });
    await f.manager.enable();
    expect(create).toHaveBeenCalledTimes(1);
    expect(ensurePort).toHaveBeenCalledWith("fleet-id", 7992);
    expect(f.hosts).toHaveLength(1);
    f.hosts[0].line("Hosting port 7992 at https://fleet-id-7992.devtunnels.ms/");
    expect(f.manager.status()).toMatchObject({ state: "online", publicUrl: "https://fleet-id-7992.devtunnels.ms" });
    expect(f.config()).toMatchObject({ enabled: true, tunnelId: "fleet-id", publicUrl: "https://fleet-id-7992.devtunnels.ms" });
  });

  it("reuses a persisted tunnel and never creates a second host concurrently", async () => {
    const create = vi.fn(async () => "wrong");
    const f = fixture({ create }, { enabled: true, tunnelId: "persisted" });
    await Promise.all([f.manager.start(), f.manager.start(), f.manager.start()]);
    expect(create).not.toHaveBeenCalled();
    expect(f.hosts).toHaveLength(1);
  });

  it("restarts the same tunnel after an unexpected host exit", async () => {
    vi.useFakeTimers();
    const f = fixture({}, { enabled: true, tunnelId: "persisted" });
    await f.manager.start();
    f.hosts[0].fail(7);
    expect(f.manager.status().state).toBe("backoff");
    await vi.advanceTimersByTimeAsync(5);
    expect(f.hosts).toHaveLength(2);
    expect(f.manager.status().tunnelId).toBe("persisted");
    f.manager.stop();
    vi.useRealTimers();
  });

  it("exposes a diagnostic interrupt that drives the same recovery path", async () => {
    vi.useFakeTimers();
    const f = fixture({}, { enabled: true, tunnelId: "persisted" });
    await f.manager.start();
    expect(f.manager.interruptHost()).toBe(true);
    expect(f.manager.status().state).toBe("backoff");
    await vi.advanceTimersByTimeAsync(5);
    expect(f.hosts).toHaveLength(2);
    f.manager.stop();
    vi.useRealTimers();
  });

  it("disable stops hosting but retains the persistent cloud resource", async () => {
    const remove = vi.fn(async () => {});
    const f = fixture({ remove }, { enabled: true, tunnelId: "persisted" });
    await f.manager.start();
    f.manager.disable();
    expect(f.hosts[0].killed).toBe(true);
    expect(f.config()).toMatchObject({ enabled: false, tunnelId: "persisted" });
    expect(remove).not.toHaveBeenCalled();
  });

  it("delete is distinct: it stops, deletes remotely, then clears local identity", async () => {
    const remove = vi.fn(async () => {});
    const f = fixture({ remove }, { enabled: true, tunnelId: "persisted", publicUrl: "https://x" });
    await f.manager.start();
    await f.manager.deleteTunnel();
    expect(remove).toHaveBeenCalledWith("persisted", true);
    expect(f.config()).toEqual({ enabled: false, port: 7992 });
    expect(f.manager.status()).toEqual({ state: "disabled" });
  });

  it("disable cancels an in-flight enable before it creates or hosts a tunnel", async () => {
    let release!: (value: { loggedIn: boolean; username?: string }) => void;
    const user = new Promise<{ loggedIn: boolean; username?: string }>((resolve) => { release = resolve; });
    const create = vi.fn(async () => "late-tunnel");
    const f = fixture({ user: () => user, create });
    const enabling = f.manager.enable();
    f.manager.disable();
    release({ loggedIn: true, username: "owner" });
    await enabling;
    expect(create).not.toHaveBeenCalled();
    expect(f.hosts).toHaveLength(0);
    expect(f.config().enabled).toBe(false);
    expect(f.manager.status().state).toBe("disabled");
  });

  it("stop cancels a pending respawn and does not leak another host", async () => {
    vi.useFakeTimers();
    const f = fixture({}, { enabled: true, tunnelId: "persisted" });
    await f.manager.start();
    f.hosts[0].fail();
    f.manager.stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(f.hosts).toHaveLength(1);
    vi.useRealTimers();
  });
});

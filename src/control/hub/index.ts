import { join } from "node:path";
import { Hub } from "./hub.js";
import { ProfileStore } from "./profile-store.js";
import { DeviceRegistry } from "./devices.js";
import { DeviceAuthRequests } from "./device-auth.js";
import { PendingQueue } from "./pending.js";
import { createControlRouter, startHubServer, type HubServer } from "../transport/http-hub.js";
import type { AppliedMsg, InventoryMsg, PushItem } from "../proto/index.js";

// Assemble the hub: profile store (source of truth) + Hub (decisions) + HTTP transport (delivery).
//
// Kept separate from the CLI so tests can start a complete, real hub on an ephemeral port without
// spawning a process — and so M2 can mount the same wiring inside the supervisor instead of a
// standalone server.

export const DEFAULT_CONTROL_PORT = 7992; // after supervisor 7990 / worker 7991
export const PROFILE_FILE = "profile.json";

export interface ControlHubOptions {
  dataDir: string;
  profilePath?: string;
  port?: number;
  host?: string;
  keepAliveMs?: number;
  debounceMs?: number;
  onProfileError?: (message: string) => void;
  onReport?: (deviceId: string, report: AppliedMsg) => void;
  onPublish?: (version: number) => void;
  onPush?: (deviceId: string, item: PushItem, stored: boolean) => void;
  onInventory?: (deviceId: string, inventory: InventoryMsg) => void;
  /** Runtime-only client config (public URL + secret key); never stored in profile.json. */
  clients?: (deviceId: string, profile: import("../proto/index.js").Profile) => import("../proto/index.js").ManagedClients | undefined;
  /** Supply an already-mounted transport (the supervisor gateway) instead of opening another port. */
  startServer?: false;
}

export interface RunningHub {
  readonly port: number;
  readonly hub: Hub;
  readonly store: ProfileStore;
  readonly devices: DeviceRegistry;
  readonly auth: DeviceAuthRequests;
  readonly pending: PendingQueue;
  readonly router: import("express").Express;
  readonly profilePath: string;
  close(): void;
}

export async function startControlHub(opts: ControlHubOptions): Promise<RunningHub> {
  const profilePath = opts.profilePath ?? join(opts.dataDir, PROFILE_FILE);
  const store = new ProfileStore(profilePath, { debounceMs: opts.debounceMs });
  const devices = new DeviceRegistry(opts.dataDir);
  const auth = new DeviceAuthRequests(opts.dataDir);

  // A missing or invalid profile at boot is NOT fatal: the hub starts, serves nothing, and says why.
  // Nodes that connect are told nothing at all (Hub.messageFor returns null for a null profile), which
  // is the safe answer — an "empty desired state" would be a delete instruction.
  const loaded = store.load();
  if (!loaded.ok) opts.onProfileError?.(loaded.error);

  const hub = new Hub(() => store.current(), opts.clients);
  if (opts.onReport) hub.onReport(opts.onReport);

  const pending = new PendingQueue(opts.dataDir);
  // A pushed item is STORED, never adopted. The wiring stops here on purpose: there is no path from
  // "a node sent this" to "the fleet runs this" that does not pass through a person.
  hub.onPush((deviceId, item) => {
    const stored = pending.offer(deviceId, item);
    try { opts.onPush?.(deviceId, item, stored); } catch { /* ignore */ }
  });
  if (opts.onInventory) hub.onInventory(opts.onInventory);

  store.onChange((p) => { opts.onPublish?.(p.version); hub.publish(); });
  store.watch();

  const router = createControlRouter({
    dataDir: opts.dataDir, hub, devices, auth, keepAliveMs: opts.keepAliveMs,
  });
  let server: HubServer | undefined;
  if (opts.startServer !== false) {
    try {
      server = await startHubServer({
        dataDir: opts.dataDir, hub, devices, auth, keepAliveMs: opts.keepAliveMs,
        port: opts.port ?? DEFAULT_CONTROL_PORT, host: opts.host,
      });
    } catch (e) {
      store.close(); // don't leak a watcher when the port is taken
      throw e;
    }
  }

  return {
    port: server?.port ?? (opts.port ?? DEFAULT_CONTROL_PORT),
    hub,
    store,
    devices,
    pending,
    auth,
    router,
    profilePath,

    close: () => { store.close(); server?.close(); },
  };
}

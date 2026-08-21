import { join } from "node:path";
import { Hub } from "./hub.js";
import { ProfileStore } from "./profile-store.js";
import { DeviceRegistry } from "./devices.js";
import { EnrollCodes } from "./enroll.js";
import { startHubServer, type HubServer } from "../transport/http-hub.js";
import type { AppliedMsg } from "../proto/index.js";

// Assemble the hub: profile store (source of truth) + Hub (decisions) + HTTP transport (delivery).
//
// Kept separate from the CLI so tests can start a complete, real hub on an ephemeral port without
// spawning a process — and so M2 can mount the same wiring inside the supervisor instead of a
// standalone server.

export const DEFAULT_CONTROL_PORT = 7892; // after supervisor 7890 / worker 7891
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
}

export interface RunningHub {
  readonly port: number;
  readonly hub: Hub;
  readonly store: ProfileStore;
  readonly devices: DeviceRegistry;
  readonly codes: EnrollCodes;
  readonly profilePath: string;
  /** Mint a one-time enrolment code. Codes live in memory, so they die with this process. */
  mintCode(): string;
  close(): void;
}

export async function startControlHub(opts: ControlHubOptions): Promise<RunningHub> {
  const profilePath = opts.profilePath ?? join(opts.dataDir, PROFILE_FILE);
  const store = new ProfileStore(profilePath, { debounceMs: opts.debounceMs });
  const devices = new DeviceRegistry(opts.dataDir);
  const codes = new EnrollCodes();

  // A missing or invalid profile at boot is NOT fatal: the hub starts, serves nothing, and says why.
  // Nodes that connect are told nothing at all (Hub.messageFor returns null for a null profile), which
  // is the safe answer — an "empty desired state" would be a delete instruction.
  const loaded = store.load();
  if (!loaded.ok) opts.onProfileError?.(loaded.error);

  const hub = new Hub(() => store.current());
  if (opts.onReport) hub.onReport(opts.onReport);

  store.onChange((p) => { opts.onPublish?.(p.version); hub.publish(); });
  store.watch();

  let server: HubServer;
  try {
    server = await startHubServer({
      dataDir: opts.dataDir, hub, devices, codes, keepAliveMs: opts.keepAliveMs,
      port: opts.port ?? DEFAULT_CONTROL_PORT, host: opts.host,
    });
  } catch (e) {
    store.close(); // don't leak a watcher when the port is taken
    throw e;
  }

  return {
    port: server.port,
    hub,
    store,
    devices,
    codes,
    profilePath,
    mintCode: () => codes.mint(),
    close: () => { store.close(); server.close(); },
  };
}

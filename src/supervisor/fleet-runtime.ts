import { createServer, type Server } from "node:http";
import { hostname, homedir } from "node:os";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../shared/config.js";
import { readAccessKey, readAccessKeyRevision, ensureAccessKey } from "../shared/network.js";
import { readJson, writeJsonAtomic } from "../control/hub/json-store.js";
import { startControlHub, PROFILE_FILE, type RunningHub } from "../control/hub/index.js";
import { desiredStateFor, type ManagedClients, type Profile } from "../control/proto/index.js";
import { ProfileService } from "../control/hub/profile-service.js";
import { createFleetGateway } from "./fleet-gateway.js";
import { DevTunnelCli } from "../tunnel/cli.js";
import { TunnelManager, type TunnelStatus } from "../tunnel/manager.js";
import { readTunnelConfig, writeTunnelConfig } from "../tunnel/store.js";
import { readNodeCreds } from "../control/agent/creds.js";
import { connectHttp, type AgentChannel } from "../control/transport/http-agent.js";
import { startAgent, type AgentStatus, type RunningAgent } from "../control/agent/agent.js";
import { agentsHome } from "../control/agent/store.js";
import { APP_VERSION } from "../version.js";

const RUNTIME_FILE = "runtime.json";
export interface RuntimeConfig { hubEnabled: boolean }
export type NodeRuntimeStatus = { state: "disabled" | "connecting" | "running" | "auth-failed" | "error"; deviceId?: string; hubUrl?: string; agent?: AgentStatus; error?: string };

export function readRuntimeConfig(dataDir: string): RuntimeConfig {
  const raw = readJson<Partial<RuntimeConfig>>(dataDir, RUNTIME_FILE, {});
  return { hubEnabled: raw?.hubEnabled === true };
}
export function setHubEnabled(dataDir: string, enabled: boolean): void {
  writeJsonAtomic(dataDir, RUNTIME_FILE, { ...readRuntimeConfig(dataDir), hubEnabled: enabled });
}

const STARTER_PROFILE = {
  version: 1,
  clients: { claude: { model: "claude-opus-5[1m]" }, codex: { model: "gpt-5.6-sol" } },
  groups: {
    full: {
      skills: [{ id: "hello-fleet", files: [{ path: "SKILL.md", content: "---\nname: hello-fleet\ndescription: Pushed by cc-fleet.\n---\n\nThis skill arrived from the fleet hub.\n" }] }],
      rules: [], mcpServers: [],
    },
  },
  assignments: { [hostname()]: "full" },
};

export interface FleetRuntimeOptions {
  dataDir: string;
  config: AppConfig;
  startTunnel?: boolean;
  workerBaseUrl?: string;
  onTunnel?: (status: TunnelStatus) => void;
  onNode?: (status: NodeRuntimeStatus) => void;
  onPublish?: (version: number) => void;
  onReport?: (deviceId: string, report: import("../control/proto/index.js").AppliedMsg) => void;
  onInventory?: (deviceId: string, inventory: import("../control/proto/index.js").InventoryMsg) => void;
  onPush?: (deviceId: string, item: import("../control/proto/index.js").PushItem, stored: boolean) => void;
}
export interface FleetRuntime {
  readonly hub?: RunningHub;
  readonly profileService?: ProfileService;
  readonly gatewayPort?: number;
  readonly tunnel?: TunnelManager;
  nodeStatus(): NodeRuntimeStatus;
  reloadRoles(): Promise<void>;
  reloadNode(): void;
  stop(): void;
}

export async function startFleetRuntime(opts: FleetRuntimeOptions): Promise<FleetRuntime> {
  mkdirSync(opts.dataDir, { recursive: true });
  let hub: RunningHub | undefined;
  let profileService: ProfileService | undefined;
  let gateway: Server | undefined;
  let gatewayPort: number | undefined;
  let tunnel: TunnelManager | undefined;
  let nodeChannel: AgentChannel | undefined;
  let nodeAgent: RunningAgent | undefined;
  let node: NodeRuntimeStatus = { state: "disabled" };
  let stopped = false;
  let rolePromise: Promise<void> | null = null;

  const runtime: FleetRuntime = {
    get hub() { return hub; },
    get profileService() { return profileService; },
    get gatewayPort() { return gatewayPort; },
    get tunnel() { return tunnel; },
    nodeStatus: () => ({ ...node }),
    reloadRoles: () => loadRoles(),
    reloadNode: () => reloadNode(),
    stop: () => {
      if (stopped) return;
      stopped = true;
      stopNode();
      tunnel?.stop(); tunnel = undefined;
      hub?.close(); hub = undefined; profileService = undefined;
      gateway?.close(); gateway = undefined; gatewayPort = undefined;
    },
  };

  const setNode = (status: NodeRuntimeStatus) => {
    node = status;
    try { opts.onNode?.({ ...status }); } catch { /* observer only */ }
  };

  async function loadRoles(): Promise<void> {
    if (rolePromise) return rolePromise;
    rolePromise = (async () => {
      if (stopped) return;
      const role = readRuntimeConfig(opts.dataDir);
      if (role.hubEnabled && !hub) await startHubRole();
      if (!role.hubEnabled && hub) stopHubRole();
      reloadNode();
    })().finally(() => { rolePromise = null; });
    return rolePromise;
  }

  async function startHubRole(): Promise<void> {
    const profilePath = join(opts.dataDir, PROFILE_FILE);
    if (!existsSync(profilePath)) writeFileSync(profilePath, `${JSON.stringify(STARTER_PROFILE, null, 2)}\n`, { mode: 0o600 });
    ensureAccessKey(opts.dataDir);

    const clients = (deviceId: string, profile: Profile): ManagedClients | undefined => {
      const url = tunnel?.status().state === "online" ? tunnel.status().publicUrl : undefined;
      const key = readAccessKey(opts.dataDir);
      const state = desiredStateFor(profile, deviceId);
      if (!url || !key || !state?.clients) return undefined;
      return { baseUrl: url, apiKey: key, keyRevision: readAccessKeyRevision(opts.dataDir), ...state.clients };
    };
    const nextHub = await startControlHub({
      dataDir: opts.dataDir, profilePath, startServer: false, clients,
      onPublish: opts.onPublish,
      onReport: (deviceId, report) => opts.onReport?.(deviceId, report),
      onInventory: (deviceId, inventory) => opts.onInventory?.(deviceId, inventory),
      onPush: (deviceId, item, stored) => opts.onPush?.(deviceId, item, stored),
    });
    const app = createFleetGateway({
      control: nextHub.router,
      workerBaseUrl: opts.workerBaseUrl ?? `http://${opts.config.bindHost}:${opts.config.workerPort}`,
      llmKey: () => readAccessKey(opts.dataDir),
    });
    const nextGateway = createServer(app);
    try {
      await new Promise<void>((resolve, reject) => {
        nextGateway.once("error", reject);
        nextGateway.listen(opts.config.gatewayPort, opts.config.bindHost, resolve);
      });
    } catch (e) { nextHub.close(); throw e; }
    const address = nextGateway.address();
    hub = nextHub;
    profileService = new ProfileService(opts.dataDir, profilePath);
    gateway = nextGateway;
    gatewayPort = typeof address === "object" && address ? address.port : opts.config.gatewayPort;

    const readTunnel = () => {
      const current = readTunnelConfig(opts.dataDir);
      return current.port === gatewayPort ? current : { ...current, port: gatewayPort!, publicUrl: undefined };
    };
    tunnel = new TunnelManager({
      cli: new DevTunnelCli(), read: readTunnel,
      write: (config) => writeTunnelConfig(opts.dataDir, config),
      onState: (status) => {
        opts.onTunnel?.(status);
        if (status.state === "online") hub?.hub.publish();
      },
    });
    if (opts.startTunnel !== false) void tunnel.start();
  }

  function stopHubRole(): void {
    tunnel?.stop(); tunnel = undefined;
    hub?.close(); hub = undefined; profileService = undefined;
    gateway?.close(); gateway = undefined; gatewayPort = undefined;
  }

  function stopNode(): void {
    nodeAgent?.stop(); nodeAgent = undefined;
    nodeChannel?.close(); nodeChannel = undefined;
  }
  function reloadNode(): void {
    stopNode();
    const creds = readNodeCreds(opts.dataDir);
    if (!creds || stopped) { setNode({ state: "disabled" }); return; }
    const deviceId = creds.deviceId ?? hostname();
    setNode({ state: "connecting", deviceId, hubUrl: creds.hubUrl });
    const channel = connectHttp({ hubUrl: creds.hubUrl, token: creds.token, deviceId });
    nodeChannel = channel;
    channel.onFatal((error) => {
      if (nodeChannel !== channel) return;
      nodeAgent?.stop(); nodeAgent = undefined;
      channel.close(); nodeChannel = undefined;
      setNode({ state: "auth-failed", deviceId, hubUrl: creds.hubUrl, error });
    });
    channel.onError((error) => {
      if (nodeChannel === channel && node.state !== "auth-failed") setNode({ ...node, state: "connecting", error });
    });
    const userHome = process.env.USERPROFILE ?? process.env.HOME ?? homedir();
    const agent = startAgent({
      agentsHome: agentsHome(), claudeHome: process.env.CLAUDE_HOME ?? join(userHome, ".claude"), userHome,
      channel, deviceId, agentVersion: APP_VERSION,
      onStatus: (status) => {
        if (nodeAgent === agent || !nodeAgent) setNode({ state: "running", deviceId, hubUrl: creds.hubUrl, agent: status });
      },
    });
    nodeAgent = agent;
  }

  await loadRoles();
  return runtime;
}

import type { FleetRuntime, NodeRuntimeStatus } from "./fleet-runtime.js";
import type { TunnelStatus } from "../tunnel/manager.js";
import { readTunnelConfig } from "../tunnel/store.js";
import { readAccessKeyRevision, rotateAccessKey } from "../shared/network.js";
import type { ProfileFailure } from "../control/hub/profile-service.js";

export interface FleetAdmin {
  summary(): unknown;
  enrolments(): unknown[];
  approve(requestId: string): unknown;
  deny(requestId: string): unknown;
  devices(): unknown[];
  revoke(deviceId: string): unknown;
  pending(): unknown[];
  adopt(deviceId: string, kind: string, id: string, group: string): unknown;
  reject(deviceId: string, kind: string, id: string): unknown;
  liveProfile(): unknown;
  draftProfile(): unknown;
  saveDraft(profile: unknown, baseRevision: string): unknown;
  previewDraft(): unknown;
  publishDraft(revision: string): Promise<unknown> | unknown;
  history(): unknown[];
  rollback(historyId: string, revision: string): Promise<unknown> | unknown;
  tunnelStatus(): TunnelStatus & { login?: { state: string; lines: string[]; updatedAt: number } };
  tunnelLogin(): unknown;
  tunnelEnable(): Promise<unknown> | unknown;
  tunnelDisable(): unknown;
  tunnelDelete(): Promise<unknown> | unknown;
  tunnelInterrupt(): unknown;
  rotateLlmKey(): unknown;
  reloadRoles(): Promise<unknown> | unknown;
  reloadNode(): unknown;
}

const errorResult = (error: string) => ({ ok: false, code: "not_found", error });

export function createFleetAdmin(
  runtime: FleetRuntime,
  dataDir: string,
  state: { tunnel: () => TunnelStatus; node: () => NodeRuntimeStatus },
): FleetAdmin {
  let loginState: { state: string; lines: string[]; updatedAt: number } | undefined;
  const hub = () => runtime.hub;
  const profile = () => runtime.profileService;
  return {
    summary: () => {
      const h = hub();
      const devices = h?.devices.list() ?? [];
      const online = new Set(h?.hub.deviceIds() ?? []);
      const live = profile()?.readLive();
      return {
        hub: h ? "ready" : "disabled",
        node: state.node(),
        tunnel: state.tunnel(),
        online: online.size,
        enrolled: devices.filter((d) => d.revokedAt === null).length,
        pending: h?.auth.listPending().length ?? 0,
        profileVersion: live && "ok" in live && live.ok ? live.profile.version : undefined,
        hasDraft: profile()?.readDraft().exists ?? false,
        keyRevision: readAccessKeyRevision(dataDir),
        previewService: true,
      };
    },
    enrolments: () => hub()?.auth.listPendingPublic() ?? [],
    approve: (id) => {
      const approved = hub()?.auth.approveRequest(id);
      return approved ? { ok: true, hostname: approved.hostname } : errorResult("pending enrolment not found or expired");
    },
    deny: (id) => {
      const denied = hub()?.auth.denyRequest(id);
      return denied ? { ok: true, hostname: denied.hostname } : errorResult("pending enrolment not found or expired");
    },
    devices: () => {
      const h = hub();
      const online = new Set(h?.hub.deviceIds() ?? []);
      return (h?.devices.list() ?? []).map((d) => {
        const report = h?.hub.lastApplied(d.deviceId);
        const inventory = h?.hub.inventoryOf(d.deviceId);
        return {
          deviceId: d.deviceId, hostname: d.hostname, os: d.os, agentVersion: d.agentVersion,
          enrolledAt: d.enrolledAt, lastSeenAt: d.lastSeenAt, revokedAt: d.revokedAt,
          online: online.has(d.deviceId),
          report: report ? {
            version: report.version, ok: report.ok, written: report.written, deleted: report.deleted,
            warnings: report.warnings, error: report.error, clients: report.clients,
          } : undefined,
          inventory,
        };
      });
    },
    revoke: (deviceId) => hub()?.devices.revoke(deviceId) ? { ok: true } : errorResult("active device not found"),
    pending: () => hub()?.pending.list() ?? [],
    adopt: async (deviceId, kind, id, group) => {
      const h = hub(), service = profile();
      if (!h || !service) return errorResult("hub is disabled");
      const entry = h.pending.find(deviceId, kind, id);
      if (!entry) return errorResult("pending item not found");
      const live = service.readLive();
      if (!live.ok) return live;
      const published = await service.adopt(group, entry.item, live.revision);
      if (published.ok) h.pending.drop(deviceId, kind, id);
      return published;
    },
    reject: (deviceId, kind, id) => hub()?.pending.drop(deviceId, kind, id) ? { ok: true } : errorResult("pending item not found"),
    liveProfile: () => profile()?.readLive() ?? errorResult("hub is disabled"),
    draftProfile: () => profile()?.readDraft() ?? { exists: false },
    saveDraft: (raw, baseRevision) => profile()?.saveDraft(raw, baseRevision) ?? errorResult("hub is disabled"),
    previewDraft: () => profile()?.previewDraft() ?? errorResult("hub is disabled"),
    publishDraft: (revision) => profile()?.publishDraft(revision) ?? errorResult("hub is disabled"),
    history: () => profile()?.listHistory() ?? [],
    rollback: (historyId, revision) => profile()?.rollback(historyId, revision) ?? errorResult("hub is disabled"),
    tunnelStatus: () => ({ ...state.tunnel(), ...(loginState ? { login: { ...loginState, lines: [...loginState.lines] } } : {}) }),
    tunnelLogin: () => {
      if (!runtime.tunnel) return errorResult("hub is disabled");
      const session = { state: "login-started", lines: [] as string[], updatedAt: Date.now() };
      loginState = session;
      runtime.tunnel.loginDeviceCode((line) => {
        session.lines.push(line);
        session.lines = session.lines.slice(-20);
        session.updatedAt = Date.now();
      });
      return { ok: true, state: session.state };
    },
    tunnelEnable: async () => { await runtime.tunnel?.enable(); return runtime.tunnel?.status() ?? errorResult("hub is disabled"); },
    tunnelDisable: () => { runtime.tunnel?.disable(); return runtime.tunnel?.status() ?? errorResult("hub is disabled"); },
    tunnelDelete: async () => { await runtime.tunnel?.deleteTunnel(); return { ok: true }; },
    tunnelInterrupt: () => runtime.tunnel?.interruptHost() ? { ok: true } : errorResult("tunnel host is not running"),
    rotateLlmKey: () => {
      rotateAccessKey(dataDir);
      runtime.hub?.hub.publish();
      return { ok: true, revision: readAccessKeyRevision(dataDir) };
    },
    reloadRoles: async () => { await runtime.reloadRoles(); return { ok: true }; },
    reloadNode: () => { runtime.reloadNode(); return { ok: true, state: runtime.nodeStatus() }; },
  };
}

export function statusOf(result: unknown): number {
  const r = result as Partial<ProfileFailure> | null;
  if (!r || r.ok !== false) return 200;
  if (r.code === "revision_conflict") return 409;
  if (r.code === "not_found") return 404;
  return 400;
}

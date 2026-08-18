import { PROTO_VERSION, desiredStateFor, parseNodeMessage, type AppliedMsg, type HubMessage, type Profile } from "../proto/index.js";
import type { Peer } from "../channel.js";

export type ReportHandler = (deviceId: string, report: AppliedMsg) => void;

// The control plane's decision-making half: given the current profile, work out what each connected
// device should have, and keep them told.
//
// It knows nothing about HTTP — peers arrive as abstract channels (docs/design.md §2), which is what
// lets the whole plane be tested with no ports, no tunnel and no Copilot subscription.
export class Hub {
  private readonly peers = new Set<Peer>();
  private readonly reports = new Map<string, AppliedMsg>();
  private readonly reportHandlers = new Set<ReportHandler>();

  // `profile` is a getter rather than a value so the hub always re-reads the store's latest good
  // profile; it never caches a snapshot that could go stale against a reload.
  constructor(private readonly profile: () => Profile | null) {}

  // Register a newly connected node and immediately tell it what it should have.
  //
  // Pushing on CONNECT (not only on change) is what makes a node that was offline during an edit
  // converge as soon as it comes back, instead of waiting for the next unrelated edit.
  accept(peer: Peer): void {
    this.peers.add(peer);
    peer.onClose(() => this.peers.delete(peer));
    peer.onMessage((raw) => this.onNodeMessage(peer.deviceId, raw));
    this.pushTo(peer);
  }

  // Re-evaluate every connected device against the current profile and push. Called when the profile
  // changes; assignment is re-resolved per device, so a device moved between groups — or dropped from
  // `assignments` entirely — gets the right answer without reconnecting.
  publish(): void {
    for (const peer of [...this.peers]) this.pushTo(peer);
  }

  deviceIds(): string[] {
    return [...this.peers].map((p) => p.deviceId);
  }

  lastApplied(deviceId: string): AppliedMsg | undefined {
    return this.reports.get(deviceId);
  }

  onReport(handler: ReportHandler): () => void {
    this.reportHandlers.add(handler);
    return () => this.reportHandlers.delete(handler);
  }

  private messageFor(deviceId: string): HubMessage | null {
    const profile = this.profile();
    // No profile has ever loaded. Say NOTHING — an "empty desired state" is an instruction to delete
    // every managed file, so an unconfigured hub must be silent rather than destructive.
    if (!profile) return null;
    const state = desiredStateFor(profile, deviceId);
    // `unassigned` and an empty state are deliberately different messages: the first means "this
    // machine is not managed, do not touch it", the second means "you are managed and the answer is
    // nothing", which legitimately empties skills/.
    if (!state) return { t: "unassigned", proto: PROTO_VERSION };
    return { t: "apply", proto: PROTO_VERSION, version: profile.version, state };
  }

  private pushTo(peer: Peer): void {
    const msg = this.messageFor(peer.deviceId);
    if (!msg) return;
    // One dead peer must not abort the broadcast and starve the rest. The peer's own close handling
    // reaps it; there is nothing useful to do with the error here.
    try { peer.send(msg); } catch { /* dropped peer — reaped on close */ }
  }

  private onNodeMessage(deviceId: string, raw: unknown): void {
    const parsed = parseNodeMessage(raw);
    if (!parsed.ok) return; // a malformed frame is dropped, never allowed to crash the hub
    if (parsed.msg.t !== "applied") return;
    this.reports.set(deviceId, parsed.msg);
    for (const h of [...this.reportHandlers]) {
      try { h(deviceId, parsed.msg); } catch { /* ignore */ }
    }
  }
}

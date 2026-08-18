import { z } from "zod";

// Wire protocol version. Bumped whenever a frame's shape changes incompatibly. Both sides REFUSE a
// mismatch rather than guessing — a control channel that half-understands a frame is worse than one
// that admits it can't, because the failure mode is silently applying the wrong desired state.
export const PROTO_VERSION = 1;

// ── Profile (M1 subset of docs/design.md §7) ────────────────────────────────────────────────────
// Only `skills` is modelled here. commands / CLAUDE.md / settings / hooks / MCP / plugins / endpoint
// arrive in later PRs; leaving them out of the schema (rather than accepting-and-ignoring) means a
// profile written against a newer cc-fleet is REJECTED by an older node instead of being silently
// under-applied.
const SkillFile = z.object({
  path: z.string().min(1),
  content: z.string(),
});
const Skill = z.object({
  id: z.string().min(1),
  files: z.array(SkillFile),
});
const Group = z.object({
  skills: z.array(Skill),
});
const Profile = z.object({
  // Monotonic, hand-edited in M1. The node compares it to what it last applied.
  version: z.number().int(),
  groups: z.record(z.string(), Group),
  assignments: z.record(z.string(), z.string()),
});

export type SkillSpec = z.infer<typeof Skill>;
export type DesiredState = z.infer<typeof Group>;
export type Profile = z.infer<typeof Profile>;

export type ParseResult<T> = { ok: true; profile: T } | { ok: false; error: string };

// Parse + validate a raw profile. Returns a reason on failure so the hub can log something the user
// can act on; the hub keeps serving the last good profile rather than broadcasting a partial state.
export function parseProfile(raw: unknown): ParseResult<Profile> {
  const parsed = Profile.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue.path.join(".");
    return { ok: false, error: path ? `${path}: ${issue.message}` : issue.message };
  }
  // A dangling assignment is structurally valid but semantically a typo, and its symptom on the node
  // ("unassigned") looks exactly like a network fault. Catch it here where the cause is obvious.
  for (const [device, group] of Object.entries(parsed.data.assignments)) {
    if (!(group in parsed.data.groups)) {
      return { ok: false, error: `assignments.${device} points at unknown group "${group}"` };
    }
  }
  return { ok: true, profile: parsed.data };
}

// The desired state for one device, or null when the device is not assigned to any group.
//
// null is deliberately NOT "the empty state": an unassigned machine must be left completely alone,
// because apply is full-takeover and an accidental empty state would delete every managed file on a
// machine the user never registered. Never fall back to a default group.
//
// Hostnames are compared case-insensitively — Windows reports an uppercase hostname where the same
// machine's WSL reports lowercase, and a user hand-writing `assignments` should not have to know that.
export function desiredStateFor(profile: Profile, deviceId: string): DesiredState | null {
  const wanted = deviceId.toLowerCase();
  for (const [device, group] of Object.entries(profile.assignments)) {
    if (device.toLowerCase() === wanted) return profile.groups[group] ?? null;
  }
  return null;
}

// ── Frames ──────────────────────────────────────────────────────────────────────────────────────
const Proto = z.literal(PROTO_VERSION);

const Hello = z.object({
  t: z.literal("hello"),
  proto: Proto,
  deviceId: z.string().min(1),
  os: z.string(),
  agentVersion: z.string(),
  appliedVersion: z.number().int(), // 0 = never applied
});
const Applied = z.object({
  t: z.literal("applied"),
  proto: Proto,
  version: z.number().int(),
  ok: z.boolean(),
  written: z.number().int(),
  deleted: z.number().int(),
  warnings: z.array(z.string()),
  error: z.string().optional(),
});
const NodeMessage = z.discriminatedUnion("t", [Hello, Applied]);

const Apply = z.object({
  t: z.literal("apply"),
  proto: Proto,
  version: z.number().int(),
  state: Group,
});
const Unassigned = z.object({
  t: z.literal("unassigned"),
  proto: Proto,
});
const HubMessage = z.discriminatedUnion("t", [Apply, Unassigned]);

export type HelloMsg = z.infer<typeof Hello>;
export type AppliedMsg = z.infer<typeof Applied>;
export type NodeMessage = z.infer<typeof NodeMessage>;
export type ApplyMsg = z.infer<typeof Apply>;
export type NodeMsgResult = { ok: true; msg: NodeMessage } | { ok: false; error: string };
export type HubMessage = z.infer<typeof HubMessage>;
export type HubMsgResult = { ok: true; msg: HubMessage } | { ok: false; error: string };

// A mismatched `proto` surfaces from zod as a field error on a literal; translate it into an explicit
// "protocol version" message so operators see the real cause instead of "invalid literal value".
function frameError(err: z.ZodError, raw: unknown): string {
  const protoIssue = err.issues.find((i) => i.path[0] === "proto");
  if (protoIssue) {
    const got = (raw as { proto?: unknown } | null)?.proto;
    return `protocol version mismatch: expected ${PROTO_VERSION}, got ${String(got)}`;
  }
  const issue = err.issues[0];
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

export function parseNodeMessage(raw: unknown): NodeMsgResult {
  const r = NodeMessage.safeParse(raw);
  return r.success ? { ok: true, msg: r.data } : { ok: false, error: frameError(r.error, raw) };
}
export function parseHubMessage(raw: unknown): HubMsgResult {
  const r = HubMessage.safeParse(raw);
  return r.success ? { ok: true, msg: r.data } : { ok: false, error: frameError(r.error, raw) };
}

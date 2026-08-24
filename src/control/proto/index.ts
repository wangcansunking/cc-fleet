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
// A rule is one file, not a slice of a monolithic CLAUDE.md. A single blob can only be taken over
// wholesale, which makes "ship this rule to these machines" inexpressible; separate files are what
// let rules be grouped and per-device overridden at all. They are concatenated at projection time,
// because each tool still wants one file.
const Rule = z.object({
  id: z.string().min(1),
  content: z.string(),
});
// An MCP server's config is passed through to `claude mcp add-json` verbatim. It is deliberately
// NOT modelled here: the shape belongs to Claude Code, and re-declaring it would mean this schema
// silently rejecting valid configs every time that tool gains a field.
const McpServer = z.object({
  id: z.string().min(1),
  config: z.record(z.string(), z.unknown()),
});
const Group = z.object({
  skills: z.array(Skill),
  // Optional so profiles written before these existed still parse. Absent means "none", which under
  // full takeover legitimately removes them.
  rules: z.array(Rule).default([]),
  mcpServers: z.array(McpServer).default([]),
});

// Per-device adjustments layered on top of a group (docs/design.md §6).
//
// Groups stay the primary mechanism. This is an escape hatch: if every machine needs a stanza here,
// the groups are wrong, and the tool should not make that comfortable.
const DeviceOverride = z.object({
  add: z.object({ skills: z.array(z.string()).default([]), rules: z.array(z.string()).default([]), mcpServers: z.array(z.string()).default([]) }).partial().default({}),
  remove: z.object({ skills: z.array(z.string()).default([]), rules: z.array(z.string()).default([]), mcpServers: z.array(z.string()).default([]) }).partial().default({}),
});
const Profile = z.object({
  // Monotonic, hand-edited in M1. The node compares it to what it last applied.
  version: z.number().int(),
  groups: z.record(z.string(), Group),
  assignments: z.record(z.string(), z.string()),
  devices: z.record(z.string(), DeviceOverride).default({}),
});

export type SkillSpec = z.infer<typeof Skill>;
export type RuleSpec = z.infer<typeof Rule>;
export type McpServerSpec = z.infer<typeof McpServer>;
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
  let group: DesiredState | null = null;
  for (const [device, name] of Object.entries(profile.assignments)) {
    if (device.toLowerCase() === wanted) { group = profile.groups[name] ?? null; break; }
  }
  if (!group) return null;

  const override = Object.entries(profile.devices).find(([d]) => d.toLowerCase() === wanted)?.[1];
  if (!override) return group;

  // `remove` is applied AFTER `add` so that a device listing the same id in both ends up without it.
  // Either order is defensible; this one is the safer default, because the failure it produces
  // (something missing) is visible, while the other (something unexpectedly present) is not.
  const pool = allItems(profile);
  const pick = <T extends { id: string }>(base: T[], addIds: string[], removeIds: string[], available: Map<string, T>): T[] => {
    const byId = new Map(base.map((x) => [x.id, x]));
    for (const id of addIds) { const found = available.get(id); if (found) byId.set(id, found); }
    for (const id of removeIds) byId.delete(id);
    return [...byId.values()];
  };
  return {
    skills: pick(group.skills, override.add?.skills ?? [], override.remove?.skills ?? [], pool.skills),
    rules: pick(group.rules, override.add?.rules ?? [], override.remove?.rules ?? [], pool.rules),
    mcpServers: pick(group.mcpServers, override.add?.mcpServers ?? [], override.remove?.mcpServers ?? [], pool.mcpServers),
  };
}

// Everything defined anywhere in the profile, so a per-device `add` can name an item that lives in
// some OTHER group without duplicating its definition — otherwise "give this one machine the deploy
// runbook too" would mean copying the runbook into a second group and keeping them in sync by hand.
function allItems(profile: Profile) {
  const skills = new Map<string, SkillSpec>();
  const rules = new Map<string, RuleSpec>();
  const mcpServers = new Map<string, McpServerSpec>();
  for (const group of Object.values(profile.groups)) {
    for (const s of group.skills) skills.set(s.id, s);
    for (const r of group.rules) rules.set(r.id, r);
    for (const m of group.mcpServers) mcpServers.set(m.id, m);
  }
  return { skills, rules, mcpServers };
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

// A node offering one of its own items to the hub (docs/design.md §5).
//
// Content travels ONLY here, on an explicit `cc-fleet push`. Nothing a node authors reaches the hub
// by itself — this channel carries instructions the whole fleet may end up executing, so it must be
// two deliberate acts: a person pushes, and a person adopts.
const PushItem = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("skill"), id: z.string().min(1), files: z.array(SkillFile) }),
  z.object({ kind: z.literal("rule"), id: z.string().min(1), content: z.string() }),
  z.object({ kind: z.literal("mcp"), id: z.string().min(1), config: z.record(z.string(), z.unknown()) }),
]);
const Push = z.object({
  t: z.literal("push"),
  proto: Proto,
  item: PushItem,
});

// What the node has of its own. IDS ONLY — never content.
//
// It lets the hub show "laptop-home has 3 local skills you have not adopted" without the fleet
// quietly hoovering up whatever people write on their machines. Curiosity is not consent.
const Inventory = z.object({
  t: z.literal("inventory"),
  proto: Proto,
  skills: z.array(z.string()),
  rules: z.array(z.string()),
  mcpServers: z.array(z.string()),
  conflicts: z.array(z.string()),
});

const NodeMessage = z.discriminatedUnion("t", [Hello, Applied, Push, Inventory]);

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
export type PushMsg = z.infer<typeof Push>;
export type PushItem = z.infer<typeof PushItem>;
export type InventoryMsg = z.infer<typeof Inventory>;
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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The node's own credentials: which hub it belongs to, and the token that proves it.
//
// Stored 0600 alongside the rest of the data dir, exactly like the hub's token — a node's file is the
// enrolment. `cc-fleet join` writes it; later runs reuse it, so a node reconnects without the user
// re-pasting anything.
const file = (dir: string) => join(dir, "fleet-node.json");

export interface NodeCreds {
  hubUrl: string;
  token: string;
  deviceId?: string; // defaults to the hostname; overridable so one machine can pose as another
}

export function readNodeCreds(dir: string): NodeCreds | null {
  const envUrl = process.env.FLEET_HUB_URL;
  const envToken = process.env.FLEET_TOKEN;
  if (envUrl && envToken) return { hubUrl: envUrl, token: envToken, deviceId: process.env.FLEET_DEVICE_ID };
  if (!existsSync(file(dir))) return null;
  try {
    const raw = JSON.parse(readFileSync(file(dir), "utf8")) as Partial<NodeCreds>;
    if (!raw.hubUrl || !raw.token) return null; // a half-written file is no credential at all
    return { hubUrl: raw.hubUrl, token: raw.token, deviceId: raw.deviceId };
  } catch { return null; }
}

export function writeNodeCreds(dir: string, creds: NodeCreds): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file(dir), JSON.stringify(creds), { mode: 0o600 });
}

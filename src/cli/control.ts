import { hostname, homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { startControlHub, DEFAULT_CONTROL_PORT, PROFILE_FILE } from "../control/hub/index.js";
import { DeviceRegistry } from "../control/hub/devices.js";
import { connectHttp } from "../control/transport/http-agent.js";
import { startAgent } from "../control/agent/agent.js";
import { enrollNode } from "../control/agent/enroll-client.js";
import { readNodeCreds, writeNodeCreds } from "../control/agent/creds.js";
import { restoreLatest, listBackups } from "../control/agent/backup.js";
import { dataDir } from "../shared/paths.js";
import { APP_VERSION } from "../version.js";

// CLI surface for the control plane (M1 tracer — docs/specs/2026-08-13-control-m1-tracer.md §9).
//
// These commands live OUTSIDE src/control/ on purpose: control/ must not reach into the rest of the
// app (paths, version, TUI), so the composition happens here, at the edge, where knowing about both
// halves is legitimate.

const claudeHome = (): string => process.env.CLAUDE_HOME ?? join(homedir(), ".claude");

const STARTER_PROFILE = {
  version: 1,
  groups: {
    full: {
      skills: [
        { id: "hello-fleet", files: [{ path: "SKILL.md", content: "---\nname: hello-fleet\ndescription: Pushed by cc-fleet.\n---\n\nThis skill arrived from the fleet hub.\n" }] },
      ],
    },
  },
  assignments: { [hostname()]: "full" },
};

// `cc-fleet hub` — run the control plane in the foreground.
//
// Standalone for now; M2 folds this into the supervisor so the hub is not a second thing to keep
// running. Until then, closing it simply means nodes stop receiving pushes (design §10.2).
export async function runHub(opts: { port?: number; host?: string }): Promise<void> {
  const dir = dataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const profilePath = join(dir, PROFILE_FILE);
  if (!existsSync(profilePath)) {
    writeFileSync(profilePath, JSON.stringify(STARTER_PROFILE, null, 2));
    console.log(`wrote a starter profile at ${profilePath}`);
  }

  const hub = await startControlHub({
    dataDir: dir,
    port: opts.port ?? DEFAULT_CONTROL_PORT,
    host: opts.host ?? "0.0.0.0",
    onProfileError: (e) => console.error(`profile not loaded: ${e}\n  (the hub will serve nothing until this is fixed)`),
    onPublish: (version) => console.log(`profile v${version} published`),
    onReport: (deviceId, r) =>
      console.log(r.ok
        ? `${deviceId}: applied v${r.version} (+${r.written} / -${r.deleted})${r.warnings.length ? ` warnings: ${r.warnings.join("; ")}` : ""}`
        : `${deviceId}: FAILED v${r.version} — ${r.error ?? "unknown error"}`),
  });

  console.log(`cc-fleet hub listening on :${hub.port}`);
  console.log(`profile: ${hub.profilePath}`);
  const code = hub.mintCode();
  console.log(`\nenrol a node with (code is single-use, expires in 5 minutes):\n  cc-fleet join http://<this-machine>:${hub.port} ${code}\n`);
  console.log("run `cc-fleet enroll-code` for another one; codes die when this hub stops.");
  // Say the unsolved part out loud rather than letting enrolment feel like finished security.
  console.log("note: traffic is plain HTTP and a node cannot yet verify it reached the RIGHT hub — keep this on a trusted network until TLS lands.");
  process.on("SIGINT", () => { hub.close(); process.exit(0); });
}

// `cc-fleet enroll-code` — mint another code against a RUNNING hub.
//
// Codes live in the hub's memory, so this cannot be a standalone command that writes a file: it has
// to ask the process that will validate it. Until the hub exposes a local admin socket, the honest
// answer is to point the operator at the running hub rather than silently mint something that will
// never be accepted.
export function runEnrollCode(): void {
  console.error("enrolment codes live inside the running hub process.");
  console.error("Stop and restart `cc-fleet hub` to print a fresh one, or keep the hub in the foreground —");
  console.error("a code minted here could never be validated by that process.");
  process.exitCode = 1;
}

// `cc-fleet devices` — who is enrolled, and are they alive.
export function runDevices(): void {
  const rows = new DeviceRegistry(dataDir()).list();
  if (!rows.length) { console.log("no devices enrolled yet — run `cc-fleet hub` and join one"); return; }
  const now = Date.now();
  const ago = (t: number) => {
    const s = Math.round((now - t) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    return `${Math.round(s / 3600)}h ago`;
  };
  for (const d of rows) {
    const state = d.revokedAt ? `REVOKED ${ago(d.revokedAt)}` : `last seen ${ago(d.lastSeenAt)}`;
    console.log(`${d.deviceId.padEnd(24)} ${d.os.padEnd(8)} v${d.agentVersion.padEnd(10)} ${state}`);
  }
}

// `cc-fleet revoke <deviceId>` — eject one machine.
//
// Takes effect against a RUNNING hub without restarting it: the hub re-reads the registry per
// request and polls it on open streams, so a revoked device is disconnected within seconds.
export function runRevoke(deviceId: string): void {
  if (new DeviceRegistry(dataDir()).revoke(deviceId)) {
    console.log(`revoked ${deviceId} — its token is dead and any live connection drops within seconds`);
    return;
  }
  // Never report success for a device that was not there: an operator who believes a machine was
  // ejected, when it was not, is worse off than one who sees an error.
  console.error(`no active device called ${JSON.stringify(deviceId)} — run \`cc-fleet devices\` to list them`);
  process.exitCode = 1;
}

// `cc-fleet join <hubUrl> <code>` — enrol this machine, then run the node agent in the foreground.
//
// Deliberately does NOT start a worker or trigger a GitHub login: a node should never need a Copilot
// subscription of its own (design §4). Re-running with no arguments reuses the stored credentials —
// the code is spent once, at first join.
export async function runJoin(hubUrl: string | undefined, code: string | undefined, opts: { deviceId?: string }): Promise<void> {
  const dir = dataDir();
  let creds = readNodeCreds(dir);

  if (hubUrl && code) {
    const result = await enrollNode({
      hubUrl, code, hostname: opts.deviceId ?? hostname(), os: process.platform, agentVersion: APP_VERSION,
    });
    if (!result.ok) { console.error(`enrolment failed: ${result.error}`); process.exitCode = 1; return; }
    creds = { hubUrl, token: result.deviceToken, deviceId: result.deviceId };
    writeNodeCreds(dir, creds);
    console.log(`enrolled as ${result.deviceId}`);
  }

  if (!creds) {
    console.error("not enrolled yet — run: cc-fleet join <hubUrl> <code>");
    console.error("(get a code from `cc-fleet hub` on the hub machine)");
    process.exitCode = 1;
    return;
  }

  const deviceId = creds.deviceId ?? hostname();
  const home = claudeHome();
  console.log(`cc-fleet node ${deviceId} → ${creds.hubUrl}`);
  console.log(`managing ${join(home, "skills")} (full takeover; backups in ${join(home, ".cc-fleet", "backups")})`);

  const channel = connectHttp({ hubUrl: creds.hubUrl, token: creds.token, deviceId });
  channel.onError((message) => console.error(`link: ${message}`));
  // A revoked or otherwise rejected credential is terminal. Say so and exit NON-ZERO: a node that was
  // ejected did not finish successfully, and anything supervising this process (systemd, a script, a
  // terminal the user glances at) must be able to tell the difference.
  channel.onFatal((message) => {
    console.error(`\n${message}`);
    console.error(`re-enrol with: cc-fleet join ${creds.hubUrl} <new-code>`);
    // close() + exitCode, never process.exit(): a hard exit races the in-flight fetch and aborts the
    // process (0xC0000409 on Windows), which turns a clear "you were revoked" into a crash.
    channel.close();
    process.exitCode = 1;
  });
  startAgent({
    claudeHome: home, channel, deviceId, agentVersion: APP_VERSION,
    onStatus: (s) => {
      if (s.state === "applied") console.log(`applied v${s.version} (+${s.written} / -${s.deleted})`);
      else if (s.state === "unassigned") console.log(`hub has no assignment for "${deviceId}" — nothing will be changed on this machine`);
      else if (s.state === "error") console.error(`apply failed: ${s.lastError}`);
    },
  });
  process.on("SIGINT", () => { channel.close(); process.exit(0); });
}

// `cc-fleet restore` — undo the last apply from this machine's own backups, with no hub involved.
// The local half of rollback (design §8); pushing an older profile version is the other half.
export function runRestore(): void {
  const home = claudeHome();
  const from = restoreLatest(home);
  if (!from) { console.error(`no backups found under ${join(home, ".cc-fleet", "backups")}`); process.exitCode = 1; return; }
  console.log(`restored ${join(home, "skills")} from ${from}`);
  console.log(`${listBackups(home).length} backup(s) remain`);
}

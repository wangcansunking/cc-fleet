import { hostname, homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { startControlHub, DEFAULT_CONTROL_PORT, PROFILE_FILE } from "../control/hub/index.js";
import { connectHttp } from "../control/transport/http-agent.js";
import { startAgent } from "../control/agent/agent.js";
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
  console.log(`\njoin a node with:\n  cc-fleet join http://<this-machine>:${hub.port} ${hub.token}\n`);
  // A pre-shared token is M1's whole auth story. Say so out loud rather than letting it feel finished.
  console.log("note: this token is shared by every node and cannot be revoked individually yet — keep the hub on a trusted network.");
  process.on("SIGINT", () => { hub.close(); process.exit(0); });
}

// `cc-fleet join <hubUrl> <token>` — run the node agent in the foreground.
//
// Deliberately does NOT start a worker or trigger a GitHub login: a node should never need a Copilot
// subscription of its own (design §4). Re-running with no arguments reuses the stored credentials.
export async function runJoin(hubUrl: string | undefined, token: string | undefined, opts: { deviceId?: string }): Promise<void> {
  const dir = dataDir();
  const stored = readNodeCreds(dir);
  const creds = hubUrl && token
    ? { hubUrl, token, deviceId: opts.deviceId ?? stored?.deviceId }
    : stored;
  if (!creds) {
    console.error("not enrolled yet — run: cc-fleet join <hubUrl> <token>");
    process.exitCode = 1;
    return;
  }
  if (hubUrl && token) writeNodeCreds(dir, creds);

  const deviceId = opts.deviceId ?? creds.deviceId ?? hostname();
  const home = claudeHome();
  console.log(`cc-fleet node ${deviceId} → ${creds.hubUrl}`);
  console.log(`managing ${join(home, "skills")} (full takeover; backups in ${join(home, ".cc-fleet", "backups")})`);

  const channel = connectHttp({ hubUrl: creds.hubUrl, token: creds.token, deviceId });
  channel.onError((message) => console.error(`link: ${message}`));
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

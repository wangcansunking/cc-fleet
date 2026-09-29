import { hostname, homedir } from "node:os";
import { join } from "node:path";
import { startSupervisor } from "../supervisor/index.js";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { startControlHub, DEFAULT_CONTROL_PORT, PROFILE_FILE } from "../control/hub/index.js";
import { DeviceRegistry } from "../control/hub/devices.js";
import { connectHttp } from "../control/transport/http-agent.js";
import { startAgent } from "../control/agent/agent.js";
import { requestDeviceCode, pollForToken } from "../control/agent/enroll-client.js";
import { DeviceAuthRequests } from "../control/hub/device-auth.js";
import { clearNodeCreds, readNodeCreds, writeNodeCreds } from "../control/agent/creds.js";
import { restoreLatest, listBackups, backupsDir } from "../control/agent/backup.js";
import { restoreManagedClients } from "../control/agent/client-config.js";
import { agentsHome, fleetDir } from "../control/agent/store.js";
import { project } from "../control/agent/project.js";
import { readLocalItem } from "../control/agent/local.js";
import { PendingQueue } from "../control/hub/pending.js";
import { ProfileService } from "../control/hub/profile-service.js";
import { PROTO_VERSION } from "../control/proto/index.js";
import { dataDir } from "../shared/paths.js";
import { ensureDaemon, probeSupervisor, spawnSupervisor } from "../daemon/lifecycle.js";
import { setHubEnabled } from "../supervisor/fleet-runtime.js";
import { defaultConfig } from "../shared/config.js";
import { APP_VERSION } from "../version.js";

// CLI surface for the control plane (M1 tracer — docs/specs/2026-08-13-control-m1-tracer.md §9).
//
// These commands live OUTSIDE src/control/ on purpose: control/ must not reach into the rest of the
// app (paths, version, TUI), so the composition happens here, at the edge, where knowing about both
// halves is legitimate.

const claudeHome = (): string => process.env.CLAUDE_HOME ?? join(homedir(), ".claude");

const STARTER_PROFILE = {
  version: 1,
  clients: {
    claude: { model: "claude-opus-5[1m]" },
    codex: { model: "gpt-5.6-sol" },
  },
  groups: {
    full: {
      skills: [
        { id: "hello-fleet", files: [{ path: "SKILL.md", content: "---\nname: hello-fleet\ndescription: Pushed by cc-fleet.\n---\n\nThis skill arrived from the fleet hub.\n" }] },
      ],
      rules: [],
      mcpServers: [],
    },
  },
  assignments: { [hostname()]: "full" },
};

// `cc-fleet hub` uses the detached supervisor when compiled; `npm run dev -- hub` runs it in
// this process so a source checkout needs no dist/ and Ctrl+C tears down its listeners.
// `--foreground` remains the standalone HTTP diagnostic hub, not the supervisor-managed gateway.
export async function runHub(opts: { port?: number; host?: string; foreground?: boolean }): Promise<void> {
  const dir = dataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const profilePath = join(dir, PROFILE_FILE);
  if (!existsSync(profilePath)) {
    writeFileSync(profilePath, JSON.stringify(STARTER_PROFILE, null, 2));
    console.log(`wrote a starter profile at ${profilePath}`);
  }

  if (!opts.foreground) {
    const sourceMode = import.meta.url.endsWith(".ts");
    const alreadyRunning = sourceMode && await probeSupervisor();
    setHubEnabled(dir, true);
    if (sourceMode && !alreadyRunning) {
      const supervisor = startSupervisor();
      await supervisor.ready;
    } else if (!sourceMode) {
      await ensureDaemon({ spawn: spawnSupervisor, probe: probeSupervisor, retries: 60, delayMs: 100 });
    }
    const cfg = defaultConfig();
    const base = `http://${cfg.bindHost}:${cfg.supervisorPort}`;
    const bootstrap = await fetch(`${base}/api/bootstrap`).then((r) => r.json()) as { csrfToken: string };
    const reloaded = await fetch(`${base}/api/fleet/runtime/reload`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base, host: `${cfg.bindHost}:${cfg.supervisorPort}`, "x-cc-fleet-csrf": bootstrap.csrfToken },
      body: "{}",
    });
    if (!reloaded.ok) throw new Error(`supervisor could not enable the hub runtime (${reloaded.status})`);
    console.log("fleet hub enabled — the supervisor now owns the gateway, node agent and devtunnel lifecycle");
    if (sourceMode) console.log(alreadyRunning ? "reused an existing supervisor; close this terminal when finished" : "dev hub running in this terminal — Ctrl+C stops its services");
    console.log(`dashboard: http://${cfg.bindHost}:${cfg.supervisorPort}/`);
    console.log("enable the persistent public tunnel from the local dashboard; the dashboard itself is never exposed");
    return;
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

  console.log(`cc-fleet foreground hub listening on :${hub.port}`);
  console.log(`profile: ${hub.profilePath}`);
  console.log(`\nenrol a node by running this ON THAT MACHINE:\n  cc-fleet join http://<this-machine>:${hub.port}\n`);
  console.log("it will show a code; approve it here with `cc-fleet approve <code>`.");
  console.log("diagnostic mode: this endpoint is plain HTTP; use the supervisor-managed devtunnel for WAN access");
  process.on("SIGINT", () => { hub.close(); process.exit(0); });
}

// `cc-fleet approve [userCode]` — let a waiting machine in.
//
// With no code it lists what is waiting, because approving something you cannot see is how people
// end up admitting a machine they did not set up.
export function runApprove(userCode?: string): void {
  const auth = new DeviceAuthRequests(dataDir());
  if (!userCode) {
    const waiting = auth.listPending();
    if (!waiting.length) { console.log("nothing waiting for approval"); return; }
    for (const r of waiting) {
      const mins = Math.max(0, Math.round((r.expiresAt - Date.now()) / 60_000));
      console.log(`${r.userCode}  ${r.hostname} (${r.os}, v${r.agentVersion})  expires in ~${mins}m`);
    }
    console.log(`\napprove with: cc-fleet approve <code>`);
    return;
  }
  const record = auth.approve(userCode);
  if (!record) {
    console.error(`no pending request for ${JSON.stringify(userCode)} — run \`cc-fleet approve\` to see what is waiting`);
    process.exitCode = 1;
    return;
  }
  // Name what was approved. This machine is now allowed to run whatever the profile says, so the
  // operator should see which one it was, not just that something succeeded.
  console.log(`approved ${record.hostname} (${record.os}) — it will pick up its credential within seconds`);
}

// `cc-fleet deny <userCode>` — refuse a waiting machine.
export function runDeny(userCode: string): void {
  const record = new DeviceAuthRequests(dataDir()).deny(userCode);
  if (!record) {
    console.error(`no pending request for ${JSON.stringify(userCode)}`);
    process.exitCode = 1;
    return;
  }
  console.log(`denied ${record.hostname} (${record.os})`);
}

// `cc-fleet join <hubUrl>` — enrol this machine, then run the node agent in the foreground.
//
// Deliberately does NOT start a worker or trigger a GitHub login: a node should never need a Copilot
// subscription of its own (design §4). Re-running with no arguments reuses the stored credentials.
export async function runJoin(hubUrl: string | undefined, opts: { deviceId?: string; foreground?: boolean }): Promise<void> {
  const dir = dataDir();
  let creds = readNodeCreds(dir);

  if (hubUrl) {
    const started = await requestDeviceCode({
      hubUrl, hostname: opts.deviceId ?? hostname(), os: process.platform, agentVersion: APP_VERSION,
    });
    if (!started.ok) { console.error(`enrolment failed: ${started.error}`); process.exitCode = 1; return; }

    console.log(`\n  approve this machine on the hub:\n\n      cc-fleet approve ${started.start.userCode}\n`);
    process.stdout.write("  waiting…");
    const result = await pollForToken({
      hubUrl, start: started.start,
      onWaiting: () => process.stdout.write("."),
    });
    process.stdout.write("\n");
    if (!result.ok) { console.error(`enrolment failed: ${result.error}`); process.exitCode = 1; return; }

    creds = { hubUrl, token: result.deviceToken, deviceId: result.deviceId };
    writeNodeCreds(dir, creds);
    console.log(`enrolled as ${result.deviceId}`);

  }

  if (!creds) {
    console.error("not enrolled yet — run: cc-fleet join <hubUrl>");
    process.exitCode = 1;
    return;
  }

  if (!opts.foreground) {
    await ensureDaemon({ spawn: spawnSupervisor, probe: probeSupervisor, retries: 60, delayMs: 100 });
    const cfg = defaultConfig();
    const base = `http://${cfg.bindHost}:${cfg.supervisorPort}`;
    const bootstrap = await fetch(`${base}/api/bootstrap`).then((r) => r.json()) as { csrfToken: string };
    const reloaded = await fetch(`${base}/api/fleet/node/reload`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base, host: `${cfg.bindHost}:${cfg.supervisorPort}`, "x-cc-fleet-csrf": bootstrap.csrfToken },
      body: "{}",
    });
    if (!reloaded.ok) throw new Error(`supervisor could not start the node runtime (${reloaded.status})`);
    console.log(`node agent is supervised in the background → ${creds.hubUrl}`);
    return;
  }

  const deviceId = creds.deviceId ?? hostname();
  const home = claudeHome();
  const agents = agentsHome();
  console.log(`cc-fleet node ${deviceId} → ${creds.hubUrl}`);
  console.log(`store:   ${agents}  (fleet/ is hub-managed; local/ is yours and never touched)`);
  console.log(`projects to: ${join(home, "skills")} and ${join(home, "CLAUDE.md")} — both are GENERATED`);
  // The layered store's one real cost: the obvious place to edit is no longer the right one. Say it
  // at every start rather than letting people discover it by losing work.
  console.log(`edit skills and rules in ${join(agents, "local")}, not in ${home}`);

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
    agentsHome: agents, claudeHome: home, channel, deviceId, agentVersion: APP_VERSION,
    onMigrate: (ids) =>
      console.log(`migrated ${ids.length} pre-existing skill(s) into ${join(agents, "local", "skills")}: ${ids.join(", ")}`),
    onStatus: (s) => {
      if (s.state === "applied") {
        console.log(`applied v${s.version} (store +${s.written} / -${s.deleted}, projected ${s.projected})`);
        for (const id of s.conflicts ?? []) console.log(`  note: your local "${id}" overrides the fleet copy`);
        if (s.mcp?.added.length) console.log(`  mcp: added ${s.mcp.added.join(", ")}`);
        if (s.mcp?.removed.length) console.log(`  mcp: removed ${s.mcp.removed.join(", ")}`);
        for (const w of s.mcp?.warnings ?? []) console.log(`  mcp: ${w}`);
      }
      else if (s.state === "unassigned") console.log(`hub has no assignment for "${deviceId}" — nothing will be changed on this machine`);
      else if (s.state === "error") console.error(`apply failed: ${s.lastError}`);
    },
  });
  process.on("SIGINT", () => { channel.close(); process.exit(0); });
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

// `cc-fleet push <kind>/<id>` — offer one of THIS machine's own items to the hub.
//
// Content leaves the node only here, and only because someone typed this. The hub stores it in a
// pending inbox; it becomes fleet config when a person on the hub adopts it, never before.
export async function runPush(ref: string): Promise<void> {
  const [kindRaw, ...rest] = ref.split("/");
  const id = rest.join("/");
  const kinds = { skill: "skill", skills: "skill", rule: "rule", rules: "rule", mcp: "mcp" } as const;
  const kind = kinds[kindRaw as keyof typeof kinds];
  if (!kind || !id) {
    console.error(`usage: cc-fleet push <skill|rule|mcp>/<id>   e.g. cc-fleet push skill/my-thing`);
    process.exitCode = 1;
    return;
  }

  const dir = dataDir();
  const creds = readNodeCreds(dir);
  if (!creds) { console.error("not enrolled — run: cc-fleet join <hubUrl> <code>"); process.exitCode = 1; return; }

  const agents = agentsHome();
  const loaded = readLocalItem(agents, kind, id);
  if (!loaded.ok) { console.error(loaded.error); process.exitCode = 1; return; }

  const deviceId = creds.deviceId ?? hostname();
  const channel = connectHttp({ hubUrl: creds.hubUrl, token: creds.token, deviceId });
  // The stream must be up before a POST can be routed to this device's peer, so wait for the hub's
  // first frame rather than firing blind and reporting a success that never arrived.
  const sent = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 15_000);
    channel.onFatal(() => { clearTimeout(timer); resolve(false); });
    const off = channel.onMessage(() => {
      off();
      clearTimeout(timer);
      channel.send({ t: "push", proto: PROTO_VERSION, item: loaded.item });
      // Give the POST a moment to land before tearing the channel down.
      setTimeout(() => resolve(true), 500);
    });
  });
  channel.close();

  if (!sent) { console.error(`could not reach the hub at ${creds.hubUrl}`); process.exitCode = 1; return; }
  console.log(`pushed ${kind}/${id} to ${creds.hubUrl}`);
  console.log(`it is now PENDING — someone on the hub must run: cc-fleet adopt ${deviceId} ${kind}/${id} --group <group>`);
}

// `cc-fleet pending` — what nodes have offered, on the hub.
export function runPending(): void {
  const entries = new PendingQueue(dataDir()).list();
  if (!entries.length) { console.log("nothing pending"); return; }
  for (const e of entries) {
    const size = e.item.kind === "skill" ? `${e.item.files.length} file(s)` : "";
    console.log(`${e.deviceId.padEnd(20)} ${e.item.kind.padEnd(6)} ${e.item.id.padEnd(24)} ${size}`);
  }
  console.log(`\nadopt with:  cc-fleet adopt <device> <kind>/<id> --group <group>`);
  console.log(`reject with: cc-fleet reject <device> <kind>/<id>`);
}

// `cc-fleet adopt <device> <kind>/<id> --group <group>` — make a pushed item fleet config.
export async function runAdopt(device: string, ref: string, opts: { group?: string }): Promise<void> {
  const [kind, ...rest] = ref.split("/");
  const id = rest.join("/");
  const group = opts.group;
  if (!kind || !id || !group) {
    console.error("usage: cc-fleet adopt <device> <skill|rule|mcp>/<id> --group <group>");
    process.exitCode = 1;
    return;
  }
  const dir = dataDir();
  const queue = new PendingQueue(dir);
  const entry = queue.find(device, kind, id);
  if (!entry) { console.error(`nothing pending from ${device} for ${kind}/${id} — run \`cc-fleet pending\``); process.exitCode = 1; return; }

  const service = new ProfileService(dir, join(dir, PROFILE_FILE));
  const live = service.readLive();
  if (!live.ok) { console.error(`adoption failed: ${live.error}`); process.exitCode = 1; return; }
  const result = await service.adopt(group, entry.item, live.revision);
  if (!result.ok) { console.error(`adoption failed: ${result.error}`); process.exitCode = 1; return; }

  queue.drop(device, kind, id);
  console.log(`${result.replaced ? "replaced" : "added"} ${kind}/${id} in group "${group}" — profile is now v${result.version}`);
  console.log("a running hub picks this up within seconds; nodes follow.");
}

// `cc-fleet reject <device> <kind>/<id>` — drop an offer without adopting it.
export function runReject(device: string, ref: string): void {
  const [kind, ...rest] = ref.split("/");
  const id = rest.join("/");
  if (new PendingQueue(dataDir()).drop(device, kind, id)) {
    console.log(`rejected ${kind}/${id} from ${device}`);
    return;
  }
  console.error(`nothing pending from ${device} for ${kind}/${id}`);
  process.exitCode = 1;
}

// `cc-fleet restore` — undo the last apply from this machine's own backups, with no hub involved.
// The local half of rollback (design §8); pushing an older profile version is the other half.
export function runRestore(): void {
  const agents = agentsHome();
  const from = restoreLatest(agents, fleetDir(agents));
  if (!from) { console.error(`no backups found under ${backupsDir(agents)}`); process.exitCode = 1; return; }
  console.log(`restored ${fleetDir(agents)} from ${from}`);
  // Restoring the store alone would leave the tools showing the state we just rolled back from, so
  // reproject immediately — a rollback the user cannot see has not happened as far as they know.
  const projected = project(agents, claudeHome());
  console.log(`reprojected ${projected.written.length} file(s) into ${claudeHome()}`);
  console.log(`${listBackups(agents).length} backup(s) remain`);
}

// `cc-fleet leave` restores the exact Claude/Codex files that existed before fleet management.
export function runLeave(): void {
  const restored = restoreManagedClients(agentsHome(), homedir());
  if (!restored.ok) { console.error(`could not restore client configuration: ${restored.error}`); process.exitCode = 1; return; }
  clearNodeCreds(dataDir());
  console.log("restored pre-fleet Claude and Codex client configuration");
  console.log("removed this machine's fleet credential; run `cc-fleet join <url>` to enrol again");
}

import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");

const root = fileURLToPath(new URL("../", import.meta.url));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const processes: ChildProcess[] = [];
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(processes.splice(0).map(async (child) => {
    if (child.exitCode !== null) return;
    const exited = once(child, "exit");
    if (!child.killed) child.kill();
    await Promise.race([exited, sleep(2_000)]);
  }));
  await until(async () => {
    const [admin, worker, gateway, diagnostic] = await Promise.all([7990, 7991, 7992, 7993].map((port) =>
      json(`http://127.0.0.1:${port}/healthz`)));
    return admin === undefined && worker === undefined && gateway === undefined && diagnostic === undefined ? true : undefined;
  }, 5_000);
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

async function json(url: string): Promise<{ status: number; body: any } | undefined> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(750) });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch { return undefined; }
}

async function until<T>(probe: () => Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
  const expires = Date.now() + timeoutMs;
  while (Date.now() < expires) {
    const value = await probe();
    if (value) return value;
    await sleep(125);
  }
  throw new Error("timed out waiting for development Hub to become ready");
}

function start(args: string[], home: string): { child: ChildProcess; output: () => string } {
  const child = spawn(process.execPath, [tsxCli, "src/cli/index.ts", ...args], {
    cwd: root,
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_HOME: join(home, ".claude"), AGENTS_HOME: join(home, ".agents") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  processes.push(child);
  let out = "";
  child.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
  child.stderr?.on("data", (d: Buffer) => { out += d.toString(); });
  return { child, output: () => out };
}

describe("source-only Hub development command", () => {
  it("boots dashboard, Worker, and gateway with no compiled supervisor", async () => {
    const home = mkdtempSync(join(tmpdir(), "cc-dev-hub-"));
    homes.push(home);
    const data = join(home, ".cc-fleet");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "creds.json"), JSON.stringify({ ghToken: "ghu_dummy0000000000000000000000000000000" }));
    const { child, output } = start(["hub"], home);
    const status = await until(async () => {
      if (child.exitCode !== null) throw new Error(`dev Hub exited early: ${output()}`);
      const res = await json("http://127.0.0.1:7990/api/status");
      return res?.body?.workerState === "ready" ? res : undefined;
    });
    expect(status.status).toBe(200);
    expect((await json("http://127.0.0.1:7991/healthz"))?.body).toEqual({ ok: true });
    expect((await json("http://127.0.0.1:7992/healthz"))?.body).toEqual({ ok: true });
    expect((await json("http://127.0.0.1:7992/api/status"))?.status).toBe(404);
    expect((await json("http://127.0.0.1:7990/api/fleet/summary"))?.body?.hub).toBe("ready");
    expect(JSON.parse(readFileSync(join(data, "runtime.json"), "utf8"))).toMatchObject({ hubEnabled: true });
    expect(output()).toContain("dashboard: http://127.0.0.1:7990/");
    expect(child.exitCode).toBeNull();

    // A second source command enables/reloads the existing Hub; it must not bind duplicate listeners.
    const second = start(["hub"], home);
    await until(async () => second.output().includes("reused an existing supervisor") ? true : undefined);
    expect(second.output()).toContain("reused an existing supervisor");
    expect(second.output()).toContain("dashboard: http://127.0.0.1:7990/");
    expect((await json("http://127.0.0.1:7992/healthz"))?.status).toBe(200);
    expect(child.exitCode).toBeNull();
  }, 25_000);

  it("keeps --foreground as an independent diagnostic Hub without launching a supervisor", async () => {
    const home = mkdtempSync(join(tmpdir(), "cc-dev-foreground-"));
    homes.push(home);
    const { child, output } = start(["hub", "--foreground", "--host", "127.0.0.1", "--port", "7993"], home);
    await until(async () => {
      if (child.exitCode !== null) throw new Error(`foreground hub exited early: ${output()}`);
      return output().includes("foreground hub listening on :7993") ? true : undefined;
    });
    expect((await json("http://127.0.0.1:7993/healthz"))?.status).toBe(404);
    expect(output()).toContain("foreground hub listening on :7993");
    expect((await json("http://127.0.0.1:7990/api/status"))?.status).not.toBe(200);
    expect(child.exitCode).toBeNull();
  }, 20_000);
});

import { spawn as nodeSpawn, spawnSync, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";

const MAX_ERROR = 500;
const firstLine = (s: string): string => s.trim().split(/\r?\n/)[0].slice(0, MAX_ERROR);

export interface CommandResult { status: number | null; stdout: string; stderr: string }
export type CommandExecutor = (args: string[]) => Promise<CommandResult>;
export type SpawnExecutor = (command: string, args: readonly string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
export interface TunnelUser { loggedIn: boolean; username?: string }
export interface TunnelDetails { tunnelId: string; publicUrl: string | null }
export interface LineProcess {
  kill(): void;
  on(event: "line", handler: (line: string) => void): this;
  on(event: "exit", handler: (code: number | null) => void): this;
}

async function defaultExec(args: string[]): Promise<CommandResult> {
  const r = spawnSync("devtunnel", args, { encoding: "utf8", shell: false, timeout: 30_000 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? (r.error?.message ?? "") };
}

function jsonObject(text: string): Record<string, unknown> {
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("response was not a JSON object");
  return parsed as Record<string, unknown>;
}
function stringAt(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) if (typeof obj[key] === "string" && obj[key]) return obj[key] as string;
  return undefined;
}
function tunnelIdOf(obj: Record<string, unknown>): string | undefined {
  return stringAt(obj, "tunnelId", "tunnel_id", "id")
    ?? (obj.tunnel && typeof obj.tunnel === "object" ? stringAt(obj.tunnel as Record<string, unknown>, "tunnelId", "tunnel_id", "id") : undefined);
}
function urlOf(obj: Record<string, unknown>): string | null {
  const direct = stringAt(obj, "publicUrl", "connectUrl", "webForwardingUri");
  if (direct?.startsWith("https://") && !direct.includes("-inspect.")) return direct.replace(/\/+$/, "");
  const ports = Array.isArray(obj.ports) ? obj.ports : [];
  for (const p of ports) {
    if (!p || typeof p !== "object") continue;
    const url = stringAt(p as Record<string, unknown>, "uri", "url", "webForwardingUri");
    if (url?.startsWith("https://") && !url.includes("-inspect.")) return url.replace(/\/+$/, "");
  }
  return null;
}

class ChildLines extends EventTarget implements LineProcess {
  private readonly handlers = new Map<string, Set<(...args: any[]) => void>>();
  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    super();
    let out = "";
    const feed = (chunk: Buffer) => {
      out += chunk.toString();
      const lines = out.split(/\r?\n/);
      out = lines.pop() ?? "";
      for (const line of lines) this.emit("line", line);
    };
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);
    child.on("exit", (code) => { if (out) this.emit("line", out); this.emit("exit", code); });
  }
  on(event: "line" | "exit", handler: (...args: any[]) => void): this {
    const set = this.handlers.get(event) ?? new Set();
    set.add(handler); this.handlers.set(event, set); return this;
  }
  kill(): void { this.child.kill(); }
  private emit(event: string, ...args: any[]): void {
    for (const h of this.handlers.get(event) ?? []) h(...args);
  }
}

export class DevTunnelCli {
  constructor(
    private readonly exec: CommandExecutor = defaultExec,
    private readonly spawn: SpawnExecutor = nodeSpawn as SpawnExecutor,
  ) {}

  private async run(args: string[], label: string): Promise<Record<string, unknown>> {
    const r = await this.exec(args);
    if (r.status !== 0) throw new Error(`devtunnel ${label} failed: ${firstLine(r.stderr || r.stdout || `exit ${r.status}`)}`);
    try { return jsonObject(r.stdout || "{}"); }
    catch (e) { throw new Error(`devtunnel ${label} returned invalid JSON: ${(e as Error).message}`); }
  }

  async available(): Promise<boolean> {
    try { return (await this.exec(["--version"])).status === 0; } catch { return false; }
  }

  async user(): Promise<TunnelUser> {
    const obj = await this.run(["user", "show", "--json"], "user show");
    const status = stringAt(obj, "status")?.toLowerCase();
    return { loggedIn: status === "logged in" || status === "loggedin", username: stringAt(obj, "username", "userName") };
  }

  async create(): Promise<string> {
    const obj = await this.run([
      "create", "--allow-anonymous", "--labels", "cc-fleet", "--description", "cc-fleet fleet gateway", "--json",
    ], "create");
    const id = tunnelIdOf(obj);
    if (!id) throw new Error("devtunnel create returned no tunnel id");
    return id;
  }

  async ensurePort(tunnelId: string, port: number): Promise<void> {
    const listed = await this.exec(["port", "list", tunnelId, "--json"]);
    if (listed.status === 0) {
      try {
        const parsed = JSON.parse(listed.stdout) as unknown;
        const rows = Array.isArray(parsed) ? parsed : Array.isArray((parsed as any)?.ports) ? (parsed as any).ports : [];
        if (rows.some((p: any) => Number(p?.portNumber ?? p?.port) === port)) return;
      } catch { /* create below; a malformed list is not proof the port exists */ }
    }
    await this.run([
      "port", "create", tunnelId, "--port-number", String(port), "--protocol", "http", "--request-timeout", "0", "--json",
    ], "port create");
  }

  async show(tunnelId: string): Promise<TunnelDetails> {
    const obj = await this.run(["show", tunnelId, "--json"], "show");
    return { tunnelId: tunnelIdOf(obj) ?? tunnelId, publicUrl: urlOf(obj) };
  }

  host(tunnelId: string): LineProcess {
    return new ChildLines(this.spawn("devtunnel", ["host", tunnelId], { shell: false, windowsHide: true }));
  }

  loginDeviceCode(onLine: (line: string) => void): LineProcess {
    const child = new ChildLines(this.spawn("devtunnel", ["user", "login", "--use-device-code-auth"], { shell: false, windowsHide: true }));
    child.on("line", onLine);
    return child;
  }

  async remove(tunnelId: string, force: boolean): Promise<void> {
    await this.run(["delete", tunnelId, ...(force ? ["--force"] : []), "--json"], "delete");
  }
}

export function parsePublicUrl(line: string): string | null {
  if (/inspect/i.test(line)) return null;
  const found = line.match(/https:\/\/[^\s,]+\.devtunnels\.ms(?::\d+)?\/?/i)?.[0];
  return found ? found.replace(/[),.;]+$/, "").replace(/\/+$/, "") : null;
}

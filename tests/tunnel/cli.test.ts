import { describe, it, expect, vi } from "vitest";
import { DevTunnelCli, parsePublicUrl, type CommandExecutor } from "../../src/tunnel/cli.js";

function runner(results: Array<{ status?: number | null; stdout?: string; stderr?: string }> = []): { exec: CommandExecutor; calls: string[][] } {
  const calls: string[][] = [];
  const exec: CommandExecutor = async (args) => {
    calls.push(args);
    const next = results.shift() ?? { status: 0, stdout: "{}" };
    return { status: next.status ?? 0, stdout: next.stdout ?? "", stderr: next.stderr ?? "" };
  };
  return { exec, calls };
}

describe("DevTunnelCli", () => {
  it("uses argv arrays for availability and login status", async () => {
    const r = runner([
      { stdout: "Tunnel CLI version: 1.0.0" },
      { stdout: JSON.stringify({ status: "Logged in", username: "owner@example.com" }) },
    ]);
    const cli = new DevTunnelCli(r.exec);
    expect(await cli.available()).toBe(true);
    expect(await cli.user()).toMatchObject({ loggedIn: true, username: "owner@example.com" });
    expect(r.calls).toEqual([["--version"], ["user", "show", "--json"]]);
  });

  it("creates a labelled persistent anonymous tunnel then adds the one gateway port", async () => {
    const r = runner([
      { stdout: JSON.stringify({ tunnelId: "fleet-abc" }) },
      { stdout: JSON.stringify({ ports: [] }) },
      { stdout: JSON.stringify({ portNumber: 7992 }) },
    ]);
    const cli = new DevTunnelCli(r.exec);
    expect(await cli.create()).toBe("fleet-abc");
    await cli.ensurePort("fleet-abc", 7992);
    expect(r.calls[0]).toEqual([
      "create", "--allow-anonymous", "--labels", "cc-fleet", "--description", "cc-fleet fleet gateway", "--json",
    ]);
    expect(r.calls[1]).toEqual(["port", "list", "fleet-abc", "--json"]);
    expect(r.calls[2]).toEqual([
      "port", "create", "fleet-abc", "--port-number", "7992", "--protocol", "http", "--request-timeout", "0", "--json",
    ]);
  });

  it("does not interpolate a tunnel id through a shell", async () => {
    const r = runner([{ stdout: "{}" }]);
    const cli = new DevTunnelCli(r.exec);
    await cli.remove("x; rm -rf /", true);
    expect(r.calls[0]).toEqual(["delete", "x; rm -rf /", "--force", "--json"]);
  });

  it("returns bounded actionable command errors", async () => {
    const r = runner([
      { status: 1, stderr: `not logged in\n${"x".repeat(8000)}` },
      { status: 1, stderr: `not logged in\n${"x".repeat(8000)}` },
    ]);
    const cli = new DevTunnelCli(r.exec);
    await expect(cli.user()).rejects.toThrow(/^devtunnel user show failed: not logged in/);
    await expect(cli.user()).rejects.not.toThrow(/x{1000}/);
  });

  it("starts device-code login as an explicit streaming process", () => {
    const spawn = vi.fn(() => ({
      stdout: { on: vi.fn() }, stderr: { on: vi.fn() },
      on: vi.fn(), kill: vi.fn(),
    })) as any;
    const cli = new DevTunnelCli(undefined, spawn);
    cli.loginDeviceCode(() => {});
    expect(spawn).toHaveBeenCalledWith(
      "devtunnel", ["user", "login", "--use-device-code-auth"],
      expect.objectContaining({ shell: false }),
    );
  });
});

describe("parsePublicUrl", () => {
  it("accepts the documented host output forms", () => {
    expect(parsePublicUrl("Hosting port 7992 at https://abc-7992.usw2.devtunnels.ms/"))
      .toBe("https://abc-7992.usw2.devtunnels.ms");
    expect(parsePublicUrl("Connect via browser: https://abc-7992.devtunnels.ms"))
      .toBe("https://abc-7992.devtunnels.ms");
  });

  it("never mistakes the inspect endpoint for the public URL", () => {
    expect(parsePublicUrl("Inspect network activity: https://abc-7992-inspect.usw2.devtunnels.ms/"))
      .toBeNull();
  });
});

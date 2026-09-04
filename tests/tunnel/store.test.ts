import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTunnelConfig, writeTunnelConfig } from "../../src/tunnel/store.js";

const dir = () => mkdtempSync(join(tmpdir(), "cc-tunnel-store-"));

describe("tunnel config store", () => {
  it("round-trips the persistent tunnel identity without auth tokens", () => {
    const d = dir();
    writeTunnelConfig(d, { enabled: true, tunnelId: "fleet-123", port: 7992, publicUrl: "https://fleet-123-7992.devtunnels.ms" });
    expect(readTunnelConfig(d)).toEqual({ enabled: true, tunnelId: "fleet-123", port: 7992, publicUrl: "https://fleet-123-7992.devtunnels.ms" });
    expect(readFileSync(join(d, "tunnel.json"), "utf8")).not.toMatch(/token|secret/i);
  });

  it("writes a private file on POSIX", () => {
    const d = dir();
    writeTunnelConfig(d, { enabled: false, port: 7992 });
    if (process.platform !== "win32") expect(statSync(join(d, "tunnel.json")).mode & 0o777).toBe(0o600);
  });

  it("fails safe on missing, corrupt or malformed state", () => {
    const d = dir();
    expect(readTunnelConfig(d)).toEqual({ enabled: false, port: 7992 });
    writeFileSync(join(d, "tunnel.json"), "{broken");
    expect(readTunnelConfig(d)).toEqual({ enabled: false, port: 7992 });
    writeFileSync(join(d, "tunnel.json"), JSON.stringify({ enabled: "yes", tunnelId: 7, port: -1 }));
    expect(readTunnelConfig(d)).toEqual({ enabled: false, port: 7992 });
  });
});

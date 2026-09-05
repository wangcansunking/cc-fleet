import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRuntimeConfig, setHubEnabled, startFleetRuntime } from "../../src/supervisor/fleet-runtime.js";
import { defaultConfig } from "../../src/shared/config.js";

const dir = () => mkdtempSync(join(tmpdir(), "cc-runtime-"));

describe("fleet runtime role store", () => {
  it("is disabled by default and enables hub atomically", () => {
    const d = dir();
    expect(readRuntimeConfig(d)).toEqual({ hubEnabled: false });
    setHubEnabled(d, true);
    expect(readRuntimeConfig(d)).toEqual({ hubEnabled: true });
    expect(JSON.parse(readFileSync(join(d, "runtime.json"), "utf8"))).toEqual({ hubEnabled: true });
  });
});

describe("fleet runtime composition", () => {
  it("starts a loopback gateway with a starter profile when hub role is enabled", async () => {
    const d = dir();
    setHubEnabled(d, true);
    const runtime = await startFleetRuntime({
      dataDir: d,
      config: { ...defaultConfig(), gatewayPort: 0 },
      startTunnel: false,
    });
    try {
      expect(runtime.hub).toBeDefined();
      expect(runtime.gatewayPort).toBeGreaterThan(0);
      const res = await fetch(`http://127.0.0.1:${runtime.gatewayPort}/healthz`);
      expect(res.status).toBe(200);
      expect(runtime.profileService?.readLive().ok).toBe(true);
    } finally { runtime.stop(); }
  });

  it("injects runtime URL/key plus each device's effective models without storing secrets in profile", async () => {
    const d = dir();
    setHubEnabled(d, true);
    const runtime = await startFleetRuntime({ dataDir: d, config: { ...defaultConfig(), gatewayPort: 0 }, startTunnel: false });
    try {
      const h = runtime.hub!;
      const profilePath = join(d, "profile.json");
      const configured = JSON.parse(readFileSync(profilePath, "utf8"));
      configured.assignments.laptop = "full";
      configured.version += 1;
      writeFileSync(profilePath, JSON.stringify(configured));
      h.store.load();
      const { deviceToken } = h.devices.enroll({ hostname: "laptop", os: "linux", agentVersion: "test" });
      const response = await fetch(`http://127.0.0.1:${runtime.gatewayPort}/control/events?deviceId=laptop`, {
        headers: { authorization: `Bearer ${deviceToken}` },
      });
      const reader = response.body!.getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      await reader.cancel();
      // No public URL while the tunnel is disabled, so client config is intentionally omitted.
      expect(first).toContain('"t":"apply"');
      expect(first).not.toContain('"apiKey"');
      expect(readFileSync(join(d, "profile.json"), "utf8")).not.toContain("access key");
    } finally { runtime.stop(); }
  });

  it("does not start a hub or gateway on a node-only machine", async () => {
    const d = dir();
    const runtime = await startFleetRuntime({ dataDir: d, config: { ...defaultConfig(), gatewayPort: 0 }, startTunnel: false });
    try {
      expect(runtime.hub).toBeUndefined();
      expect(runtime.gatewayPort).toBeUndefined();
    } finally { runtime.stop(); }
  });

  it("enables hub role in an already-running supervisor after runtime.json changes", async () => {
    const d = dir();
    const runtime = await startFleetRuntime({ dataDir: d, config: { ...defaultConfig(), gatewayPort: 0 }, startTunnel: false });
    try {
      expect(runtime.hub).toBeUndefined();
      setHubEnabled(d, true);
      await runtime.reloadRoles();
      expect(runtime.hub).toBeDefined();
      expect(runtime.gatewayPort).toBeGreaterThan(0);
      expect((await fetch(`http://127.0.0.1:${runtime.gatewayPort}/healthz`)).status).toBe(200);
    } finally { runtime.stop(); }
  });
});

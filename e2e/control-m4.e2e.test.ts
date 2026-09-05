import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFleetRuntime, setHubEnabled } from "../src/supervisor/fleet-runtime.js";
import { defaultConfig } from "../src/shared/config.js";
import { readAccessKey } from "../src/shared/network.js";
import { requestDeviceCode, pollForToken } from "../src/control/agent/enroll-client.js";
import { connectHttp } from "../src/control/transport/http-agent.js";
import { startAgent } from "../src/control/agent/agent.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const c of cleanups.splice(0).reverse()) c(); });

async function worker() {
  const app = express(); app.use(express.json());
  app.post("/anthropic/v1/messages", (req, res) => res.json({ type: "message", role: "assistant", content: [{ type: "text", text: `hub:${req.body.model}` }] }));
  app.post("/openai/responses", (req, res) => res.json({ id: "r", object: "response", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: `hub:${req.body.model}` }] }] }));
  const server = createServer(app); await new Promise<void>((r) => server.listen(0, "127.0.0.1", r)); cleanups.push(() => server.close());
  const addr = server.address(); return `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
}

async function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "cc-m4-hub-"));
  setHubEnabled(dataDir, true);
  const runtime = await startFleetRuntime({ dataDir, config: { ...defaultConfig(), gatewayPort: 0 }, startTunnel: false, workerBaseUrl: await worker() });
  cleanups.push(() => runtime.stop());
  const base = `http://127.0.0.1:${runtime.gatewayPort}`;
  const profilePath = join(dataDir, "profile.json");
  const profile = JSON.parse(readFileSync(profilePath, "utf8"));
  profile.assignments.nodebox = "full";
  profile.devices = { nodebox: { override: { claude: { model: "claude-sonnet-5[1m]" }, codex: { model: "gpt-5.6-terra" } } } };
  profile.version += 1;
  writeFileSync(profilePath, JSON.stringify(profile));
  runtime.hub!.store.load();
  return { dataDir, runtime, base };
}

describe("M4 gateway — control and LLM on one public data-plane port", () => {
  it("enrols, applies, and proxies both protocols while keeping admin paths absent", async () => {
    const { runtime, base, dataDir } = await fixture();
    const started = await requestDeviceCode({ hubUrl: base, hostname: "nodebox", os: "linux", agentVersion: "e2e" });
    if (!started.ok) throw new Error(started.error);
    runtime.hub!.auth.approve(started.start.userCode);
    const enrolled = await pollForToken({ hubUrl: base, start: started.start, sleep: async () => {} });
    if (!enrolled.ok) throw new Error(enrolled.error);

    const agents = mkdtempSync(join(tmpdir(), "cc-m4-agents-"));
    const userHome = mkdtempSync(join(tmpdir(), "cc-m4-user-"));
    const channel = connectHttp({ hubUrl: base, token: enrolled.deviceToken, deviceId: enrolled.deviceId, retryMs: 20, maxRetryMs: 50 });
    const agent = startAgent({ agentsHome: agents, claudeHome: join(userHome, ".claude"), userHome, channel, deviceId: enrolled.deviceId, agentVersion: "e2e" });
    cleanups.push(() => { agent.stop(); channel.close(); });
    // Tunnel is disabled in this hermetic case: ordinary config applies, but no half-ready public URL is written.
    await vi.waitFor(() => expect(agent.status().state).toBe("applied"), { timeout: 5000 });
    expect(agent.status().clients).toBeUndefined();

    const key = readAccessKey(dataDir)!;
    const anthropic = await fetch(`${base}/anthropic/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": key }, body: JSON.stringify({ model: "claude-sonnet-5" }) });
    expect(await anthropic.json()).toMatchObject({ content: [{ text: "hub:claude-sonnet-5" }] });
    const openai = await fetch(`${base}/openai/responses`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify({ model: "gpt-5.6-terra" }) });
    expect(await openai.json()).toMatchObject({ output: [{ content: [{ text: "hub:gpt-5.6-terra" }] }] });
    expect((await fetch(`${base}/api/status`)).status).toBe(404);
    expect((await fetch(`${base}/`)).status).toBe(404);
  }, 20000);
});

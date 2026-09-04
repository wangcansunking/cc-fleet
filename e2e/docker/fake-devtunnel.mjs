#!/usr/bin/env node
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const file = process.env.FAKE_DEVTUNNEL_STATE || "/tmp/fake-devtunnel.json";
const args = process.argv.slice(2);
const read = () => existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
const write = (value) => writeFileSync(file, JSON.stringify(value));
const json = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

if (args[0] === "--version") {
  process.stdout.write("Tunnel CLI version: 1.0.fake\n");
} else if (args[0] === "user" && args[1] === "show") {
  json({ status: "Logged in", provider: "microsoft", username: "docker@example.test" });
} else if (args[0] === "user" && args[1] === "login") {
  process.stdout.write("Open https://microsoft.com/devicelogin and enter code DOCKER-CODE\n");
} else if (args[0] === "create") {
  const state = { tunnelId: "docker-fleet.test", ports: [], deleted: false };
  write(state); json({ tunnelId: state.tunnelId });
} else if (args[0] === "port" && args[1] === "list") {
  json({ ports: read().ports ?? [] });
} else if (args[0] === "port" && args[1] === "create") {
  const state = read();
  const at = args.indexOf("--port-number");
  const portNumber = Number(args[at + 1]);
  state.ports = [{ portNumber, protocol: "http", uri: `https://docker-fleet-${portNumber}.devtunnels.ms` }];
  write(state); json(state.ports[0]);
} else if (args[0] === "show") {
  const state = read();
  json({ tunnelId: state.tunnelId, ports: state.ports ?? [] });
} else if (args[0] === "host") {
  const state = read();
  const port = state.ports?.[0]?.portNumber ?? 7992;
  process.stdout.write(`Hosting port ${port} at https://docker-fleet-${port}.devtunnels.ms/\n`);
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 60_000);
} else if (args[0] === "delete") {
  rmSync(file, { force: true }); json({ deleted: true });
} else {
  process.stderr.write(`unsupported fake devtunnel args: ${args.join(" ")}\n`);
  process.exit(2);
}

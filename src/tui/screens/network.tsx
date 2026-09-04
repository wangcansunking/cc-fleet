import React from "react";
import { Box, Text } from "ink";
import { Select } from "../components/select.js";
import { theme } from "../theme.js";
import type { AccessMode } from "../../shared/network.js";

export interface NetworkInfo {
  mode: AccessMode;
  key: string | null;
  lanUrl: string | null; // e.g. http://192.168.1.20:7991 — the address other machines use, when known
}

export type NetworkAction = "lan" | "localhost" | "rotate" | "back";

// View + change the network ACCESS MODE. localhost (loopback only) vs LAN (bound to the network,
// guarded by a mandatory key). Shows the current posture, reveals the key (the user must copy it into
// other machines' client config), and the LAN URL to point them at. The actual toggle/rotate is done
// by the App via onAction so the worker can be restarted to re-bind the socket.
export function NetworkScreen({ info, onAction }: { info: NetworkInfo; onAction: (a: NetworkAction) => void }) {
  const row = (k: string, v: string, color: string = theme.output) => (
    <Text><Text color={theme.muted}>{k.padEnd(12)}</Text><Text color={color}>{v}</Text></Text>
  );
  const isLan = info.mode === "lan";
  const items = [
    isLan
      ? { label: "switch to localhost (loopback only — private)", value: "localhost" }
      : { label: "switch to LAN (expose on the network · key required)", value: "lan" },
    { label: info.key ? "rotate access key" : "generate access key", value: "rotate" },
    { label: "back", value: "back" },
  ];
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={isLan ? theme.accent : theme.border} paddingX={1} marginBottom={1}>
      <Text color={theme.accent} bold>network access</Text>
      {row("mode", isLan ? "LAN — reachable from other machines" : "localhost — loopback only (private)", isLan ? theme.accent : theme.ready)}
      {row("access key", info.key ?? "(none set)", info.key ? theme.output : theme.muted)}
      {isLan && info.lanUrl && row("LAN URL", info.lanUrl)}
      {isLan && info.lanUrl && <Text><Text color={theme.muted}>{"".padEnd(12)}</Text><Text color={theme.muted}>{`└ Claude: ${info.lanUrl}/anthropic · Codex: ${info.lanUrl}/openai`}</Text></Text>}
      {isLan
        ? <Text color={theme.muted}>other machines: set base URL to the LAN URL + protocol path above, and send the key as <Text color={theme.output}>Authorization: Bearer …</Text> or <Text color={theme.output}>x-api-key</Text>. This machine stays key-free over <Text color={theme.output}>127.0.0.1</Text>.</Text>
        : <Text color={theme.muted}>localhost is the safe default — only this machine can reach the proxy</Text>}
      <Text> </Text>
      <Select items={items} onSubmit={(v) => onAction(v.value as NetworkAction)} onCancel={() => onAction("back")} />
    </Box>
  );
}

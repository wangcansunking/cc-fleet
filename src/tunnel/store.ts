import { z } from "zod";
import { readJson, writeJsonAtomic } from "../control/hub/json-store.js";

const FILE = "tunnel.json";
export const DEFAULT_TUNNEL_PORT = 7992;

const Config = z.object({
  enabled: z.boolean(),
  tunnelId: z.string().min(1).optional(),
  port: z.number().int().positive(),
  publicUrl: z.string().url().optional(),
  lastError: z.string().optional(),
});
export type TunnelConfig = z.infer<typeof Config>;

const DEFAULT: TunnelConfig = { enabled: false, port: DEFAULT_TUNNEL_PORT };

export function readTunnelConfig(dataDir: string): TunnelConfig {
  const parsed = Config.safeParse(readJson<unknown>(dataDir, FILE, DEFAULT));
  return parsed.success ? parsed.data : { ...DEFAULT };
}

export function writeTunnelConfig(dataDir: string, config: TunnelConfig): void {
  const parsed = Config.parse(config);
  writeJsonAtomic(dataDir, FILE, parsed);
}

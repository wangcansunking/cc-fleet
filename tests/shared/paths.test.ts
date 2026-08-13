import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { dataDir, dbPath, configPath } from "../../src/shared/paths.js";

describe("paths", () => {
  it("nests db/config under the data dir", () => {
    expect(dataDir("/home/u")).toBe(join("/home/u", ".cc-fleet"));
    expect(dbPath("/home/u")).toBe(join("/home/u", ".cc-fleet", "cc-fleet.db"));
    expect(configPath("/home/u")).toBe(join("/home/u", ".cc-fleet", "config.json"));
  });

  // Guards the coexistence rule: cc-fleet must never write into copilot-reverse's dir. A machine can
  // legitimately run both, and sharing the dir would have them fight over token/network.json/db.
  it("never collides with copilot-reverse's data dir", () => {
    expect(dataDir("/home/u")).not.toContain("copilot-reverse");
    expect(dbPath("/home/u")).not.toContain("copilot-reverse");
  });
});

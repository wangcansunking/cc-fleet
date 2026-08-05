import { describe, it, expect, vi } from "vitest";
import { fetchModelEndpoints, fetchModelReasoningSupport, fetchModelOneMSupport, fetchModelDiscovery } from "../../../src/providers/copilot/models.js";

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

describe("fetchModelDiscovery", () => {
  it("returns one coherent live capability snapshot", async () => {
    const f = vi.fn(async () => json({ data: [{
      id: "gpt-5.6-sol",
      supported_endpoints: ["/responses"],
      capabilities: { supports: { reasoning_effort: ["high"] }, limits: { max_context_window_tokens: 1_100_000 } },
    }] }));
    const out = await fetchModelDiscovery("tok", f as unknown as typeof fetch);
    expect(f).toHaveBeenCalledTimes(1);
    expect(out.live).toBe(true);
    expect(out.ids).toEqual(["gpt-5.6-sol"]);
    expect(out.endpoints["gpt-5.6-sol"]).toEqual(["/responses"]);
    expect(out.reasoning.has("gpt-5.6-sol")).toBe(true);
    expect(out.reasoningEfforts["gpt-5.6-sol"]).toEqual(["high"]);
    expect(out.oneM.has("gpt-5.6-sol")).toBe(true);
    expect(out.limits["gpt-5.6-sol"]).toBe(1_100_000);
  });

  it("marks fallback ids as non-live when upstream discovery fails", async () => {
    const f = vi.fn(async () => new Response("", { status: 500 }));
    const out = await fetchModelDiscovery("tok", f as unknown as typeof fetch);
    expect(out.live).toBe(false);
    expect(out.ids.length).toBeGreaterThan(0);
    expect(out.limits).toEqual({});
  });
});

describe("fetchModelEndpoints", () => {
  it("maps model id -> supported_endpoints", async () => {
    const f = vi.fn(async () => json({ data: [
      { id: "gpt-5.5", supported_endpoints: ["/responses", "ws:/responses"] },
      { id: "gpt-4o", supported_endpoints: undefined },
      { id: "gpt-5-mini", supported_endpoints: ["/chat/completions", "/responses"] },
    ] }));
    const out = await fetchModelEndpoints("tok", f as unknown as typeof fetch);
    expect(out["gpt-5.5"]).toEqual(["/responses", "ws:/responses"]);
    expect(out["gpt-5-mini"]).toContain("/chat/completions");
    expect(out["gpt-4o"]).toBeUndefined(); // no field -> omitted
  });

  it("returns {} when the endpoint fails", async () => {
    const f = vi.fn(async () => new Response("", { status: 500 }));
    expect(await fetchModelEndpoints("tok", f as unknown as typeof fetch)).toEqual({});
  });
});

describe("fetchModelReasoningSupport", () => {
  it("includes only ids whose capabilities advertise a non-empty reasoning_effort", async () => {
    const f = vi.fn(async () => json({ data: [
      { id: "claude-opus-4.8", capabilities: { supports: { reasoning_effort: ["low", "medium", "high"] } } },
      { id: "gpt-5.5", capabilities: { supports: { reasoning_effort: ["none", "low", "high"] } } },
      { id: "gpt-4o", capabilities: { supports: { tool_calls: true } } }, // no reasoning_effort
      { id: "gpt-4o-mini", capabilities: { supports: { reasoning_effort: [] } } }, // empty -> excluded
      { id: "text-embedding-3-small", capabilities: { supports: {} } },
    ] }));
    const out = await fetchModelReasoningSupport("tok", f as unknown as typeof fetch);
    expect(out.has("claude-opus-4.8")).toBe(true);
    expect(out.has("gpt-5.5")).toBe(true);
    expect(out.has("gpt-4o")).toBe(false);
    expect(out.has("gpt-4o-mini")).toBe(false);
    expect(out.has("text-embedding-3-small")).toBe(false);
  });

  it("returns an empty set when the endpoint fails", async () => {
    const f = vi.fn(async () => new Response("", { status: 500 }));
    expect((await fetchModelReasoningSupport("tok", f as unknown as typeof fetch)).size).toBe(0);
  });
});

describe("fetchModelOneMSupport", () => {
  it("includes only ids whose context window exceeds the 1M threshold", async () => {
    const f = vi.fn(async () => json({ data: [
      { id: "claude-opus-4.8", capabilities: { limits: { max_context_window_tokens: 1_000_000, max_prompt_tokens: 936_000 } } },
      { id: "claude-sonnet-5", capabilities: { limits: { max_context_window_tokens: 1_000_000 } } },
      { id: "claude-sonnet-4.5", capabilities: { limits: { max_context_window_tokens: 200_000 } } }, // 200K -> excluded
      { id: "gpt-4o", capabilities: { limits: {} } }, // no window -> excluded
      { id: "no-caps" }, // no capabilities at all -> excluded
    ] }));
    const out = await fetchModelOneMSupport("tok", f as unknown as typeof fetch);
    expect(out.has("claude-opus-4.8")).toBe(true);
    expect(out.has("claude-sonnet-5")).toBe(true);
    expect(out.has("claude-sonnet-4.5")).toBe(false);
    expect(out.has("gpt-4o")).toBe(false);
    expect(out.has("no-caps")).toBe(false);
  });

  it("falls back to max_prompt_tokens when max_context_window_tokens is absent", async () => {
    const f = vi.fn(async () => json({ data: [
      { id: "claude-opus-4.7", capabilities: { limits: { max_prompt_tokens: 936_000 } } }, // 936K > 800K -> included
    ] }));
    const out = await fetchModelOneMSupport("tok", f as unknown as typeof fetch);
    expect(out.has("claude-opus-4.7")).toBe(true);
  });

  it("returns an empty set when the endpoint fails", async () => {
    const f = vi.fn(async () => new Response("", { status: 500 }));
    expect((await fetchModelOneMSupport("tok", f as unknown as typeof fetch)).size).toBe(0);
  });
});

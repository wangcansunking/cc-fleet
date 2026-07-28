// Live model list from Copilot. Falls back to a curated list if the endpoint is unavailable.
const MODELS_URL = "https://api.githubcopilot.com/models";
export const FALLBACK_MODELS = ["gpt-4o", "gpt-4o-mini", "claude-sonnet-4-6", "claude-sonnet-5", "claude-opus-4-8", "claude-opus-5", "o3-mini"];

const HEADERS = (token: string) => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
  "editor-version": "vscode/1.95.0",
  "copilot-integration-id": "vscode-chat",
});

const DEFAULT_TIMEOUT_MS = 8000;

// A stalled Copilot endpoint must never hang the model picker forever — abort after timeoutMs.
async function getModels(token: string, fetchFn: typeof fetch, timeoutMs: number): Promise<{ id?: string; supported_endpoints?: string[]; capabilities?: { limits?: { max_prompt_tokens?: number; max_context_window_tokens?: number }; supports?: { reasoning_effort?: string[] } } }[] | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(MODELS_URL, { headers: HEADERS(token), signal: ctrl.signal });
    if (!res.ok) return null;
    return ((await res.json()) as { data?: unknown[] }).data as never ?? [];
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchCopilotModels(token: string, fetchFn: typeof fetch = fetch, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string[]> {
  const data = await getModels(token, fetchFn, timeoutMs);
  if (!data) return FALLBACK_MODELS;
  const ids = [...new Set(data.map((m) => m.id).filter((x): x is string => Boolean(x)))];
  return ids.length ? ids : FALLBACK_MODELS;
}

// Map of model id -> the Copilot API endpoints it supports (e.g. ["/responses","ws:/responses"]).
// Used to route each request to the right upstream: newer gpt-5.x models are /responses-only and
// reject /chat/completions. Returns {} on failure so the adapter falls back to chat/completions.
export async function fetchModelEndpoints(token: string, fetchFn: typeof fetch = fetch, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Record<string, string[]>> {
  const data = await getModels(token, fetchFn, timeoutMs);
  if (!data) return {};
  const out: Record<string, string[]> = {};
  for (const m of data) {
    if (m.id && Array.isArray(m.supported_endpoints) && m.supported_endpoints.length) out[m.id] = m.supported_endpoints;
  }
  return out;
}

// Set of model ids whose capabilities advertise a reasoning_effort enum. The adapter consults this
// before adding `reasoning_effort` to a /chat body: sending it to a model that doesn't support it (e.g.
// gpt-4o) is a hard 400 (`invalid_reasoning_effort`). Returns an empty set on failure/timeout, so the
// adapter omits reasoning_effort until discovery resolves — safe (a turn just runs without reasoning)
// rather than a 400. Only ids with a non-empty reasoning_effort array are included.
export async function fetchModelReasoningSupport(token: string, fetchFn: typeof fetch = fetch, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Set<string>> {
  const data = await getModels(token, fetchFn, timeoutMs);
  const out = new Set<string>();
  if (!data) return out;
  for (const m of data) {
    if (m.id && Array.isArray(m.capabilities?.supports?.reasoning_effort) && m.capabilities.supports.reasoning_effort.length) out.add(m.id);
  }
  return out;
}

// Set of model ids whose advertised context window reaches ~1M tokens (dotted upstream form). Feeds the
// outbound /v1/models mapper's is1M oracle, so the [1m] picker badge follows the REAL upstream window
// instead of a hardcoded list — a new 1M model (claude-sonnet-5, or any future family) badges with zero
// code changes. Threshold 800K matches clients.ts's context-window suffix rule (max_prompt_tokens 936K
// also clears it). Returns an empty set on failure/timeout, so callers fall back to the default set.
export async function fetchModelOneMSupport(token: string, fetchFn: typeof fetch = fetch, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Set<string>> {
  const data = await getModels(token, fetchFn, timeoutMs);
  const out = new Set<string>();
  if (!data) return out;
  for (const m of data) {
    const w = m.capabilities?.limits?.max_context_window_tokens ?? m.capabilities?.limits?.max_prompt_tokens;
    if (m.id && typeof w === "number" && w > 800_000) out.add(m.id);
  }
  return out;
}

// Map of model id -> its real input/context window, used to size auto-compaction per model and
// to show the window in the picker. Returns {} on failure/timeout so callers fall back gracefully.
export async function fetchModelLimits(token: string, fetchFn: typeof fetch = fetch, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Record<string, number>> {
  const data = await getModels(token, fetchFn, timeoutMs);
  if (!data) return {};
  const out: Record<string, number> = {};
  for (const m of data) {
    // Prefer the headline context window (so a 1M model shows as 1M); fall back to the prompt budget.
    const limit = m.capabilities?.limits?.max_context_window_tokens ?? m.capabilities?.limits?.max_prompt_tokens;
    if (m.id && typeof limit === "number") out[m.id] = limit;
  }
  return out;
}

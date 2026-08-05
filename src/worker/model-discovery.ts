// Mapping depends on the live model list: announcing readiness before discovery finishes lets setup and
// Claude's picker observe only raw GPT ids for the worker's first few moments. Wait only in opt-in map
// mode; disabled mode preserves the existing non-blocking startup. Discovery failure still fails open —
// the worker remains useful with its normal fallback list, just without synthetic aliases.
export async function discoveryBeforeReady(enabled: boolean, discover: () => Promise<unknown>): Promise<void> {
  const pending = discover();
  if (enabled) await pending.catch(() => undefined);
  else void pending.catch(() => undefined);
}

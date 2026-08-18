import type { Channel, MessageHandler, Unsubscribe } from "../channel.js";

// Node-side transport: consume the hub's SSE stream, POST reports back.
//
// The returned Channel is STABLE across reconnects — handlers registered once keep working after the
// link drops and comes back. That matters because reconnect is the node's whole availability story
// (docs/design.md §5): a node that was offline during an edit converges when it returns, and the hub
// re-pushes desired state on connect.

export interface HttpAgentOptions {
  hubUrl: string;
  token: string;
  deviceId: string;
  retryMs?: number;      // initial reconnect delay
  maxRetryMs?: number;   // cap
  fetchImpl?: typeof fetch;
}

export interface AgentChannel extends Channel {
  onError(handler: (message: string) => void): Unsubscribe;
}

const RETRY_MS = 1_000;
const MAX_RETRY_MS = 5_000;

// Split an SSE byte stream into frames and yield the `data:` payloads.
//
// Keep-alives arrive as comment frames (":ka"), which carry no `data:` line and so are skipped. A
// parser that treated them as payloads would hand the agent garbage — and garbage here means a
// garbage desired state applied to the user's machine.
function framesFrom(buffer: string): { payloads: string[]; rest: string } {
  const payloads: string[] = [];
  let rest = buffer;
  for (;;) {
    const idx = rest.indexOf("\n\n");
    if (idx < 0) break;
    const frame = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).replace(/^ /, ""))
      .join("\n");
    if (data) payloads.push(data);
  }
  return { payloads, rest };
}

export function connectHttp(opts: HttpAgentOptions): AgentChannel {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.hubUrl.replace(/\/+$/, "");
  const auth = { authorization: `Bearer ${opts.token}` };
  const query = `deviceId=${encodeURIComponent(opts.deviceId)}`;

  const messageHandlers = new Set<MessageHandler>();
  const closeHandlers = new Set<() => void>();
  const errorHandlers = new Set<(m: string) => void>();
  let closed = false;
  let abort: AbortController | null = null;
  let delay = opts.retryMs ?? RETRY_MS;
  const maxDelay = opts.maxRetryMs ?? MAX_RETRY_MS;

  const emitError = (m: string) => {
    for (const h of [...errorHandlers]) { try { h(m); } catch { /* ignore */ } }
  };
  const emitMessage = (m: unknown) => {
    for (const h of [...messageHandlers]) { try { h(m); } catch { /* ignore */ } }
  };

  async function run(): Promise<void> {
    while (!closed) {
      abort = new AbortController();
      try {
        const res = await doFetch(`${base}/control/events?${query}`, {
          headers: { ...auth, accept: "text/event-stream" },
          signal: abort.signal,
        });
        // A 401 is not transient: the token will never start working on its own. Retrying would spin
        // forever and bury the real cause, so surface it once and stop.
        if (res.status === 401) { await res.body?.cancel(); emitError("hub rejected the token (401 unauthorized)"); return; }
        if (!res.ok || !res.body) { await res.body?.cancel(); throw new Error(`hub returned ${res.status}`); }

        delay = opts.retryMs ?? RETRY_MS; // a successful connect resets the backoff
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const { payloads, rest } = framesFrom(buffer);
          buffer = rest;
          for (const payload of payloads) {
            try { emitMessage(JSON.parse(payload)); }
            catch { emitError("hub sent an unparseable frame"); } // drop it; never crash the agent
          }
        }
      } catch (e) {
        if (closed) return;
        emitError((e as Error).message);
      }
      if (closed) return;
      await new Promise((r) => setTimeout(r, delay).unref?.());
      delay = Math.min(delay * 2, maxDelay);
    }
  }

  void run();

  return {
    // Reports are fire-and-forget: a failed POST is reported but never throws into the apply path,
    // because "the hub didn't hear about it" must not stop the node from having applied it.
    send(msg: unknown): void {
      if (closed) return;
      void doFetch(`${base}/control/msg?${query}`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify(msg),
      }).then((res) => { if (!res.ok) emitError(`report rejected: ${res.status}`); })
        .catch((e: Error) => emitError(`report failed: ${e.message}`));
    },
    onMessage(handler: MessageHandler): Unsubscribe {
      messageHandlers.add(handler);
      return () => messageHandlers.delete(handler);
    },
    onClose(handler: () => void): Unsubscribe {
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    },
    onError(handler: (m: string) => void): Unsubscribe {
      errorHandlers.add(handler);
      return () => errorHandlers.delete(handler);
    },
    close(): void {
      if (closed) return;
      closed = true;
      abort?.abort();
      for (const h of [...closeHandlers]) { try { h(); } catch { /* ignore */ } }
    },
  };
}

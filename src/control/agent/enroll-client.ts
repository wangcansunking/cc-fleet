// Node side of the enrolment handshake (RFC 8628 in shape).
//
// The node asks for a code, shows it to the person sitting at that machine, and waits. It never
// carries a secret it was given elsewhere — which is what makes this better than the previous flow,
// where a short code minted on the hub had to travel to the node AND was the network credential.
// Here the network-facing secret is 32 random bytes and the human-facing one never leaves the room.

export interface DeviceCodeStart {
  deviceCode: string;
  userCode: string;
  intervalMs: number;
  expiresAt: number;
}

export interface RequestCodeOptions {
  hubUrl: string;
  hostname: string;
  os: string;
  agentVersion: string;
  fetchImpl?: typeof fetch;
}

export type RequestCodeResult = { ok: true; start: DeviceCodeStart } | { ok: false; error: string };
export type EnrollOutcome =
  | { ok: true; deviceId: string; deviceToken: string }
  | { ok: false; error: string };

const base = (url: string): string => url.replace(/\/+$/, "");

export async function requestDeviceCode(opts: RequestCodeOptions): Promise<RequestCodeResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${base(opts.hubUrl)}/control/device/code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostname: opts.hostname, os: opts.os, agentVersion: opts.agentVersion }),
    });
  } catch (e) {
    return { ok: false, error: `could not reach the hub: ${(e as Error).message}` };
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}) as { error?: string });
    return { ok: false, error: body.error ?? `hub refused the request (${res.status})` };
  }
  const body = await res.json().catch(() => null) as DeviceCodeStart | null;
  if (!body?.deviceCode || !body?.userCode) return { ok: false, error: "hub returned a malformed response" };
  return { ok: true, start: body };
}

export interface PollOptions {
  hubUrl: string;
  start: DeviceCodeStart;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Called on each pending tick, so a CLI can show that it is still waiting. */
  onWaiting?: () => void;
}

// Poll until approved, denied or expired.
//
// `slow_down` is obeyed by widening the interval rather than ignored — the hub is telling us we are
// being a nuisance, and a client that argues with rate limiting is a client that gets blocked.
export async function pollForToken(opts: PollOptions): Promise<EnrollOutcome> {
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => { setTimeout(r, ms); }));
  let interval = opts.start.intervalMs;

  for (;;) {
    if (now() >= opts.start.expiresAt) return { ok: false, error: "the code expired before it was approved" };
    await sleep(interval);

    let res: Response;
    try {
      res = await doFetch(`${base(opts.hubUrl)}/control/device/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceCode: opts.start.deviceCode }),
      });
    } catch (e) {
      // A transient network blip during a 15-minute wait should not throw away the approval the
      // operator may have already given; keep polling until the code genuinely expires.
      opts.onWaiting?.();
      continue;
    }

    if (res.status === 201) {
      const body = await res.json().catch(() => null) as { deviceId?: string; deviceToken?: string } | null;
      if (!body?.deviceId || !body?.deviceToken) return { ok: false, error: "hub returned a malformed enrolment response" };
      return { ok: true, deviceId: body.deviceId, deviceToken: body.deviceToken };
    }

    const body = await res.json().catch(() => ({}) as { error?: string });
    const reason = body.error ?? String(res.status);
    if (reason === "authorization_pending") { opts.onWaiting?.(); continue; }
    if (reason === "slow_down") { interval = Math.round(interval * 1.5); opts.onWaiting?.(); continue; }
    if (reason === "access_denied") return { ok: false, error: "the request was denied on the hub" };
    if (reason === "expired_token") return { ok: false, error: "the code expired before it was approved" };
    return { ok: false, error: `hub rejected the enrolment: ${reason}` };
  }
}

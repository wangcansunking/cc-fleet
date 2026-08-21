// Node side of the enrolment handshake: trade a one-time code for this machine's own token.
//
// Split out from the transport because it is a single stateless request that happens ONCE per
// machine, before any channel exists — bundling it into the streaming client would make the channel
// responsible for a lifecycle it does not otherwise have.

export interface EnrollOptions {
  hubUrl: string;
  code: string;
  hostname: string;
  os: string;
  agentVersion: string;
  fetchImpl?: typeof fetch;
}

export type EnrollOutcome =
  | { ok: true; deviceId: string; deviceToken: string }
  | { ok: false; error: string };

export async function enrollNode(opts: EnrollOptions): Promise<EnrollOutcome> {
  const base = opts.hubUrl.replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${base}/control/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: opts.code, hostname: opts.hostname, os: opts.os, agentVersion: opts.agentVersion,
      }),
    });
  } catch (e) {
    return { ok: false, error: `could not reach the hub: ${(e as Error).message}` };
  }

  if (!res.ok) {
    // The hub deliberately returns one message for wrong/expired/spent codes. Relay it verbatim
    // rather than embellishing — a friendlier client-side guess would undo that.
    const body = await res.json().catch(() => ({}) as { error?: string });
    return { ok: false, error: body.error ?? `hub rejected enrolment (${res.status})` };
  }
  const body = await res.json().catch(() => null) as { deviceId?: string; deviceToken?: string } | null;
  if (!body?.deviceId || !body?.deviceToken) return { ok: false, error: "hub returned a malformed enrolment response" };
  return { ok: true, deviceId: body.deviceId, deviceToken: body.deviceToken };
}

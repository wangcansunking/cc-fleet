import { describe, it, expect, vi } from "vitest";
import { EnrollCodes, CODE_TTL_MS, MAX_IP_FAILURES, IP_BLOCK_MS } from "../../src/control/hub/enroll.js";

const at = (t: number) => () => t;

describe("enroll codes — shape", () => {
  it("mints a human-typeable XXXX-XXXX code", () => {
    const codes = new EnrollCodes(at(0));
    expect(codes.mint()).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });

  it("never emits characters a human would mistype", () => {
    // 0/O and 1/I/L are read aloud and re-typed by a person; a code that cannot be transcribed
    // reliably becomes a support burden, and users work around it by reusing codes.
    const codes = new EnrollCodes(at(0));
    for (let i = 0; i < 200; i++) expect(codes.mint()).not.toMatch(/[01OIL]/);
  });

  it("does not repeat itself", () => {
    const codes = new EnrollCodes(at(0));
    const seen = new Set(Array.from({ length: 300 }, () => codes.mint()));
    expect(seen.size).toBe(300);
  });
});

describe("enroll codes — consumption", () => {
  it("accepts a fresh code exactly once", () => {
    const codes = new EnrollCodes(at(0));
    const code = codes.mint();
    expect(codes.consume(code, "1.1.1.1").ok).toBe(true);
    expect(codes.consume(code, "1.1.1.1").ok).toBe(false); // single use
  });

  it("rejects a code after its TTL", () => {
    let now = 0;
    const codes = new EnrollCodes(() => now);
    const code = codes.mint();
    now = CODE_TTL_MS + 1;
    expect(codes.consume(code, "1.1.1.1").ok).toBe(false);
  });

  it("accepts right up to the TTL boundary", () => {
    let now = 0;
    const codes = new EnrollCodes(() => now);
    const code = codes.mint();
    now = CODE_TTL_MS;
    expect(codes.consume(code, "1.1.1.1").ok).toBe(true);
  });

  it("rejects an unknown code", () => {
    const codes = new EnrollCodes(at(0));
    expect(codes.consume("AAAA-BBBB", "1.1.1.1").ok).toBe(false);
  });

  it("is case-insensitive and tolerates a missing dash", () => {
    // People retype these from a screen or a chat message. Being strict here buys no security —
    // the entropy is in the characters, not their casing.
    const codes = new EnrollCodes(at(0));
    const code = codes.mint();
    expect(codes.consume(code.toLowerCase().replace("-", ""), "1.1.1.1").ok).toBe(true);
  });

  it("gives exactly one winner when two machines race the same code", () => {
    const codes = new EnrollCodes(at(0));
    const code = codes.mint();
    const results = [codes.consume(code, "1.1.1.1"), codes.consume(code, "2.2.2.2")];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it("keeps multiple outstanding codes independent", () => {
    const codes = new EnrollCodes(at(0));
    const a = codes.mint(), b = codes.mint();
    expect(codes.consume(a, "1.1.1.1").ok).toBe(true);
    expect(codes.consume(b, "1.1.1.1").ok).toBe(true);
  });
});

describe("enroll codes — the failure reason never leaks", () => {
  it("says the same thing for wrong, expired and already-used codes", () => {
    // Distinguishing "wrong" from "expired" tells an attacker whether a guess ever existed,
    // turning a blind guess into an oracle query.
    let now = 0;
    const codes = new EnrollCodes(() => now);
    const used = codes.mint();
    codes.consume(used, "1.1.1.1");
    const expired = codes.mint();
    now = CODE_TTL_MS + 1;

    const reasons = [
      codes.consume("ZZZZ-ZZZZ", "1.1.1.1"),
      codes.consume(used, "1.1.1.1"),
      codes.consume(expired, "1.1.1.1"),
    ].map((r) => (r.ok ? "ok" : r.reason));
    expect(new Set(reasons).size).toBe(1);
    expect(reasons[0]).toBe("invalid");
  });
});

describe("enroll codes — brute force", () => {
  it("throttles per source, and a guesser can never lock legitimate machines out", () => {
    // The throttle is deliberately PER SOURCE and nothing else. A fleet-wide reaction to guessing
    // (burning live codes) would hand anyone a denial of service: a handful of bad guesses would
    // permanently stop real machines from enrolling. A defence whose failure mode is "nobody can
    // join" is worse than the attack it prevents — the entropy plus this throttle already make
    // guessing infeasible (31^8 codes, 10 tries per source per minute, a 5-minute window).
    const codes = new EnrollCodes(at(0));
    const code = codes.mint();
    for (let i = 0; i < MAX_IP_FAILURES + 3; i++) codes.consume("WRON-GXXX", "6.6.6.6");
    expect(codes.consume(code, "7.7.7.7").ok).toBe(true);
  });

  it("counts failures so the operator can be told someone is guessing", () => {
    const codes = new EnrollCodes(at(0));
    expect(codes.failedAttempts()).toBe(0);
    codes.consume("WRON-GXXX", "6.6.6.6");
    codes.consume("WRON-GXXY", "6.6.6.6");
    expect(codes.failedAttempts()).toBe(2);
  });

  it("blocks an IP that keeps guessing", () => {
    const codes = new EnrollCodes(at(0));
    for (let i = 0; i < MAX_IP_FAILURES; i++) codes.consume("WRON-GXXX", "6.6.6.6");
    const r = codes.consume("WRON-GXXX", "6.6.6.6");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("blocked");
  });

  it("does not punish a different IP for someone else's guessing", () => {
    const codes = new EnrollCodes(at(0));
    const code = codes.mint();
    for (let i = 0; i < MAX_IP_FAILURES + 3; i++) codes.consume("WRON-GXXX", "6.6.6.6");
    expect(codes.consume(code, "7.7.7.7").ok).toBe(true);
  });


  it("lets a blocked IP back in after the cooldown", () => {
    let now = 0;
    const codes = new EnrollCodes(() => now);
    for (let i = 0; i < MAX_IP_FAILURES; i++) codes.consume("WRON-GXXX", "6.6.6.6");
    expect((codes.consume("WRON-GXXX", "6.6.6.6") as { reason: string }).reason).toBe("blocked");
    now = IP_BLOCK_MS + 1;
    const code = codes.mint();
    expect(codes.consume(code, "6.6.6.6").ok).toBe(true);
  });
});

describe("enroll codes — lifetime", () => {
  it("has no outstanding codes when freshly constructed", () => {
    // Codes live in memory only, so a hub restart invalidates every outstanding code. That is the
    // intended behaviour: a code handed out before a restart should not survive it.
    expect(new EnrollCodes(at(0)).outstanding()).toBe(0);
  });

  it("stops counting a code once it is used or expires", () => {
    let now = 0;
    const codes = new EnrollCodes(() => now);
    const a = codes.mint();
    codes.mint();
    expect(codes.outstanding()).toBe(2);
    codes.consume(a, "1.1.1.1");
    expect(codes.outstanding()).toBe(1);
    now = CODE_TTL_MS + 1;
    expect(codes.outstanding()).toBe(0);
  });
});

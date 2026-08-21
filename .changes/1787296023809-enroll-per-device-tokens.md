---
bump: minor
---
Fleet nodes now enrol with a one-time code and get their own credential. `cc-fleet hub` prints a single-use code (5-minute expiry), `cc-fleet join <hubUrl> <code>` trades it for a per-device token, `cc-fleet devices` lists what is enrolled, and `cc-fleet revoke <id>` ejects one machine — dropping its live connection within seconds, without restarting the hub. The fleet-wide shared token is gone; tokens are stored only as hashes, so a leaked registry is not a leaked fleet. **Breaking:** `join` now takes an enrolment code where it used to take the shared token.

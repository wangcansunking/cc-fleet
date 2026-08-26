---
bump: minor
---
Enrolment now runs the other way round: a machine asks to join and displays a short code, and a
human approves it on the hub with `cc-fleet approve` (or refuses it with `cc-fleet deny`). The hub
no longer mints a code at startup for a person to carry to the new machine — which also means
adding a second node no longer requires restarting the hub. `cc-fleet approve` with no arguments
lists what is waiting, naming each machine, so approval is a decision rather than a reflex.

The security shape improves with it: the secret that travels over the network is now 32 random
bytes rather than the eight characters a person reads off a screen, so the per-IP guess throttle
that the short code needed is gone. Both the device code and the issued token are stored only as
hashes, requests expire after 15 minutes, and a device code can be redeemed exactly once — a spent
one is indistinguishable from one that never existed.

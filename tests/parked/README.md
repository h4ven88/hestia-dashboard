# Parked suites — not run, kept on purpose

These test code that was **reverted** on 2026-09-23. They do not run against the
current tree and are excluded from `runall.mjs`. They are kept because the work
they encode is worth more than the code that was reverted.

**Status as of v2.0.0 (2026-09-26): the trust model shipped, and these are now
historical.** Both attacks below are encoded against *shipped* code in
`tests/writeauth.mjs`, which runs in `runall`. Read these for the reasoning; run
`writeauth` for the verdict. Nothing here counts as coverage of anything.

## `scopeharness.mjs` — the attack harness

Drives the **real** Cloudflare Function handlers against a mock KV, with real
P-256 keys so `dispatchPush()` actually executes (a 500 from a fake key would
otherwise read as "attack blocked"). It demonstrates, concretely:

- **Attack A** — PUT a shape-valid but undecryptable blob so `getHouseholdConfig()`
  returns null, then walk through any branch that treats "no record" as "allowed".
- **Attack B** — PUT a record whose verifier is one the attacker chose, which both
  authenticates them and locks the real hub out of its own household.
- Hostile inputs to id validation (prototype pollution, `toString`/`valueOf`
  coercion, wrapper objects, newline injection, key-separator injection).
- Key-space collision attempts across all six KV prefixes.
- CSRF via `Content-Type: text/plain`, which needs no preflight.
- Unbounded unauthenticated KV write amplification.

**⚠ It PASSES while documenting live vulnerabilities.** The assertions confirm the
attacks *succeed*. Anyone reading a green run would draw the opposite conclusion.
Before reusing it, invert the attack assertions so they fail until fixed.

**It served as the acceptance gate, and the gate was met.** The design that
finally shipped in v2.0.0 was built against both attacks: `getHouseholdConfig()`
returns null on anything unreadable and every caller treats null as *refuse*
(409, never trust-on-first-use over an existing record), and a verifier can only
be established by a household that holds none. Round 13 of review found the
sharpest form of Attack B still live, where the gate compared two fields the
*caller itself supplied*, which is satisfiable by any pair an attacker picks.
That is now closed and covered by `writeauth` sections 1b through 1g.

## `cloudpayload.mjs` — the projection suite

47 tests proving the cloud payload carries only what the Cloudflare Workers
actually read, and nothing else: no Maker token, no Anthropic or Google API key,
no PIN hashes, no camera URLs, no room or device inventory. Written as an
allow-list check, so a field added to the config later fails the test rather than
leaking by omission.

The projection idea was sound and reviewed clean on its own merits. It was
reverted because the *consumers* of the cloud entry were not updated alongside it
— `cloudAdoptConfig()` wrote the 10-field projection over a working
`dashboard-config`, and `_cloudProjectSensors()` omitted `glass`, which would have
deleted glass-break sensors household-wide.

Note the one bug this suite did NOT catch, which matters for how much to trust it:
it verified the payload's *contents* but never that the payload's consumers could
still read it. A projection test needs a matching consumer test.

**That gap is what `tests/projection-equivalence.mjs` exists to close.** It does
the inverse: it derives the required field list *from the Worker sources* and
fails if `buildServiceHalf()` drops one. The projection idea itself shipped in
v2.0.0 as the plaintext service half.

## `keyrace2.mjs` — household key reconciliation

20 tests simulating how two devices minting a household key at the same moment
would reconcile. It models a **pairing design that was never built**: the shipped
v2.0.0 answer is that the hub is the only place a secret is minted, gated on the
hub accepting the write first, so the race it simulates cannot occur. Kept
because the reasoning about split-brain households is still the reasoning to
reach for if the hub ever stops being the single mint point.

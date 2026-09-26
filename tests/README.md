# Test harnesses — CRITICAL, DO NOT DELETE

344 tests across 9 suites. Run them all:

```bash
node tests/runall.mjs
```

`runall.mjs` exits non-zero on a failure, on a **MISSING** suite, and on a suite
that crashed without printing a summary.

## Why these live here and not in the scratchpad

They used to live in the session scratchpad under `%TEMP%`. On 2026-09-23 a temp
cleanup deleted `hubharness.mjs` and `relinkharness.mjs`, silently removing 23
tests. `runall.mjs` reported them as `MISSING` rather than failing, so a run that
looked green was covering less than it claimed.

They were recovered from the session transcripts, and recovery surfaced a second
problem: the recovered `hubharness` carried an **older draft of its own stubs**
and failed 1 of 14. Both failures turned out to be harness bugs, not product
bugs, a stale copy of `saveSettings()` and a test feeding it `CONFIG.hub` where
the real field holds `_hubUrlToShare()`. A harness that drifts from the code it
mirrors tests fiction and reports success.

A third instance of the same class turned up on 2026-09-25: `runall.mjs` itself
had **no `process.exit` at all**, so it printed "all green" and returned success
over a deleted suite. Verified by deleting one and getting exit 0. Fixed.

So: **these belong in the repo, tracked by git.** Anything under `%TEMP%` is not
storage, and neither is an untracked working directory. They were first committed
on 2026-09-26; before that they existed on exactly one machine and no push
carried them.

## What each suite covers

| Suite | Tests | Covers |
|---|---:|---|
| `ringharness` | 45 | Ring/HSM entry-delay state machine, transitions, alarm panel ranking |
| `hubharness` | 14 | `_hubUrlForThisDevice` / `_hubUrlToShare`, per-device vs shared hub URL |
| `relinkharness` | 9 | Diagnostics companion-app relink flow |
| `healthharness` | 34 | Alarm connection health, HSM/Ring mismatch, lost-connection cause text |
| `cloudharness` | 26 | Cloud config adoption trust decisions, alarm panel ranking |
| `garageharness` | 67 | Garage door command style, state honesty, voice/routine gating |
| `projection-equivalence` | 19 | The service half carries every field the Workers actually read |
| `writeauth` | 66 | Cloud record write authority: token proof, recovery verifier, both attacks |
| `cloudsecret` | 64 | Household secret lifecycle, what goes on the wire, key derivation |

### The two security suites

`writeauth` and `cloudsecret` exist because the others did **not** constrain this
code. A reviewer mutated the shipped source two ways, deleted the line stripping
the secret out of the record it encrypts, and replaced `crypto.getRandomValues`
with a constant so every household shared one key, and the full suite stayed
green both times.

They encode the two attacks that killed eleven earlier designs of the trust
model. Re-run both against any change in this area:

- **Attack A, fail-open.** An undecryptable record makes a read return null and a
  caller treats null as "allow". Every `getHouseholdConfig()` null must mean
  *refuse*.
- **Attack B, attacker-chosen verifier.** A caller writes a record whose own
  verifier is one they picked, presents it, and is authorised. Its sharpest form,
  found in review round 13 after twelve rounds missed it: the gate compared two
  fields the *caller supplied*, which is trivially satisfiable. **Ask of every
  authorisation check: which side of this comparison can the attacker choose?**

## The rule these all follow

**Extract the real shipped functions from `dashboard.html`; never reimplement
them.** Each suite pulls the function text out of the source by brace-matching
and runs it in a stubbed environment. A test that reimplements the logic proves
only that two copies of the same assumption agree.

Where a suite must stub something it cannot extract (a DOM handler, a KV store),
the stub carries a comment citing the `file:line` it mirrors, so drift is visible
at review time rather than at 2am.

## Green is not the gate for security work. Mutation testing is.

Break one security-critical line at a time in the real source, require the suite
to go red, restore. The sweep scripts live in the session scratchpad
(`mutate.mjs`, `mutate3.mjs`) rather than here, because each one is written
against the specific lines of a specific change.

This has repeatedly found that the tests merely *agreed* with the code instead of
constraining it. The first sweep of the v2.0.0 work had 6 survivors of 22; a
later sweep of the newest code had 11 of 16, including "accept a malformed secret
from a URL" and "let a link overwrite the secret this device already holds". Both
were driven to zero real survivors, and the tests written to kill them are now in
`cloudsecret` sections 9 to 13.

A survivor that encodes no security property is fine. Two are accepted today: a
sandbox mint guard already enforced by an outer `sbxBlocked()` check, and a KV
record TTL that is storage hygiene. Say so explicitly rather than contorting a
test to make the number look clean.

## Known non-coverage

- **Nothing here runs against real Cloudflare Workers or a real Hubitat hub.**
  Worker and Groovy behaviour is reasoned from source, never executed. For
  anything touching a platform API, a review that checks the assumption against
  documentation is the only verification available.
- `sandbox.html` cannot exercise cloud sync: `cloudSyncPush()` is gated by
  `sbxBlocked()`.
- Push delivery end to end, and real browser notification permission states, are
  not reachable from here.
- `tests/parked/` holds `scopeharness.mjs`, `cloudpayload.mjs` and `keyrace2.mjs`.
  They test designs that were **never shipped** and are excluded from `runall`.
  **Do not count them as coverage.** `scopeharness` in particular *passes while
  documenting live vulnerabilities* in a design that was abandoned; its
  assertions would need inverting before it meant anything.

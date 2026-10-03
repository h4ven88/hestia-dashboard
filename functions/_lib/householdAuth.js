/* One place that answers "is this caller actually this household?"
 *
 * Before this existed the answer was spread across the handlers and three of
 * them did not ask at all. v2.0.0 closed config/index.js and the two endpoints
 * the HUB calls (send.js, armed.js, both of which have the Maker token to
 * hand). The endpoints the BROWSER calls for push and activity were missed, so
 * the household scope was still "whoever shares this public IP" -- the exact
 * assumption v2.0.0 was written to overturn, left standing next door to the
 * fix. activity/index.js even documented it as intentional.
 *
 * THE THREAT MODEL, settled, do not reopen: the attacker is the CGNAT/IP
 * neighbour who is NOT on the LAN. The LAN is deliberately INSIDE the trust
 * boundary, because the hub already publishes the Maker token unauthenticated
 * at /local/hestia-token.json. Anything reachable only from the LAN is not a
 * finding.
 *
 * THREE DOORS, and each exists because the other two can be shut:
 *
 *   token     the raw Maker API token, hashed here and compared against the
 *             hash in the record. Same credential send.js and armed.js use.
 *             DIES ON ROTATION -- regenerating the token in Hubitat leaves the
 *             record holding the old hash forever.
 *   secret    proof of the household secret, compared against a verifier at
 *             its own KV key that NO endpoint returns. Survives a token
 *             rotation, but only if it was established before the rotation and
 *             the secret has not changed since.
 *   recovery  proof the caller can DECRYPT the record: a random R written into
 *             the encrypted half, with sha256(R) in the plaintext half. The
 *             caller recovers R by decrypting and presents it.
 *
 * The third door is the one that makes a rotated token survivable, and it is
 * new. A household hit exactly the state where doors one and two were both
 * shut: they regenerated their Maker token, and separately a second secret was
 * minted on one of their devices. Every write 401'd with no way back in, for
 * the full 30-day record TTL, and nothing on any screen said why.
 *
 * ASK OF EVERY CHECK HERE: which side of this comparison can the attacker
 * choose? A check comparing two values the caller supplied is not a check.
 * Review round 13 of the v2.0.0 work found exactly that shape and twelve
 * earlier rounds had passed over it. In all three doors the stored side comes
 * from a write that was already authorised, and the presented side comes from
 * the request.
 */
import { sha256Hex } from './householdConfig.js';

export const AUTH = {
  OK: 'ok',
  NO_RECORD: 'no-record',          // nothing stored yet; caller decides TOFU
  LEGACY: 'legacy-record',         // pre-split record, no trustworthy verifier
  NO_VERIFIER: 'no-verifier',      // record exists but carries nothing to check
  BAD_TOKEN: 'bad-token',
  BAD_SECRET: 'bad-secret',
  BAD_RECOVERY: 'bad-recovery',
  MISSING: 'missing-credential',
};

/**
 * @param {object} household  the result of getHouseholdConfig(), or null
 * @param {object} presented  { token, secretProof, recoveryProof }
 * @returns {{ok: boolean, via?: string, reason?: string}}
 *
 * A false result is NEVER "allow". Callers decide what to do with NO_RECORD
 * specifically -- for an empty push roster trust-on-first-use is correct,
 * because there is nothing there to protect and refusing would break every new
 * household. For anything holding existing data it is a refusal.
 */
export async function authorizeHousehold(env, { household, shortHash, presented = {} }) {
  if (!household) return { ok: false, reason: AUTH.NO_RECORD };

  /* A legacy record's tokenHash is DERIVED here from a payload anyone sharing
     this address can forge, because the legacy key is
     SHA-256(publicIP + a constant in a public repo). So it proves nothing
     about who is calling and must never satisfy an authorisation check, even
     though it is still good enough to answer "should this door event notify
     anyone?" while households finish migrating. */
  if (household.legacy) return { ok: false, reason: AUTH.LEGACY };

  const cfg = household.config || {};
  const { token, secretProof, recoveryProof } = presented;

  if (token) {
    const presentedHash = await sha256Hex(token);
    if (cfg.tokenHash && presentedHash === cfg.tokenHash) return { ok: true, via: 'token' };
  }

  if (secretProof && typeof secretProof === 'string') {
    const stored = await env.HESTIA_KV.get(`wcap:${shortHash}`);
    if (stored && secretProof === stored) return { ok: true, via: 'secret' };
  }

  if (recoveryProof && typeof recoveryProof === 'string' && cfg.recoveryHash) {
    const presentedHash = await sha256Hex(recoveryProof);
    if (presentedHash === cfg.recoveryHash) return { ok: true, via: 'recovery' };
  }

  if (!cfg.tokenHash && !cfg.recoveryHash) return { ok: false, reason: AUTH.NO_VERIFIER };
  if (!token && !secretProof && !recoveryProof) return { ok: false, reason: AUTH.MISSING };
  if (token) return { ok: false, reason: AUTH.BAD_TOKEN };
  if (secretProof) return { ok: false, reason: AUTH.BAD_SECRET };
  return { ok: false, reason: AUTH.BAD_RECOVERY };
}

/* Machine-readable, so the dashboard can say WHICH door failed.
   Both 401s in config/index.js used to return a bare "unauthorized", so a
   household could not tell "your Maker token was rotated" from "this device
   has the wrong household key" -- and the one message they did get named only
   the token. That sent a real user through a rebuild for the wrong cause. */
export function authMessage(reason) {
  switch (reason) {
    case AUTH.LEGACY:
      return 'this household has not finished migrating to the encrypted record format; open Hestia once on a device that can reach your hub';
    case AUTH.BAD_TOKEN:
      return 'the saved record for this connection was created with a different Maker API token — if you regenerated it in Hubitat, use Settings → Diagnostics to recover';
    case AUTH.BAD_SECRET:
      return 'this device\'s household key does not match the one this network\'s record was created with';
    case AUTH.BAD_RECOVERY:
      return 'the recovery proof did not match this network\'s record';
    case AUTH.NO_VERIFIER:
      return 'this network\'s record carries no credential to check against';
    case AUTH.MISSING:
      return 'no credential was supplied';
    case AUTH.NO_RECORD:
      return 'no saved record exists for this network yet';
    default:
      return 'unauthorized';
  }
}

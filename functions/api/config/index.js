import { getHouseholdConfig, sha256Hex } from '../../_lib/householdConfig.js';

async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Only checks the outer wrapper shape the read side requires; it never
// decrypts or inspects the encrypted payload. Extra top-level keys (`service`,
// `token`) are allowed through deliberately.
function isValidConfigPayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  if (body.encrypted !== true) return false;
  const payload = body.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (typeof payload.iv !== 'string' || !payload.iv) return false;
  if (typeof payload.data !== 'string' || !payload.data) return false;
  if (body.service !== undefined &&
      (typeof body.service !== 'object' || body.service === null || Array.isArray(body.service))) return false;
  return true;
}

export async function onRequestPut({ request, env }) {
  try {
    const ip = request.headers.get('CF-Connecting-IP');
    if (!ip) return Response.json({ status: 'error', message: 'no IP' }, { status: 400 });

    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json({ status: 'error', message: 'invalid JSON' }, { status: 400 });
    }

    if (!isValidConfigPayload(body)) {
      return Response.json({ status: 'error', message: 'invalid config payload shape' }, { status: 400 });
    }

    const raw = JSON.stringify(body);
    if (raw.length > 65536) {
      return Response.json({ status: 'error', message: 'payload too large' }, { status: 413 });
    }

    const hash = await sha256(ip);
    const shortHash = hash.substring(0, 16);
    const ipKey = `ip:${shortHash}`;

    /* Write authority.
     *
     * This endpoint was completely unauthenticated: every device behind one
     * public IP shares the record, so under CGNAT any of many unrelated
     * households could overwrite it -- including writing pushEnabled:false and
     * silently killing the real household's security notifications.
     *
     * The caller proves possession of the Maker API token. The record stores
     * only sha256(token), and the token itself now lives in the encrypted half
     * where a neighbour cannot reach it, so possession is real proof.
     *
     * Three cases, and the middle one is the one that matters:
     *   - no record at all      -> trust on first use, nothing to protect yet
     *   - record present, readable -> must prove the token
     *   - record present, UNREADABLE -> refuse
     *
     * That last case is deliberate. Collapsing it into "no record" would let an
     * attacker write one malformed record and then claim the slot -- the exact
     * fail-open that defeated an earlier attempt at this.
     */
    /* Second proof path, and the reason it exists.
     *
     * Authorising only on the Maker API token meant that rotating that token --
     * an ordinary admin action, and what you would do after a suspected leak --
     * locked the household out of its own record for the full 30-day TTL. The
     * stored verifier was the OLD hash, only the old token could replace it,
     * and the household no longer had it. Every write 401'd, nothing refreshed
     * the TTL, and nothing said why.
     *
     * The household secret is independent of the Maker token, so it survives
     * rotation. Its verifier lives at its OWN key, which no endpoint returns --
     * `discover.js` spreads the stored record verbatim, so anything kept beside
     * the ciphertext is handed straight to the neighbour this whole change
     * exists to exclude.
     */
    const wcapKey = `wcap:${shortHash}`;
    const storedSecretHash = await env.HESTIA_KV.get(wcapKey);
    const presentedSecretHash = typeof body.secretProof === 'string' ? body.secretProof : null;
    const secretProves = !!(storedSecretHash && presentedSecretHash &&
                            presentedSecretHash === storedSecretHash);

    /* Whether this caller proved anything about the household that was already
       stored, as opposed to merely being first through the door. Only a caller
       who did may replace an existing recovery verifier -- see the write below. */
    let tokenProved = false;

    const existingRaw = await env.HESTIA_KV.get(ipKey);
    if (existingRaw && !secretProves) {
      const household = await getHouseholdConfig(env, ip, shortHash);
      if (!household) {
        return Response.json({
          status: 'error',
          message: 'existing record could not be read; refusing to overwrite',
        }, { status: 409 });
      }
      /* THIRD DOOR: proof that the caller can DECRYPT this record.
       *
       * A random R is written into the ENCRYPTED half and sha256(R) into the
       * plaintext half, so recovering R requires the household secret. Neither
       * side is attacker-chosen: the hash was stored by an authorised write,
       * and the neighbour can read the hash but cannot invert it.
       *
       * This exists because doors one and two can BOTH be shut at once, and a
       * real household hit exactly that. They regenerated their Maker API
       * token in Hubitat, which froze the stored tokenHash at a value no
       * device could reproduce, and separately a second secret was minted on
       * one of their devices, which made their secretProof miss the stored
       * verifier. Every write 401'd for the full 30-day TTL with no way back
       * in, and nothing on any screen explained it.
       *
       * It is NOT retroactive: a record written before this release carries no
       * recoveryHash, so it does not rescue that household. It stops the next
       * one. */
      const storedRecovery = household.config && household.config.recoveryHash;
      const presentedRecovery = typeof body.recoveryProof === 'string' ? body.recoveryProof : null;
      if (storedRecovery && presentedRecovery &&
          (await sha256Hex(presentedRecovery)) === storedRecovery) {
        // Proved something about the record that was ALREADY stored, which is
        // the bar mayReplaceVerifier asks for below.
        tokenProved = true;
      } else {
      const storedHash = household.config && household.config.tokenHash;
      if (storedHash) {
        const presented = body.token ? await sha256Hex(body.token) : null;
        if (!presented || presented !== storedHash) {
          /* Machine-readable, because the client could not previously tell
             "your Maker token was rotated" from "this device has the wrong
             household key" -- and the one message it did show named only the
             token, which sent a real user through a rebuild for the wrong
             cause. */
          return Response.json({
            status: 'error', reason: 'bad-token',
            message: 'the saved record for this connection was created with a different Maker API token',
          }, { status: 401 });
        }
        // Matched the hash already in the stored record, so this caller really
        // does hold the household's Maker token -- enough to rotate its secret.
        tokenProved = true;
      } else {
        /* A readable record carrying no usable verifier -- a pre-split record
           whose token could not be derived, or one written by a client that
           omitted it. Letting this through unconditionally made every
           subsequent write by anyone a free write, indefinitely.
           Accept ONLY a write that establishes a verifier, so the slot gets
           claimed properly on the household's next real save and cannot be
           held open. */
        /* A household that has ever established a recovery verifier is NOT
           anonymous, even when its record has momentarily lost its tokenHash.
           The wcap entry still identifies it, and we are inside !secretProves,
           so this caller has already failed to present it.

           Without this, the check below degenerated into "do the attacker's
           own two fields agree with each other", which is trivially true for
           any pair they pick: an IP neighbour could claim a record written
           while the Maker token was blank (mid-onboarding is enough), install
           their own tokenHash, and -- because an authorised write also
           refreshes wcap -- replace the household's recovery verifier and lock
           it out durably, while armed.js and send.js started 401ing the real
           hub's relays. Establishing a fresh verifier is only ever for a
           household that holds no verifier of any kind. */
        if (storedSecretHash) {
          return Response.json({
            status: 'error', reason: 'bad-secret',
            message: 'this network already has a household key and the one presented does not match it',
          }, { status: 401 });
        }
        /* F6. The check below compares two fields the CALLER supplied, which
           is only safe while the slot is genuinely unclaimed. A LEGACY record
           is not evidence of that: its contents are encrypted under
           SHA-256(publicIP + a constant in a public repo), so any neighbour
           can forge one whose decrypted config carries no token, arrive here,
           and claim the slot with a verifier of their choosing.

           Ask of every authorisation check which side the attacker can choose.
           Here they could choose both, and the only thing standing in the way
           was a wcap entry that a forged legacy record would not have. */
        if (household.legacy) {
          return Response.json({
            status: 'error', reason: 'legacy-record',
            message: 'this network\'s record predates the encrypted format; open Hestia on a device that can reach your hub to migrate it',
          }, { status: 401 });
        }
        const incoming = body.service && body.service.tokenHash;
        if (!incoming || typeof incoming !== 'string') {
          return Response.json({
            status: 'error',
            message: 'record has no write verifier; send a config that establishes one',
          }, { status: 401 });
        }
        /* The verifier being claimed must actually match the token the caller
         * presented. Accepting any non-empty string let a caller who proved
         * nothing install a verifier of their choosing and own the slot for
         * the rest of its life.
         */
        const proof = body.token ? await sha256Hex(body.token) : null;
        if (!proof || proof !== incoming) {
          return Response.json({
            status: 'error', reason: 'verifier-mismatch',
            message: 'claimed verifier does not match the presented token',
          }, { status: 401 });
        }
        }
      }   // end of the recovery-proof door's else
    }

    /* Proof material is never persisted. The raw Maker token especially: the
     * record's plaintext half is served to anyone at this IP by discover.js,
     * so storing it would hand over the exact credential this change moved
     * into the encrypted half. */
    const secretProof = presentedSecretHash;
    const webhookCapProof = typeof body.webhookCapProof === 'string' ? body.webhookCapProof : null;
    if (body.token) delete body.token;
    if (body.secretProof) delete body.secretProof;
    if (body.webhookCapProof) delete body.webhookCapProof;
    // Same rule for the recovery proof. Its HASH belongs in the record (the
    // client puts it in the service half); the value itself never does, or the
    // neighbour reading discover.js would simply be handed the credential.
    if (body.recoveryProof) delete body.recoveryProof;

    /* KV does not expose a key's own expiry through get(), so a household that
       is locked out of its record cannot be told how long that lasts. Stamping
       it here lets the UI say "this clears on the 14th" instead of advising an
       open-ended wait -- which is the difference between a user who waits and
       a user who wipes a device and takes the rest of the household down.
       Written server-side on purpose: the client must not get to choose it. */
    const RECORD_TTL_SECONDS = 2592000;
    if (body.service && typeof body.service === 'object') {
      body.service.expiresAt = Date.now() + RECORD_TTL_SECONDS * 1000;
    }

    await env.HESTIA_KV.put(ipKey, JSON.stringify(body), { expirationTtl: RECORD_TTL_SECONDS });

    /* Recorded after the write is authorised, so a rejected caller can never
       install their own recovery credential. Refreshed on every successful
       write so it outlives the record it protects.

       An EXISTING verifier may only be replaced by a caller who proved
       something about the household that was already stored -- the verifier
       itself, or the Maker token in the stored record. The record's TTL is 30
       days and this key's is 60, so a household that goes quiet long enough
       for the record to lapse still has a live verifier; without this gate the
       next writer to the empty slot would be accepted on trust-on-first-use
       AND would overwrite that verifier, destroying the household's only way
       back in. It can still lose the slot in that window -- an empty slot is
       genuinely anonymous and TOFU is the only option -- but it keeps the
       credential, so it can take the record back on its next save. */
    /* WRITE ONLY ON CHANGE, and the reason is a real outage rather than
       tidiness. v2.2.0 took a config save from two KV writes to three by
       adding the webhook verifier, and both verifiers were rewritten on EVERY
       save even though they almost never change. The dashboard pushes config
       on every boot of every device, so a household testing across a few
       devices exhausted Cloudflare's daily KV write allowance and the backend
       began returning 500 to every write -- settings silently stopped
       reaching other devices, which is the exact failure this release existed
       to end. Reported from the field within a day of shipping.

       A read costs a fraction of a write and the allowance for them is far
       larger, so comparing first is cheaper in every case except the one where
       the value genuinely changed.

       The TTL refresh these writes also performed is preserved by the client,
       which forces a periodic save well inside the 30-day record TTL. */
    const mayReplaceVerifier = !storedSecretHash || secretProves || tokenProved;
    if (secretProof && mayReplaceVerifier && secretProof !== storedSecretHash) {
      await env.HESTIA_KV.put(wcapKey, secretProof, { expirationTtl: 2592000 * 2 });
    }

    /* The device-event webhook's verifier, stored only now -- after the write
       was authorised -- for the same reason as wcap above: a rejected caller
       must never get to install their own.
     *
     * It lives at its own key and NOT in the record, because discover.js hands
     * the record's plaintext half to anyone at this address. Putting it there
     * would publish the credential to exactly the attacker it excludes.
     *
     * Its presence is also what closes the webhook's grace window for THIS
     * household: once this key exists, webhook.js refuses uncapped POSTs. */
    if (webhookCapProof && /^[0-9a-f]{64}$/.test(webhookCapProof)) {
      // Same change-only rule as wcap above. This capability is minted once
      // per household and then never moves, so rewriting it on every save was
      // pure cost.
      const storedCap = await env.HESTIA_KV.get(`hcap:${shortHash}`);
      if (storedCap !== webhookCapProof) {
        await env.HESTIA_KV.put(`hcap:${shortHash}`, webhookCapProof, { expirationTtl: 2592000 * 2 });
      }
    }

    return Response.json({ status: 'ok' });
  } catch (err) {
    console.error('[config/index] onRequestPut error:', err);
    return Response.json({ status: 'error', message: 'internal error' }, { status: 500 });
  }
}

import { dispatchPush } from '../../_lib/pushDispatch.js';
import { getHouseholdConfig } from '../../_lib/householdConfig.js';
import { authorizeHousehold, AUTH } from '../../_lib/householdAuth.js';
import { logActivity } from '../../_lib/activityLog.js';

async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Manual/testing entry point -- token-authenticated so it can be called
// directly (e.g. from a terminal) without a real device event. The
// automatic path is webhook.js, triggered by Maker API's device-event POST
// URL feature; both funnel into the same dispatchPush() so gating rules
// can't drift between the two.
//
// Body: { category, title, body, armed, token }
// "token" must match this household's Maker API access token, already
// stored via the existing config-sync PUT under the same ip-hash key. A
// lightweight way to verify the caller actually holds this household's
// credentials before fanning out real notifications, without inventing a
// separate secret-management scheme -- reuses data that's already synced.
export async function onRequestPost({ request, env }) {
  try {
    const ip = request.headers.get('CF-Connecting-IP');
    if (!ip) return Response.json({ status: 'error', message: 'no IP' }, { status: 400 });

    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json({ status: 'error', message: 'invalid JSON' }, { status: 400 });
    }

    const { category, title, body: message, armed, token, targetDeviceId } = body;
    if (!title || !message) {
      return Response.json({ status: 'error', message: 'missing title or body' }, { status: 400 });
    }

    const hash = await sha256(ip);
    const shortHash = hash.substring(0, 16);

    const household = await getHouseholdConfig(env, ip, shortHash);
    if (!household) return Response.json({ status: 'error', message: 'unknown household' }, { status: 404 });

    /* ⛔ THIS GOES THROUGH authorizeHousehold, AND IT DID NOT USED TO.
     *
     * It compared sha256(token) against household.config.tokenHash directly.
     * For a LEGACY record that stored value is DERIVED, in
     * householdConfig.js:70, from plaintext decrypted under
     * SHA-256(publicIP + ':hestia-cloud-sync') -- a constant in a public repo.
     * householdAuth.js:76 refuses a legacy record for exactly that reason and
     * says so in prose: it "proves nothing about who is calling and must never
     * satisfy an authorisation check". This handler then authorised on
     * precisely that value. One module forbade it and two accepted it.
     *
     * Two ways in, both reachable: decrypt a genuine unmigrated household's
     * record (discover.js serves legacy ciphertext to anyone, since its
     * `service` gate cannot fire on a record with no `service` key) and replay
     * the real token; or TOFU-write a legacy-SHAPED record over any lapsed
     * slot, sealed under the public key, carrying a token of your choosing.
     * Either way send.js authorised a stranger, and `smoke` is in
     * ALWAYS_CATEGORIES so it bypasses the armed gate by design -- a fabricated
     * "Smoke / CO Alert" to every phone in a house, at any hour, repeatably.
     *
     * ⚠ STATED TRADE: a household still holding a genuine legacy record loses
     * push until it opens a dashboard once (which mints and pushes a modern
     * record). That population should be empty three weeks past v2.0.0, since
     * the record TTL is 30 days and any boot migrates it -- but it cannot be
     * distinguished from a forgery, because the legacy key is public. Refusing
     * is the only safe side, and the warn below makes a real case diagnosable
     * instead of silent. */
    const auth = await authorizeHousehold(env, {
      household, shortHash, presented: { token },
    });
    if (!auth.ok) {
      if (auth.reason === AUTH.LEGACY) {
        console.warn(`[push/send] refused a legacy record for ${shortHash}; household must open a dashboard once to migrate`);
      }
      return Response.json({ status: 'error', reason: auth.reason, message: 'unauthorized' }, { status: 401 });
    }

    // This endpoint is the only path for hsmAlert intrusion trips AND
    // hsmStatus arm/disarm transitions (Groovy's pushHsmAlertHandler and
    // pushHsmStatusHandler both call it directly, bypassing webhook.js
    // entirely), so it's also the only place those can be captured for the
    // Activity Log.
    if (category) {
      const hsmCategories = category === 'alarming' || category === 'armStatus';
      await logActivity(env, shortHash, { category, title, body: message, source: hsmCategories ? 'hsm' : 'manual' });
    }

    const result = await dispatchPush(env, shortHash, { category, title, body: message, armed, targetDeviceId });
    return Response.json({ status: 'ok', logged: !!category, ...result });
  } catch (err) {
    console.error('[push/send] onRequestPost error:', err);
    return Response.json({ status: 'error', message: 'internal error' }, { status: 500 });
  }
}

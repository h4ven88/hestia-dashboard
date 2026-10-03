import { getHouseholdConfig } from '../../_lib/householdConfig.js';
import { authorizeHousehold } from '../../_lib/householdAuth.js';

async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* Returns this network's record.
 *
 * THE CIPHERTEXT IS PUBLIC AND THAT IS FINE. `payload` goes to any caller,
 * because a device that can decrypt it IS the household -- that is the whole
 * basis of the trust model, and cloudSyncDiscover() and _cloudRecordUnreadable()
 * both need it before they can prove anything about themselves.
 *
 * THE SERVICE HALF IS NOT PUBLIC, and used to be. This function spread the
 * stored record verbatim, so anyone sharing the public IP received
 * service.artemisSensors.{contacts,motions,smokes,waters}[].{id,name} and
 * service.locks[].{id,label} -- a labelled inventory of the household's
 * sensors and door locks.
 *
 * On its own that is a privacy leak. Combined with the device-event webhook it
 * was a remotely triggerable fire alarm: read the smoke sensor ids here, POST
 * a fabricated 'smoke'/'detected' event for one of them, and because 'smoke'
 * is in pushDispatch's ALWAYS_CATEGORIES it bypasses the armed-only gate and
 * notifies every registered device. The webhook now carries a capability; this
 * closes the reconnaissance half, which also matters because the capability
 * has a grace window and this does not.
 *
 * Hubitat device ids are small integers, so withholding them is not by itself
 * a defence against a determined attacker who will enumerate. It raises the
 * cost, it stops the casual version, and it stops handing over the household's
 * room and device NAMES, which nothing can re-derive.
 */
export async function onRequestGet({ request, env }) {
  try {
    const ip = request.headers.get('CF-Connecting-IP');
    if (!ip) return Response.json({ found: false });

    const hash = await sha256(ip);
    const shortHash = hash.substring(0, 16);
    const value = await env.HESTIA_KV.get(`ip:${shortHash}`);

    if (!value) return Response.json({ found: false });

    let parsed;
    try { parsed = JSON.parse(value); } catch { return Response.json({ found: false }); }

    const body = { found: true, ...parsed };

    /* The expiry is lifted OUT of the gated half deliberately.
     *
     * It is the one fact a locked-out household actually needs, and a
     * locked-out household is by definition the one that cannot authenticate.
     * Leaving it behind the gate meant the only people it was written for were
     * the only people who could never see it.
     *
     * Safe to serve openly: it says when this record was last written, which
     * tells an attacker nothing they cannot already infer from the record
     * being here at all. It carries no device, no name and no credential.
     *
     * And it answers the question that actually decides what someone should
     * do. A date that stays put means nothing is writing this record, so it
     * will lapse and waiting works. A date that keeps moving means something
     * IS writing it, so it is not abandoned and waiting never will. */
    if (body.service && typeof body.service.expiresAt === 'number') {
      body.expiresAt = body.service.expiresAt;
    }

    if (body.service) {
      /* Credentials ride in headers because this is a GET. The raw Maker token
         already reaches this origin on every config save, so presenting it
         here is no new exposure. */
      const household = await getHouseholdConfig(env, ip, shortHash);
      const auth = await authorizeHousehold(env, {
        household,
        shortHash,
        presented: {
          token:         request.headers.get('X-Hestia-Token') || null,
          secretProof:   request.headers.get('X-Hestia-Proof') || null,
          recoveryProof: request.headers.get('X-Hestia-Recovery') || null,
        },
      });
      if (!auth.ok) delete body.service;
    }

    return new Response(JSON.stringify(body), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        // The response differs by credential, so a shared cache must never
        // serve one caller's authorised copy to the next caller.
        'Vary': 'X-Hestia-Token, X-Hestia-Proof, X-Hestia-Recovery',
      }
    });
  } catch (err) {
    console.error('[config/discover] onRequestGet error:', err);
    return Response.json({ found: false }, { status: 500 });
  }
}

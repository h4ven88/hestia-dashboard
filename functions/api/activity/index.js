import { listActivity } from '../../_lib/activityLog.js';
import { getHouseholdConfig } from '../../_lib/householdConfig.js';
import { authorizeHousehold, authMessage, AUTH } from '../../_lib/householdAuth.js';

async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* This used to carry a comment stating that the caller's own public IP hash IS
   the household scope and no token was needed to read the events back. That is
   precisely the assumption v2.0.0 was written to overturn, left standing one
   directory away from the fix.

   What it exposed: a timeline of every door and window opening, every motion
   trigger, every lock, and every arm/disarm, with device names, readable by
   anyone sharing the public address. Under CGNAT that is strangers. It is an
   occupancy log -- when the house is empty, and when it is disarmed.

   Read-only, so the collateral from getting this wrong is an empty Activity
   Log panel rather than a broken household, and the panel says why. */
export async function onRequestGet({ request, env }) {
  try {
    const ip = request.headers.get('CF-Connecting-IP');
    if (!ip) return Response.json({ status: 'error', message: 'no IP' }, { status: 400 });

    const hash = await sha256(ip);
    const shortHash = hash.substring(0, 16);

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
    /* Same migration window as push/subscribe.js: a record written before this
       release carries no recoveryHash, so a household whose Maker token was
       rotated would lose its log on upgrade with no way back. The record gains
       one on the household's next boot. */
    const grace = auth.reason === AUTH.NO_RECORD ||
                  auth.reason === AUTH.LEGACY ||
                  !((household && household.config) || {}).recoveryHash;
    if (!auth.ok && !grace) {
      return Response.json({
        status: 'error', reason: auth.reason, message: authMessage(auth.reason),
      }, { status: 401 });
    }

    // Capped well under Cloudflare's per-invocation subrequest ceiling --
    // listActivity() issues one KV get per entry, so this bound (plus the
    // list() call itself) is what actually keeps this endpoint from 500ing.
    const url = new URL(request.url);
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit'), 10) || 25, 1), 25);
    const cursor = url.searchParams.get('cursor') || undefined;

    const { entries, nextCursor } = await listActivity(env, shortHash, { limit, cursor });
    return Response.json({ status: 'ok', entries, nextCursor }, {
      headers: { 'Cache-Control': 'no-store' }
    });
  } catch (err) {
    console.error('[activity/index] onRequestGet error:', err);
    return Response.json({ status: 'error', message: 'internal error' }, { status: 500 });
  }
}

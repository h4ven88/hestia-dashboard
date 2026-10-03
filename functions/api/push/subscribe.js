import { mutatePushDevices } from '../../_lib/pushDevices.js';
import { getHouseholdConfig } from '../../_lib/householdConfig.js';
import { authorizeHousehold, authMessage, AUTH } from '../../_lib/householdAuth.js';

async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function householdKey(request) {
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip) return null;
  const hash = await sha256(ip);
  return `push:${hash.substring(0, 16)}`;
}

/* A household has a handful of devices, not hundreds. Without a ceiling a
   neighbour could PUT a few hundred synthetic subscriptions and push every
   real dispatch over Cloudflare's per-invocation subrequest limit, because
   dispatchPush() iterates the whole roster one subrequest at a time. The real
   alarm then fails. Worse than the DELETE, because restoring your own devices
   does not remove theirs. */
const MAX_DEVICES = 32;

/* Shared by PUT and DELETE. Both mutate the household's push roster, and a
   DELETE that anyone could call is the quieter half of the same problem: it
   silently stops a household's alarms rather than adding noise.
 *
 * TRUST-ON-FIRST-USE ON AN ABSENT RECORD IS DELIBERATE. There is nothing in
 * push:<hash> to protect yet, and refusing would break every household whose
 * first config write has not landed -- which is the "the fix locks out someone
 * who was fine" failure that cost this project two releases.
 *
 * SO IS THE GRACE ON A PRE-UPGRADE RECORD. A record written before this
 * release carries no recoveryHash, so a household whose Maker token was
 * rotated has no door left and would lose push registration on upgrade. The
 * record gains one on the household's next boot, because boot pushes config,
 * and from that moment this is enforced. Same self-closing shape as the
 * webhook capability: nobody breaks, and each household is protected the first
 * time it opens a dashboard. */
async function authorize(request, env) {
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip) return { ok: false, status: 400, message: 'no IP' };
  const shortHash = (await sha256(ip)).substring(0, 16);
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
  if (auth.ok) return { ok: true };

  if (auth.reason === AUTH.NO_RECORD) {
    console.warn('[push/subscribe] no record for this household yet; accepting on first use', shortHash);
    return { ok: true };
  }
  if (auth.reason === AUTH.LEGACY || !(household.config || {}).recoveryHash) {
    console.warn('[push/subscribe] pre-upgrade record, accepting during the migration window', shortHash);
    return { ok: true };
  }
  return { ok: false, status: 401, message: authMessage(auth.reason), reason: auth.reason };
}

// Body: { deviceId, deviceName, mode: 'always'|'armed', subscription: PushSubscriptionJSON }
// Stores one device's subscription without disturbing other devices already
// registered for the same household (same pattern as config sync -- scoped
// by hashed public IP, since a browser and the hub it's paired with share
// the same home network's public IP).
export async function onRequestPut({ request, env }) {
  try {
    const key = await householdKey(request);
    if (!key) return Response.json({ status: 'error', message: 'no IP' }, { status: 400 });

    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json({ status: 'error', message: 'invalid JSON' }, { status: 400 });
    }

    const { deviceId, deviceName, mode, subscription } = body;
    if (!deviceId || !subscription || !subscription.endpoint || !subscription.keys) {
      return Response.json({ status: 'error', message: 'missing deviceId or subscription' }, { status: 400 });
    }
    // A real PushSubscriptionJSON from the browser's Push API always carries
    // both key material fields -- a malformed/hand-crafted payload could
    // omit one, which would otherwise only surface later as a silent
    // dispatch failure with no signal back to the caller.
    const keys = subscription.keys;
    if (typeof keys.p256dh !== 'string' || !keys.p256dh || typeof keys.auth !== 'string' || !keys.auth) {
      return Response.json({ status: 'error', message: 'subscription missing p256dh or auth key' }, { status: 400 });
    }
    if (mode !== 'always' && mode !== 'armed') {
      return Response.json({ status: 'error', message: 'mode must be "always" or "armed"' }, { status: 400 });
    }

    const raw = JSON.stringify(body);
    if (raw.length > 8192) {
      return Response.json({ status: 'error', message: 'payload too large' }, { status: 413 });
    }

    const auth = await authorize(request, env);
    if (!auth.ok) return Response.json({ status: 'error', message: auth.message, reason: auth.reason }, { status: auth.status });

    let rejected = false;
    await mutatePushDevices(env, key, (devices) => {
      // Re-registering a device already on the roster is always allowed; the
      // ceiling only applies to ADDING a new one, so a household at the limit
      // can still refresh its own subscriptions.
      if (!devices[deviceId] && Object.keys(devices).length >= MAX_DEVICES) {
        rejected = true;
        return;
      }
      devices[deviceId] = { name: deviceName || deviceId, mode, subscription };
    });
    if (rejected) {
      return Response.json({
        status: 'error',
        message: `this household already has ${MAX_DEVICES} registered devices`,
      }, { status: 409 });
    }
    return Response.json({ status: 'ok' });
  } catch (err) {
    console.error('[push/subscribe] onRequestPut error:', err);
    return Response.json({ status: 'error', message: 'internal error' }, { status: 500 });
  }
}

// Body: { deviceId }
export async function onRequestDelete({ request, env }) {
  try {
    const key = await householdKey(request);
    if (!key) return Response.json({ status: 'error', message: 'no IP' }, { status: 400 });

    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json({ status: 'error', message: 'invalid JSON' }, { status: 400 });
    }
    if (!body.deviceId) return Response.json({ status: 'error', message: 'missing deviceId' }, { status: 400 });

    const auth = await authorize(request, env);
    if (!auth.ok) return Response.json({ status: 'error', message: auth.message, reason: auth.reason }, { status: auth.status });

    await mutatePushDevices(env, key, (devices) => {
      delete devices[body.deviceId];
    });
    return Response.json({ status: 'ok' });
  } catch (err) {
    console.error('[push/subscribe] onRequestDelete error:', err);
    return Response.json({ status: 'error', message: 'internal error' }, { status: 500 });
  }
}

import { getHouseholdConfig } from '../../_lib/householdConfig.js';

// Temporary diagnostic endpoint -- returns exactly what this household's
// decrypted cloud config currently holds, so we can see ground truth
// directly instead of inferring it from webhook.js's binary skip reasons.
// Deliberately strips the Maker API token before responding. Remove once
// the push-sync investigation is done; this isn't meant to be permanent.
export async function onRequestGet({ request, env }) {
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip) return Response.json({ status: 'error', message: 'no IP' }, { status: 400 });

  const hashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip));
  const shortHash = [...new Uint8Array(hashBuf)].map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 16);

  const household = await getHouseholdConfig(env, ip, shortHash);
  if (!household) return Response.json({ status: 'ok', found: false });

  const c = household.config || {};

  // Also list the actual registered push devices -- id (truncated),
  // name, mode, and which push service their subscription endpoint
  // belongs to, without exposing the full subscription/keys.
  const pushRaw = await env.HESTIA_KV.get(`push:${shortHash}`);
  let devices = [];
  if (pushRaw) {
    try {
      const parsed = JSON.parse(pushRaw);
      devices = Object.entries(parsed).map(([id, d]) => {
        let endpointHost = null;
        try { endpointHost = new URL(d.subscription?.endpoint || '').host; } catch {}
        return { idPrefix: id.slice(0, 8), name: d.name, mode: d.mode, endpointHost };
      });
    } catch {}
  }

  return Response.json({
    status: 'ok',
    found: true,
    savedAt: household.savedAt,
    savedAtISO: household.savedAt ? new Date(household.savedAt).toISOString() : null,
    version: household.version,
    pushEnabled: c.pushEnabled,
    pushMotion: c.pushMotion,
    pushMotionDevices: c.pushMotionDevices,
    pushDoors: c.pushDoors,
    hasToken: !!c.token,
    motionSensorCount: (c.artemisSensors && c.artemisSensors.motions || []).length,
    registeredDeviceCount: devices.length,
    registeredDevices: devices,
  });
}

import { mutatePushDevices } from '../../_lib/pushDevices.js';

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

// Body: { deviceId, deviceName, mode: 'always'|'armed', subscription: PushSubscriptionJSON }
// Stores one device's subscription without disturbing other devices already
// registered for the same household (same pattern as config sync -- scoped
// by hashed public IP, since a browser and the hub it's paired with share
// the same home network's public IP).
export async function onRequestPut({ request, env }) {
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
  if (mode !== 'always' && mode !== 'armed') {
    return Response.json({ status: 'error', message: 'mode must be "always" or "armed"' }, { status: 400 });
  }

  const raw = JSON.stringify(body);
  if (raw.length > 8192) {
    return Response.json({ status: 'error', message: 'payload too large' }, { status: 413 });
  }

  await mutatePushDevices(env, key, (devices) => {
    devices[deviceId] = { name: deviceName || deviceId, mode, subscription };
  });
  return Response.json({ status: 'ok' });
}

// Body: { deviceId }
export async function onRequestDelete({ request, env }) {
  const key = await householdKey(request);
  if (!key) return Response.json({ status: 'error', message: 'no IP' }, { status: 400 });

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ status: 'error', message: 'invalid JSON' }, { status: 400 });
  }
  if (!body.deviceId) return Response.json({ status: 'error', message: 'missing deviceId' }, { status: 400 });

  await mutatePushDevices(env, key, (devices) => {
    delete devices[body.deviceId];
  });
  return Response.json({ status: 'ok' });
}

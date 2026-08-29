import { deserializeVapidKeys, sendPushNotification } from 'web-push-browser';

async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Not sensitive -- meant to be public, embedded client-side too. Only the
// private key (env.VAPID_PRIVATE_KEY, a Cloudflare Pages secret) matters.
const VAPID_PUBLIC_KEY = 'BGCW-E3pct69syRd4q6HDJ5mBvgrcd_Q6tkZ740s-rkuVsMYGeZyCMXjkAknBsy3mVIxVoUALroDtsPXqQAEs7A';
const VAPID_SUBJECT = 'https://hestari.com';

// Categories that bypass the per-device "armed only" gate entirely --
// mirrors CONFIG.pushAlarming/pushSmoke/pushWater in dashboard.html. A fire
// or water alert shouldn't go quiet just because nobody armed the burglar
// alarm, so these always reach any registered device regardless of mode.
const ALWAYS_CATEGORIES = new Set(['alarming', 'smoke', 'water']);

// Body: { category, title, body, armed, token }
// "token" must match this household's Maker API access token, already
// stored via the existing config-sync PUT under the same ip-hash key. A
// lightweight way to verify the caller actually holds this household's
// credentials before fanning out real notifications, without inventing a
// separate secret-management scheme -- reuses data that's already synced.
export async function onRequestPost({ request, env }) {
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip) return Response.json({ status: 'error', message: 'no IP' }, { status: 400 });

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ status: 'error', message: 'invalid JSON' }, { status: 400 });
  }

  const { category, title, body: message, armed, token } = body;
  if (!title || !message) {
    return Response.json({ status: 'error', message: 'missing title or body' }, { status: 400 });
  }

  const hash = await sha256(ip);
  const shortHash = hash.substring(0, 16);

  const configRaw = await env.HESTIA_KV.get(`ip:${shortHash}`);
  if (!configRaw) return Response.json({ status: 'error', message: 'unknown household' }, { status: 404 });

  const householdConfig = JSON.parse(configRaw);
  const storedToken = householdConfig.config && householdConfig.config.token;
  if (!storedToken || !token || token !== storedToken) {
    return Response.json({ status: 'error', message: 'unauthorized' }, { status: 401 });
  }

  const pushRaw = await env.HESTIA_KV.get(`push:${shortHash}`);
  if (!pushRaw) return Response.json({ status: 'ok', sent: 0, failed: 0 });
  const devices = JSON.parse(pushRaw);

  const bypassesArmedGate = ALWAYS_CATEGORIES.has(category);
  const keyPair = await deserializeVapidKeys({
    publicKey: VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
  });

  let sent = 0, failed = 0;
  const pruned = [];

  for (const [deviceId, device] of Object.entries(devices)) {
    const eligible = bypassesArmedGate || device.mode === 'always' || (device.mode === 'armed' && armed === true);
    if (!eligible) continue;

    try {
      const res = await sendPushNotification(
        keyPair,
        device.subscription,
        VAPID_SUBJECT,
        JSON.stringify({ title, body: message })
      );
      if (res.ok) {
        sent++;
      } else if (res.status === 404 || res.status === 410) {
        // Subscription is dead (browser data cleared, uninstalled, etc.) -- self-prune.
        pruned.push(deviceId);
        failed++;
      } else {
        failed++;
      }
    } catch {
      failed++;
    }
  }

  if (pruned.length) {
    pruned.forEach(id => delete devices[id]);
    await env.HESTIA_KV.put(`push:${shortHash}`, JSON.stringify(devices), { expirationTtl: 2592000 });
  }

  return Response.json({ status: 'ok', sent, failed, pruned: pruned.length });
}

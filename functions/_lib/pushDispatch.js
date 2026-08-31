// Shared by send.js (manual/testing, token-authenticated) and webhook.js
// (automatic, triggered by Maker API device events). Both resolve down to
// "given a household and a category/title/body/armed, fan it out to their
// registered devices" -- this is that one shared step, kept in one place so
// the two call sites can't drift out of sync on gating rules.
import { deserializeVapidKeys, sendPushNotification } from '../_vendor/web-push-browser/index.js';

const VAPID_PUBLIC_KEY = 'BGCW-E3pct69syRd4q6HDJ5mBvgrcd_Q6tkZ740s-rkuVsMYGeZyCMXjkAknBsy3mVIxVoUALroDtsPXqQAEs7A';
const VAPID_SUBJECT = 'https://hestari.com';

// Categories that bypass the per-device "armed only" gate entirely --
// mirrors CONFIG.pushAlarming/pushSmoke/pushWater in dashboard.html. A fire
// or water alert shouldn't go quiet just because nobody armed the burglar
// alarm, so these always reach any registered device regardless of mode.
const ALWAYS_CATEGORIES = new Set(['alarming', 'smoke', 'water']);

export async function dispatchPush(env, shortHash, { category, title, body, armed }) {
  const pushRaw = await env.HESTIA_KV.get(`push:${shortHash}`);
  if (!pushRaw) return { sent: 0, failed: 0, pruned: 0 };
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
        JSON.stringify({ title, body })
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

  return { sent, failed, pruned: pruned.length };
}

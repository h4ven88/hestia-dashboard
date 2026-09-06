// Shared by send.js (manual/testing, token-authenticated) and webhook.js
// (automatic, triggered by Maker API device events). Both resolve down to
// "given a household and a category/title/body/armed, fan it out to their
// registered devices" -- this is that one shared step, kept in one place so
// the two call sites can't drift out of sync on gating rules.
import { deserializeVapidKeys, sendPushNotification } from '../_vendor/web-push-browser/index.js';
import { mutatePushDevices } from './pushDevices.js';

const VAPID_PUBLIC_KEY = 'BGCW-E3pct69syRd4q6HDJ5mBvgrcd_Q6tkZ740s-rkuVsMYGeZyCMXjkAknBsy3mVIxVoUALroDtsPXqQAEs7A';
const VAPID_SUBJECT = 'https://hestari.com';

// Categories that bypass the per-device "armed only" gate entirely --
// mirrors CONFIG.pushAlarming/pushSmoke/pushWater in dashboard.html. A fire
// or water alert shouldn't go quiet just because nobody armed the burglar
// alarm, so these always reach any registered device regardless of mode.
const ALWAYS_CATEGORIES = new Set(['alarming', 'smoke', 'water']);

// The vendored sendPushNotification() ends in a bare fetch() with no
// timeout and no way to pass an AbortSignal in -- the same unguarded-fetch
// class already fixed on the dashboard's boot path, just never carried
// here. A hung push-service endpoint (a stale FCM/autopush registration,
// a flaky mobile carrier path) would otherwise block this call forever.
// Racing a timeout can't truly cancel the underlying request, but it lets
// dispatch move on and count the device as failed instead of hanging.
const PUSH_SEND_TIMEOUT_MS = 8000;
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('push send timed out')), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

export async function dispatchPush(env, shortHash, { category, title, body, armed, targetDeviceId }) {
  const pushRaw = await env.HESTIA_KV.get(`push:${shortHash}`);
  if (!pushRaw) return { sent: 0, failed: 0, pruned: 0, targetFound: !targetDeviceId };
  const devices = JSON.parse(pushRaw);

  const bypassesArmedGate = ALWAYS_CATEGORIES.has(category);
  const keyPair = await deserializeVapidKeys({
    publicKey: VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
  });

  // A targeted send (currently only "test this one device" from Diagnostics)
  // ignores the armed-only gate entirely -- the point is confirming that
  // exact device's subscription still works right now, not whether it would
  // have been eligible under the household's current arm state.
  const eligible = targetDeviceId
    ? Object.entries(devices).filter(([deviceId]) => deviceId === targetDeviceId)
    : Object.entries(devices).filter(([, device]) =>
        bypassesArmedGate || device.mode === 'always' || (device.mode === 'armed' && armed === true)
      );

  // Dispatched in parallel with Promise.allSettled -- previously a plain
  // sequential for-loop, so one slow/hung device delayed or blocked every
  // other device in the household, including this same alarming/smoke/water
  // bypass path. Each device's outcome is now independent.
  const outcomes = await Promise.allSettled(
    eligible.map(([deviceId, device]) =>
      withTimeout(
        sendPushNotification(keyPair, device.subscription, VAPID_SUBJECT, JSON.stringify({ title, body })),
        PUSH_SEND_TIMEOUT_MS
      ).then((res) => ({ deviceId, res }))
    )
  );

  let sent = 0, failed = 0;
  const pruned = [];

  for (const outcome of outcomes) {
    if (outcome.status !== 'fulfilled') { failed++; continue; }
    const { deviceId, res } = outcome.value;
    if (res.ok) {
      sent++;
    } else if (res.status === 404 || res.status === 410) {
      // Subscription is dead (browser data cleared, uninstalled, etc.) -- self-prune.
      // Records the endpoint we actually sent to, not just the device ID, so
      // a re-subscribe under the same ID during this dispatch window (up to
      // PUSH_SEND_TIMEOUT_MS long) doesn't get deleted out from under it.
      pruned.push({ id: deviceId, endpoint: devices[deviceId].subscription.endpoint });
      failed++;
    } else {
      failed++;
    }
  }

  if (pruned.length) {
    // Re-reads fresh rather than pruning the `devices` snapshot from the top
    // of this call -- dispatch can take up to PUSH_SEND_TIMEOUT_MS per
    // device, plenty of time for a subscribe/unsubscribe to land in between.
    await mutatePushDevices(env, `push:${shortHash}`, (freshDevices) => {
      pruned.forEach(({ id, endpoint }) => {
        if (freshDevices[id] && freshDevices[id].subscription.endpoint === endpoint) delete freshDevices[id];
      });
    });
  }

  return { sent, failed, pruned: pruned.length, targetFound: targetDeviceId ? eligible.length > 0 : true };
}

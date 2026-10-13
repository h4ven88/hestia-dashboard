// Shared by send.js (manual/testing, token-authenticated) and webhook.js
// (automatic, triggered by Maker API device events). Both resolve down to
// "given a household and a category/title/body/armed, fan it out to their
// registered devices" -- this is that one shared step, kept in one place so
// the two call sites can't drift out of sync on gating rules.
import { deserializeVapidKeys, sendPushNotification } from '../_vendor/web-push-browser/index.js';
import { mutatePushDevices } from './pushDevices.js';
import { sendFcmNotification, fcmTokenIsDead } from './fcm.js';

const VAPID_PUBLIC_KEY = 'BGCW-E3pct69syRd4q6HDJ5mBvgrcd_Q6tkZ740s-rkuVsMYGeZyCMXjkAknBsy3mVIxVoUALroDtsPXqQAEs7A';
const VAPID_SUBJECT = 'https://hestari.com';

// Categories that bypass the per-device "armed only" gate entirely --
// mirrors CONFIG.pushAlarming/pushSmoke/pushWater/pushArmStatus in
// dashboard.html. A fire or water alert shouldn't go quiet just because
// nobody armed the burglar alarm, so these always reach any registered
// device regardless of mode. armStatus belongs here for a different reason:
// the "armed" boolean passed alongside each armStatus notification reflects
// whether the house IS armed at that instant, which is false during every
// arming/disarming transition and only true for the "armed" events
// themselves -- gating on it would mean an "armed only" device could never
// receive the arming-started or disarmed notifications at all, silently
// defeating the whole category for exactly the devices most likely to want it.
// 'reminder' is here because reminders have nothing to do with the alarm. The
// armed gate is intrusion-detection logic: it answers "is the house in a state
// where this sensor event matters?". A reminder to walk the dog matters
// exactly as much armed as disarmed, and gating it would mean a device set to
// "armed only" silently swallowed every reminder while you were out -- the one
// time you are least likely to be looking at a screen and most likely to want
// the notification.
const ALWAYS_CATEGORIES = new Set(['alarming', 'smoke', 'water', 'armStatus', 'reminder']);

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

/* The three decisions below are exported as pure functions on purpose.
 *
 * dispatchPush itself is almost entirely I/O: KV, two push transports, a
 * timeout race. Testing it end to end would mean mocking ES module imports,
 * and a test built on a mock of the sender proves the mock works. These are
 * the parts where a mistake is silent and expensive -- sending to the wrong
 * transport, dropping a device that was eligible, pruning one that had just
 * re-registered -- so they are separated out and constrained by tests, the
 * same way HubDiscovery's record handling is.
 */

/** Which transport a stored device uses. The only discriminator, everywhere. */
export function isFcmDevice(device) {
  return !!device && device.kind === 'fcm';
}

/**
 * Who should receive this notification.
 *
 * Transport-blind by design: an FCM device and a Web Push device with the same
 * mode must be treated identically here, or the armed gate would mean
 * different things on a phone and a laptop in the same household.
 */
export function selectEligible(devices, { category, armed, targetDeviceId }) {
  // A targeted send (currently only "test this one device" from Diagnostics)
  // ignores the armed-only gate entirely -- the point is confirming that exact
  // device still works right now, not whether it would have been eligible
  // under the household's current arm state.
  if (targetDeviceId) {
    return Object.entries(devices).filter(([deviceId]) => deviceId === targetDeviceId);
  }
  const bypasses = ALWAYS_CATEGORIES.has(category);
  return Object.entries(devices).filter(([, device]) =>
    bypasses || device.mode === 'always' || (device.mode === 'armed' && armed === true)
  );
}

/**
 * Is this response a dead registration rather than a transient failure?
 *
 * Web Push says 404/410. FCM says 404 UNREGISTERED, and 400 for a malformed
 * token. Everything else is a failure to count and retry later, never a reason
 * to delete somebody's device: a 500 from a push service is a bad afternoon,
 * and pruning on it would quietly unregister a household mid-outage.
 */
export function shouldPrune(device, status) {
  return isFcmDevice(device)
    ? fcmTokenIsDead(status)
    : (status === 404 || status === 410);
}

export async function dispatchPush(env, shortHash, { category, title, body, armed, targetDeviceId }) {
  const pushRaw = await env.HESTIA_KV.get(`push:${shortHash}`);
  if (!pushRaw) return { sent: 0, failed: 0, pruned: 0, targetFound: !targetDeviceId };
  const devices = JSON.parse(pushRaw);

  /* A household can hold both kinds at once: a phone running the app and the
     same person's laptop browser. The VAPID keys are only needed if at least
     one Web Push device is eligible, so an FCM-only household never pays for
     the key derivation -- and, more importantly, a missing VAPID_PRIVATE_KEY
     cannot take down a send that was never going to use it. */
  const isFcm = isFcmDevice;

  // A targeted send (currently only "test this one device" from Diagnostics)
  // ignores the armed-only gate entirely -- the point is confirming that
  // exact device's subscription still works right now, not whether it would
  // have been eligible under the household's current arm state.
  const eligible = selectEligible(devices, { category, armed, targetDeviceId });

  // Derived only if a Web Push device is actually eligible. See isFcm above.
  const keyPair = eligible.some(([, d]) => !isFcm(d))
    ? await deserializeVapidKeys({
        publicKey: VAPID_PUBLIC_KEY,
        privateKey: env.VAPID_PRIVATE_KEY,
      })
    : null;

  // Dispatched in parallel with Promise.allSettled -- previously a plain
  // sequential for-loop, so one slow/hung device delayed or blocked every
  // other device in the household, including this same alarming/smoke/water
  // bypass path. Each device's outcome is now independent, and that now also
  // means an FCM outage cannot delay a browser's notification or the reverse.
  const outcomes = await Promise.allSettled(
    eligible.map(([deviceId, device]) =>
      withTimeout(
        isFcm(device)
          ? sendFcmNotification(env, device.token, { title, body, category, tag: category })
          : sendPushNotification(keyPair, device.subscription, VAPID_SUBJECT, JSON.stringify({ title, body })),
        PUSH_SEND_TIMEOUT_MS
      ).then((res) => ({ deviceId, res }))
    )
  );

  let sent = 0, failed = 0;
  const pruned = [];

  for (const outcome of outcomes) {
    if (outcome.status !== 'fulfilled') { failed++; continue; }
    const { deviceId, res } = outcome.value;
    const device = devices[deviceId];
    if (res.ok) {
      sent++;
    } else if (shouldPrune(device, res.status)) {
      // The registration is dead (app uninstalled, browser data cleared, token
      // rotated) -- self-prune. Records the exact value we sent to, not just
      // the device ID, so a re-registration under the same ID during this
      // dispatch window (up to PUSH_SEND_TIMEOUT_MS long) isn't deleted out
      // from under itself.
      pruned.push({
        id: deviceId,
        ref: isFcm(device) ? device.token : device.subscription.endpoint,
      });
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
      pruned.forEach(({ id, ref }) => {
        const fresh = freshDevices[id];
        if (!fresh) return;
        /* Compared against whichever value THIS record carries, not whichever
           the dead one carried. A device that re-registered as the other
           transport in the meantime is a different registration and must
           survive, so a shape mismatch means "leave it alone". */
        const current = isFcm(fresh) ? fresh.token : (fresh.subscription || {}).endpoint;
        if (current === ref) delete freshDevices[id];
      });
    });
  }

  return { sent, failed, pruned: pruned.length, targetFound: targetDeviceId ? eligible.length > 0 : true };
}

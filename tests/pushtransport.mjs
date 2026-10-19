/* Two push transports in one household, against the real exported functions.
 *
 * The stakes here are asymmetric. FCM is new and nobody depends on it yet;
 * Web Push is live for every household today. So most of what follows is not
 * "does FCM work", it is "is Web Push still exactly what it was", because that
 * is the regression that would reach everyone at once through the one channel
 * with no staged rollout.
 *
 * Run: node tests/pushtransport.mjs
 */
import { isFcmDevice, selectEligible, shouldPrune, prunableNow, collapseKeyFor } from '../functions/_lib/pushDispatch.js';
import { fcmTokenIsDead } from '../functions/_lib/fcm.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/* ⛔ SPLIT ON /\r?\n/, NOT '\n'. Every source file this reads --
   dashboard.html, the Groovy, every .kt, everything under functions/ -- is
   CRLF. Splitting on '\n' leaves a trailing '\r' on every line, and since `.`
   does not match '\r' and `$` (no `m` flag) does not match before it, the
   comment regex NEVER FIRES. Five copies of this helper were broken that way,
   which made the project's stated defence against its own three historical
   text-presence false greens inoperative everywhere it was applied. */
const codeOnly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ')
  .split(/\r?\n/).map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');

let PASS = 0, FAIL = 0;
const check = (l, c, x = '') => { c ? PASS++ : FAIL++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${x ? `  ${x}` : ''}`); };

const web = (mode) => ({ name: 'Laptop', mode, subscription: { endpoint: 'https://push/x', keys: { p256dh: 'p', auth: 'a' } } });
const fcm = (mode) => ({ name: 'Phone', mode, kind: 'fcm', token: 'tok-1' });

console.log('=== 1. Telling the transports apart ===');
{
  check('an FCM record is recognised', isFcmDevice(fcm('always')) === true);
  check('a Web Push record is not', isFcmDevice(web('always')) === false);
  /* The discriminator must be the explicit kind, never "does it have a token"
     or "is subscription missing". A half-written record would otherwise be
     silently treated as the other transport and fail at send time. */
  check('a record with neither shape is not FCM', isFcmDevice({ name: 'x', mode: 'always' }) === false);
  check('undefined is not FCM', isFcmDevice(undefined) === false);
  check('a record carrying a token but no kind is NOT FCM',
    isFcmDevice({ mode: 'always', token: 'tok' }) === false,
    'kind is the contract; inferring from shape is how the two checks drift apart');
}

console.log('\n=== 2. The armed gate is transport-blind ===');
{
  /* A phone and a laptop set to the same mode must be treated identically.
     If they were not, "armed only" would mean two different things inside one
     household and nobody could reason about it. */
  for (const [label, make] of [['web', web], ['fcm', fcm]]) {
    const devices = { a: make('always'), b: make('armed') };

    const disarmed = selectEligible(devices, { category: 'door', armed: false }).map(([id]) => id);
    check(`${label}: disarmed, only "always" devices`, disarmed.join() === 'a', disarmed.join());

    const armedNow = selectEligible(devices, { category: 'door', armed: true }).map(([id]) => id);
    check(`${label}: armed, both`, armedNow.join() === 'a,b', armedNow.join());

    /* Smoke bypasses the gate by design: a fire does not become unimportant
       because nobody set the burglar alarm. */
    const smoke = selectEligible(devices, { category: 'smoke', armed: false }).map(([id]) => id);
    check(`${label}: smoke reaches both while disarmed`, smoke.join() === 'a,b', smoke.join());

    const reminder = selectEligible(devices, { category: 'reminder', armed: false }).map(([id]) => id);
    check(`${label}: reminders reach both while disarmed`, reminder.join() === 'a,b', reminder.join());
  }

  const mixed = { phone: fcm('armed'), laptop: web('armed') };
  check('a mixed household gates both the same way',
    selectEligible(mixed, { category: 'door', armed: true }).length === 2 &&
    selectEligible(mixed, { category: 'door', armed: false }).length === 0);
}

console.log('\n=== 3. A targeted test send ignores the gate, for either transport ===');
{
  const devices = { phone: fcm('armed'), laptop: web('armed') };
  const one = selectEligible(devices, { category: 'test', armed: false, targetDeviceId: 'phone' });
  check('only the named device', one.length === 1 && one[0][0] === 'phone');
  check('...even though the gate would have excluded it',
    selectEligible(devices, { category: 'test', armed: false }).length === 0,
    'the point is proving that device works now, not whether it was eligible');
  check('an unknown target matches nothing',
    selectEligible(devices, { category: 'test', armed: true, targetDeviceId: 'ghost' }).length === 0);
}

console.log('\n=== 4. Pruning only on a genuinely dead registration ===');
{
  /* THE ONE THAT MATTERS MOST. Pruning on a transient failure would quietly
     unregister devices during a push-service outage, and the household would
     not find out until the next thing they needed to be told about. */
  for (const status of [500, 502, 503, 429, 408]) {
    check(`web: ${status} does not prune`, shouldPrune(web('always'), status) === false);
    check(`fcm: ${status} does not prune`, shouldPrune(fcm('always'), status) === false);
  }
  check('web: 404 prunes', shouldPrune(web('always'), 404) === true);
  check('web: 410 prunes', shouldPrune(web('always'), 410) === true);
  /* FCM answers 404 UNREGISTERED for an uninstalled app and 400 for a
     malformed token. Both will never deliver again. */
  check('fcm: 404 prunes', shouldPrune(fcm('always'), 404) === true);
  /* ⛔ THIS ASSERTION USED TO SAY THE OPPOSITE, and it pinned a real bug.
     Google returns INVALID_ARGUMENT (400) for a bad token AND for a payload
     problem: message too big, invalid data key, bad TTL. Their guidance is to
     remove a registration on 400 only after confirming the payload was valid,
     which this code cannot do because it discards the response body.
     webhook.js builds a body from a device display name with no length cap, so
     one oversized event returns 400 for EVERY device in the household in the
     same dispatch and would have deleted all of them at once. */
  check('fcm: 400 does NOT prune', shouldPrune(fcm('always'), 400) === false,
    '400 can mean the payload was wrong, not the token');
  /* 410 is NOT an FCM response. Accepting it anyway would be inventing
     behaviour the transport does not have. */
  check('fcm: 404 only', fcmTokenIsDead(404) === true &&
    [400, 410, 200, 500, 429].every(s => fcmTokenIsDead(s) === false));
  /* A web subscription that got a 400 is a bad request we made, not a dead
     subscription, and deleting the device would lose a working registration. */
  check('web: 400 does NOT prune', shouldPrune(web('always'), 400) === false,
    'that is a request we got wrong, not a device that went away');
}

console.log('\n=== 5. A device that re-registered mid-dispatch is not deleted ===');
{
  /* The only place a LIVE device can be removed. Dispatch can take seconds per
     device, which is long enough for the user to re-register from another tab
     or for the app to come back with a rotated token. */
  const webDev = web('always');
  const fcmDev = fcm('always');

  check('the same registration is still prunable',
    prunableNow(webDev, 'https://push/x') === true &&
    prunableNow(fcmDev, 'tok-1') === true);

  check('a rotated FCM token survives',
    prunableNow({ ...fcmDev, token: 'tok-2' }, 'tok-1') === false,
    'the app came back with a new token while we were failing to reach the old one');

  check('a re-subscribed Web Push endpoint survives',
    prunableNow({ ...webDev, subscription: { endpoint: 'https://push/NEW', keys: {} } },
      'https://push/x') === false);

  /* Switching transport is a different registration entirely, and the value
     to compare lives in a different field. A shape mismatch must mean "leave
     it alone", never "compare undefined and hope". */
  check('a device that switched Web Push -> FCM survives',
    prunableNow(fcmDev, 'https://push/x') === false);
  check('a device that switched FCM -> Web Push survives',
    prunableNow(webDev, 'tok-1') === false);

  check('an already-deleted device is a no-op, not a crash',
    prunableNow(undefined, 'tok-1') === false);
  /* A concurrent DELETE used to be able to throw here, taking the whole
     request to 500 mid-dispatch. */
  check('a malformed record does not throw',
    prunableNow({ name: 'x', mode: 'always' }, 'tok-1') === false);
}

console.log('\n=== 6. What a notification replaces in the shade ===');
{
  /* Both transports collapsed too coarsely, in the same direction.
     FCM was sent `tag: category`, so the back door opening replaced the front
     door opening. Web Push was sent NO tag, so sw.js fell back to one constant
     for everything and a smoke alert replaced a door alert -- shipped that way
     to every household since v1.6.2. Found by reading the shade on a real
     phone during the FCM delivery measurements, not by any test. */
  check('two different sensors of one kind do not collapse',
    collapseKeyFor('contact', '12') !== collapseKeyFor('contact', '34'),
    'the back door silently replacing the front door was the bug');
  check('the same sensor flapping DOES collapse',
    collapseKeyFor('contact', '12') === collapseKeyFor('contact', '12'),
    'collapsing repeats is what a tag is for; losing distinct events is not');
  check('different kinds never share a key',
    collapseKeyFor('smoke', '12') !== collapseKeyFor('contact', '12'),
    'a smoke alert must never replace a door alert');
  check('no device still gives a usable key', collapseKeyFor('test') === 'test',
    'a manual test send has no sensor behind it');
  check('a missing category cannot produce an empty key',
    collapseKeyFor('') === 'hestia' && collapseKeyFor(undefined) === 'hestia',
    'an empty tag would make every notification collapse onto one slot again');
  check('a numeric device id is stringified, not concatenated oddly',
    collapseKeyFor('motion', 7) === 'motion:7');

  /* The key has to actually reach both transports, and the Web Push half is
     the one that reaches every household today. */
  const dispatch = codeOnly(fs.readFileSync(path.join(ROOT, 'functions/_lib/pushDispatch.js'), 'utf8'));
  check('one key is computed for the whole household, not per device',
    /const tag = collapseKeyFor\(category, deviceKey\);/.test(dispatch),
    'a phone and a laptop disagreeing about what replaces what would be worse than either bug');
  check('FCM is sent it', /sendFcmNotification\([^)]*tag\s*\}/.test(dispatch));
  check('Web Push is sent it too',
    /JSON\.stringify\(\{ title, body, tag \}\)/.test(dispatch),
    'this is the half that has been collapsing everything onto one slot since v1.6.2');

  const sw = codeOnly(fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8'));
  check('the service worker prefers the sent tag over its constant',
    /tag:\s*data\.tag \|\|/.test(sw),
    'it already did; the payload simply never carried one');

  const hook = codeOnly(fs.readFileSync(path.join(ROOT, 'functions/api/push/webhook.js'), 'utf8'));
  check('the webhook passes the sensor that actually fired',
    /deviceKey:\s*evt\.deviceId/.test(hook),
    'without this the key degrades back to the category and the bug returns');
}

console.log('\n=== 7. The registration write that happens on every app launch ===');
{
  /* The app re-registers each time it starts, and an Android process is killed
     and relaunched far more often than a tab reloads -- so this is the most
     frequent write in the system and almost always changes nothing. KV write
     volume is not hypothetical here: it returned HTTP 500 to every household
     at once, and the fix was to stop writing things that had not changed. */
  const { mutatePushDevices } = await import('../functions/_lib/pushDevices.js');

  const fakeKv = (initial = null, meta = null) => {
    const store = { value: initial, metadata: meta };
    const log = [];
    return {
      log,
      store,
      env: {
        HESTIA_KV: {
          get: async () => store.value,
          getWithMetadata: async () => ({ value: store.value, metadata: store.metadata }),
          put: async (k, v, opts) => {
            log.push({ v, opts });
            store.value = v;
            store.metadata = opts && opts.metadata;
          },
        },
      },
    };
  };

  const DEV = { Phone: { name: 'Phone', mode: 'always', kind: 'fcm', token: 'tok-1' } };
  const now = Date.now();

  /* A first registration has to be written -- there is nothing there yet. */
  const fresh = fakeKv(null);
  await mutatePushDevices(fresh.env, 'push:abc', (d) => { d.Phone = DEV.Phone; });
  check('a first registration writes', fresh.log.length === 1);
  check('...and records when it was written',
    fresh.store.metadata && typeof fresh.store.metadata.at === 'number',
    'the TTL clock is the only thing standing between a household and losing every device');

  /* The launch-after-launch case: byte-identical, recently written. */
  const same = fakeKv(JSON.stringify(DEV), { at: now - 60 * 1000 });
  const got = await mutatePushDevices(same.env, 'push:abc', (d) => { d.Phone = DEV.Phone; });
  check('re-registering the same device writes nothing', same.log.length === 0,
    'this is the most frequent write in the system and it changes nothing');
  check('...and still returns the devices', !!got.Phone && got.Phone.token === 'tok-1',
    'callers read the result; skipping the write must not skip the answer');

  /* A real change must still write. */
  const changed = fakeKv(JSON.stringify(DEV), { at: now - 60 * 1000 });
  await mutatePushDevices(changed.env, 'push:abc', (d) => { d.Phone.token = 'tok-2'; });
  check('a changed token writes', changed.log.length === 1);

  const removed = fakeKv(JSON.stringify(DEV), { at: now - 60 * 1000 });
  await mutatePushDevices(removed.env, 'push:abc', (d) => { delete d.Phone; });
  check('a removal writes', removed.log.length === 1);

  /* ⛔ THE GUARD THAT MAKES SKIPPING SAFE. The record expires, and a put is
     the only thing that refreshes that clock -- KV has no "touch". Skip
     unconditionally and a household whose registration never changes loses
     its entire device list when the TTL lapses, taking every notification
     with it. Turning a write optimisation into silent total push failure
     would be far worse than the writes it saved. */
  const stale = fakeKv(JSON.stringify(DEV), { at: now - 8 * 24 * 60 * 60 * 1000 });
  await mutatePushDevices(stale.env, 'push:abc', (d) => { d.Phone = DEV.Phone; });
  check('an unchanged but AGEING record is rewritten to refresh its TTL',
    stale.log.length === 1,
    'skipping forever would let it expire and silently lose every device');
  check('...and the refresh carries a fresh TTL',
    stale.log[0].opts && stale.log[0].opts.expirationTtl > 0);
  check('...and a fresh timestamp', stale.store.metadata.at >= now);

  /* A record with no metadata at all predates this change. It must be treated
     as ageing and rewritten, not skipped forever on a missing timestamp. */
  const legacy = fakeKv(JSON.stringify(DEV), null);
  await mutatePushDevices(legacy.env, 'push:abc', (d) => { d.Phone = DEV.Phone; });
  check('a record written before timestamps existed is rewritten once',
    legacy.log.length === 1,
    'absent metadata reads as age zero, which must not mean "recently written"');
}

console.log('\n=== 8. When a send fails, is there anything in the log to say why? ===');
{
  /* This runs the REAL dispatchPush against the REAL fcm.js. No mock of the
     sender, because a test built on a mock of the sender proves the mock
     works. The two failures below are the two shapes a misconfiguration
     actually takes in production, and until now both produced an identical
     `failed` count with no cause attached anywhere. */
  const { dispatchPush } = await import('../functions/_lib/pushDispatch.js');
  const { generateKeyPairSync } = await import('node:crypto');

  const PHONE = { Phone: { name: 'Phone', mode: 'always', kind: 'fcm', token: 'tok-1' } };
  const kvWith = (devices) => ({
    HESTIA_KV: {
      get: async (k) => (k === 'push:abc' ? JSON.stringify(devices) : null),
      getWithMetadata: async (k) => ({ value: k === 'push:abc' ? JSON.stringify(devices) : null, metadata: null }),
      put: async () => {},
    },
  });

  const capture = async (fn) => {
    const errs = [], warns = [];
    const oe = console.error, ow = console.warn;
    console.error = (...a) => errs.push(a.join(' '));
    console.warn = (...a) => warns.push(a.join(' '));
    try { return { out: await fn(), errs, warns }; }
    finally { console.error = oe; console.warn = ow; }
  };

  /* FAILURE ONE: FCM_SERVICE_ACCOUNT is not set. fcm.js throws loudly and
     DELIBERATELY for exactly this, so the cause would not be lost -- and that
     throw was then swallowed one layer up, which made "push does not work in
     the app" indistinguishable from a transport outage. */
  const missing = await capture(() => dispatchPush(
    { ...kvWith(PHONE) },
    'abc',
    { category: 'smoke', title: 'Smoke / CO Alert', body: 'Kitchen', armed: false }
  ));
  check('a throwing send is counted as failed, not as sent',
    missing.out.sent === 0 && missing.out.failed === 1, JSON.stringify(missing.out));
  check('...and the reason reaches the log',
    missing.errs.some(l => /FCM_SERVICE_ACCOUNT/.test(l)),
    'without this the Workers log holds nothing at all and the cause is gone');
  check('...on console.error, because a send that threw is never routine',
    missing.errs.length === 1 && missing.warns.length === 0);
  check('a dead registration was NOT inferred from a thrown send',
    missing.out.pruned === 0,
    'a missing service account must never cost a household its devices');

  /* FAILURE TWO: the credentials parse but the service rejects them. This is
     a real response, not a throw, so it lands in the other branch -- and a
     401 from FCM says the service account is refused, which is nothing to do
     with this device being gone. */
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const env401 = {
    ...kvWith(PHONE),
    FCM_SERVICE_ACCOUNT: JSON.stringify({
      client_email: 'hestia@example.iam.gserviceaccount.com',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      project_id: 'hestia-test',
    }),
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => (String(url).includes('oauth2')
    ? { ok: true, status: 200, json: async () => ({ access_token: 'ya29.fake', expires_in: 3600 }) }
    : { ok: false, status: 401, text: async () => '{}' });
  const refused = await capture(() => dispatchPush(env401, 'abc',
    { category: 'smoke', title: 'Smoke / CO Alert', body: 'Kitchen', armed: false }));
  globalThis.fetch = realFetch;

  check('a refused send is counted as failed',
    refused.out.sent === 0 && refused.out.failed === 1, JSON.stringify(refused.out));
  check('...and the status reaches the log',
    refused.warns.some(l => /401/.test(l)),
    'a 401 is the shape of a rejected service account, not of a dead device');
  check('...named by transport, so the right half of the system gets looked at',
    refused.warns.some(l => /fcm/.test(l)));
  check('...and the device id is there to identify it',
    refused.warns.some(l => /Phone/.test(l)));
  /* ⛔ The registration token must NOT be in the log. It is a credential for
     sending to that device, and a Workers log is not where it belongs. */
  check('the registration token is NOT logged',
    !refused.warns.concat(refused.errs).some(l => /tok-1/.test(l)),
    'the device id identifies it; the token is a credential');
  check('a 401 did not prune the device',
    refused.out.pruned === 0,
    'pruning on a rejected service account would silently empty the household');
}

console.log('\n=== 9. A bad VAPID key must not take FCM down with it ===');
{
  /* ⛔ THE COMMENT IN THE SOURCE USED TO CLAIM THE OPPOSITE OF THE CODE.
     It said a missing VAPID_PRIVATE_KEY "cannot take down a send that was never
     going to use it" -- true only for an FCM-ONLY household. The derivation
     sat before the dispatch loop and fired whenever ANY eligible device was Web
     Push, unwrapped. So for a MIXED household -- a phone running the app plus
     the same person's laptop, the exact case the old comment named as
     motivating -- it threw before a single FCM send, and the handler returned
     500 to the whole household. One bad secret, every mixed household's smoke
     alert becomes an HTTP 500. Same shared-fate shape as the 2026-10-04 KV
     incident. */
  const { dispatchPush } = await import('../functions/_lib/pushDispatch.js');
  const { generateKeyPairSync } = await import('node:crypto');

  const MIXED = {
    Phone:  { name: 'Phone',  mode: 'always', kind: 'fcm', token: 'tok-1' },
    Laptop: { name: 'Laptop', mode: 'always', subscription: { endpoint: 'https://push/x', keys: { p256dh: 'p', auth: 'a' } } },
  };

  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const env = {
    HESTIA_KV: {
      get: async (k) => (k === 'push:abc' ? JSON.stringify(MIXED) : null),
      getWithMetadata: async (k) => ({ value: k === 'push:abc' ? JSON.stringify(MIXED) : null, metadata: null }),
      put: async () => {},
    },
    FCM_SERVICE_ACCOUNT: JSON.stringify({
      client_email: 'hestia@example.iam.gserviceaccount.com',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      project_id: 'hestia-test',
    }),
    VAPID_PRIVATE_KEY: 'this-is-not-a-valid-vapid-key',   // the whole point
  };

  const fcmHits = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('oauth2')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'ya29.fake', expires_in: 3600 }) };
    }
    if (u.includes('fcm.googleapis.com')) { fcmHits.push(u); return { ok: true, status: 200, text: async () => '{}' }; }
    return { ok: true, status: 200, text: async () => '{}' };
  };

  const errs = [];
  const oe = console.error, ow = console.warn;
  console.error = (...a) => errs.push(a.join(' '));
  console.warn = (...a) => errs.push(a.join(' '));
  let out, threw = null;
  try { out = await dispatchPush(env, 'abc', { category: 'smoke', title: 'Smoke / CO Alert', body: 'Hall', armed: false }); }
  catch (e) { threw = e; }
  finally { console.error = oe; console.warn = ow; globalThis.fetch = realFetch; }

  check('dispatch does NOT throw out to the handler', threw === null,
    threw ? String(threw && threw.message) : 'a throw here is the 500 every household saw');
  check('the FCM device was still sent to', fcmHits.length === 1, `${fcmHits.length} FCM call(s)`);
  check('...and is counted as sent', !!out && out.sent === 1, JSON.stringify(out));
  check('the Web Push device is counted as failed, not silently dropped',
    !!out && out.failed === 1, JSON.stringify(out));
  check('...and the unusable key is named in the log',
    errs.some(l => /VAPID/i.test(l)),
    'otherwise a rotated VAPID secret is indistinguishable from a transport outage');
  /* ⛔ THE PER-DEVICE FAILURE REASON MUST NAME THE CAUSE, and this is the only
     thing the explicit reject buys. Verified directly: the vendored
     sendPushNotification(null, ...) ALSO throws, so passing a null keyPair
     straight through fails the same device, counts the same failure and prunes
     nobody -- identical security outcome. What differs is the Workers log,
     which reads "Cannot read properties of null (reading 'privateKey')" rather
     than naming VAPID. On this backend an unexplained failure is the shape that
     costs days, so the guard is here for diagnosability and this assertion
     tests exactly that rather than pretending to a safety property. */
  check('...and the per-device failure reason names VAPID, not a null deref',
    errs.some(l => /send threw:.*VAPID/i.test(l)),
    errs.filter(l => /send threw/.test(l)).join(' | ') || '(no send-threw line)');
  check('a dead VAPID key does not prune anybody',
    !!out && out.pruned === 0,
    'pruning on a key problem would quietly unregister every browser in the household');
}

console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL ? 1 : 0);

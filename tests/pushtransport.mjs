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
const codeOnly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ')
  .split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');

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

console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL ? 1 : 0);

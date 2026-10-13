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
import { isFcmDevice, selectEligible, shouldPrune } from '../functions/_lib/pushDispatch.js';
import { fcmTokenIsDead } from '../functions/_lib/fcm.js';

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
  check('fcm: 400 prunes', shouldPrune(fcm('always'), 400) === true);
  /* 410 is NOT an FCM response. Accepting it anyway would be inventing
     behaviour the transport does not have. */
  check('fcm: 400 and 404 only', fcmTokenIsDead(410) === false && fcmTokenIsDead(200) === false);
  /* A web subscription that got a 400 is a bad request we made, not a dead
     subscription, and deleting the device would lose a working registration. */
  check('web: 400 does NOT prune', shouldPrune(web('always'), 400) === false,
    'that is a request we got wrong, not a device that went away');
}

console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL ? 1 : 0);

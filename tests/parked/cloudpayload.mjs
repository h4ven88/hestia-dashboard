/* Phase 1: nothing secret leaves the house, and the endpoints that were
 * unauthenticated now require proof of the Maker token.
 *
 * Extracts the REAL shipped functions rather than reimplementing them.
 * Run: node cloudpayload.mjs
 */
import fs from 'fs';
import { verifyHousehold, householdIsLegacy, sha256Hex } from
  'file:///C:/Users/rbodd/hestia-dashboard/functions/_lib/householdAuth.js';

const SRC = fs.readFileSync('C:/Users/rbodd/hestia-dashboard/dashboard.html', 'utf8');
function fn(name) {
  const m = new RegExp('(async )?function ' + name + '\\s*\\(').exec(SRC);
  if (!m) throw new Error('missing ' + name);
  let d = 0;
  for (let j = SRC.indexOf('{', m.index); j < SRC.length; j++) {
    if (SRC[j] === '{') d++;
    else if (SRC[j] === '}' && --d === 0) return SRC.slice(m.index, j + 1);
  }
}
const buildCloudPayload = new Function('crypto', `
  ${fn('_cloudProjectSensors')}
  ${fn('_cloudTokenHash')}
  ${fn('buildCloudPayload')}
  return buildCloudPayload;
`)(globalThis.crypto);

let PASS = 0, FAIL = 0;
const check = (l, c, x = '') => { c ? PASS++ : FAIL++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${x ? `  ${x}` : ''}`); };

/* A config with every secret this app has ever synced, all set to findable
   sentinels. */
const SECRETS = {
  token:            'MAKER-TOKEN-aaaaaaaa',
  athenaApiKey:     'sk-ant-SECRET-bbbbbbbb',
  athenaGoogleApiKey:'AIza-SECRET-cccccccc',
  settingsPin:      'PINHASH-dddddddd',
  artemisPin:       'PINHASH-eeeeeeee',
  pinInstallSalt:   'SALT-ffffffff',
  hestiaAppToken:   'HESTIA-TOKEN-gggggggg',
  hub:              'https://192.168.50.139:8443',
  hestiaAppId:      '1234',
};
const FULL = {
  config: {
    ...SECRETS,
    appId: '219', poll: 1000, defaultRoom: 'Kitchen',
    cameras: [{ name: 'Front Door', room: 'Porch', snapshotUrl: 'http://cam/CAMSECRET.jpg',
                streamUrl: 'rtsp://user:CAMPASS@cam/live' }],
    locks: [{ id: 13, label: 'Front Door Lock', room: 'Entry' }],
    artemisSensors: {
      contacts: [{ id: 21, subtype: 'door', name: 'Garage Entrance', room: 'Garage', extra: 'x' }],
      motions:  [{ id: 22, name: 'Hall Motion' }],
      smokes:   [{ id: 23, name: 'Smoke' }],
      waters:   [{ id: 24, name: 'Leak' }],
    },
    pushEnabled: true, pushDoors: true, pushWindows: false, pushLocks: true,
    pushMotion: false, pushMotionDevices: [22], pushSmoke: true, pushWater: true,
    pushOpen: true, pushClose: false,
    pushAlarming: true, pushArmStatus: true,
    pushDevices: [{ id: 'dev-1', name: "Ray's iPhone", mode: 'armed' }],
    reminders: [{ id: 1, text: 'Take medication at 8pm' }],
    routines:  [{ id: 1, name: 'Goodnight' }],
    announceDevices: [99], weather: { city: 'Kingsport, TN' },
  },
  thermostats: [{ id: 5, name: 'Hallway' }],
  rooms: [{ name: 'Master Bedroom', switches: [1, 2] }],
  staging: [{ id: 77, name: 'Unassigned Device' }],
  savedAt: 1758000000000,
};

const cloud = await buildCloudPayload(FULL);
const json = JSON.stringify(cloud);

console.log('=== 1. Nothing secret reaches the cloud ===');
for (const [field, value] of Object.entries(SECRETS)) {
  check(`${field} absent from the cloud payload`, !json.includes(value), `(${value})`);
}
check('camera snapshot URL absent', !json.includes('CAMSECRET'));
check('camera stream credentials absent', !json.includes('CAMPASS'));
check('reminder text absent', !json.includes('Take medication'));
check('routine names absent', !json.includes('Goodnight'));
check('room names absent', !json.includes('Master Bedroom'));
check('thermostat inventory absent', !json.includes('Hallway'));
check('staging inventory absent', !json.includes('Unassigned Device'));
check('push device names absent', !json.includes("Ray's iPhone"));
check('weather location absent', !json.includes('Kingsport'));

console.log('\n=== 2. Allow-list, so future fields are private by default ===');
{
  // A field nobody has added yet must not appear just because it exists.
  const withNewField = JSON.parse(JSON.stringify(FULL));
  withNewField.config.someFutureSecret = 'FUTURE-SECRET-hhhhhhhh';
  const j2 = JSON.stringify(await buildCloudPayload(withNewField));
  check('a newly added config field does not leak', !j2.includes('FUTURE-SECRET'));
  const keys = Object.keys(cloud.config).sort();
  check('cloud payload carries exactly the expected keys', JSON.stringify(keys) === JSON.stringify([
    'artemisSensors','householdId','locks','pushClose','pushDoors','pushEnabled','pushLocks',
    'pushMotion','pushMotionDevices','pushOpen','pushSmoke','pushWater','pushWindows','tokenHash',
  ]), keys.join(','));
}

console.log('\n=== 3. The Workers still get everything they read ===');
{
  const c = cloud.config;
  check('tokenHash present and is a sha256', /^[0-9a-f]{64}$/.test(c.tokenHash), c.tokenHash.slice(0, 16) + '…');
  check('tokenHash actually hashes the real token',
    c.tokenHash === await sha256Hex(SECRETS.token));
  check('contact sensor id survives (categorize)', c.artemisSensors.contacts[0].id === 21);
  check('contact subtype survives (door vs window)', c.artemisSensors.contacts[0].subtype === 'door');
  check('sensor name survives (notification body)', c.artemisSensors.contacts[0].name === 'Garage Entrance');
  check('sensor room does NOT survive (not read by any Worker)',
    c.artemisSensors.contacts[0].room === undefined);
  check('motions/smokes/waters all projected',
    c.artemisSensors.motions[0].id === 22 && c.artemisSensors.smokes[0].id === 23 && c.artemisSensors.waters[0].id === 24);
  check('lock id survives', c.locks[0].id === 13);
  check('lock LABEL survives (webhook.js reads .label, not .name)', c.locks[0].label === 'Front Door Lock');
  check('lock room does not survive', c.locks[0].room === undefined);
  const flags = ['pushEnabled','pushDoors','pushWindows','pushLocks','pushMotion','pushMotionDevices','pushSmoke','pushWater','pushOpen','pushClose'];
  check('all ten push flags the webhook reads are present',
    flags.every(f => c[f] !== undefined), flags.filter(f => c[f] === undefined).join(',') || 'all present');
  check('false flags survive as false, not dropped', c.pushWindows === false && c.pushClose === false);
}

console.log('\n=== 4. Authentication ===');
const HASH = await sha256Hex(SECRETS.token);
const modern = { config: { tokenHash: HASH } };
const legacy = { config: { token: SECRETS.token } };

check('correct raw token authenticates',
  await verifyHousehold(modern, { token: SECRETS.token }) === true);
check('wrong token rejected',
  await verifyHousehold(modern, { token: 'WRONG-TOKEN-00000000' }) === false);
check('no credentials rejected',
  await verifyHousehold(modern, {}) === false);
check('null household rejected',
  await verifyHousehold(null, { token: SECRETS.token }) === false);
check('empty stored hash rejected',
  await verifyHousehold({ config: { tokenHash: '' } }, { token: '' }) === false);
check('a client-supplied hash is NOT accepted as a credential',
  await verifyHousehold(modern, { tokenHash: HASH }) === false,
  'verifier and credential must differ');

console.log('\n--- transition: entries written before this change');
check('legacy entry + correct raw token still authenticates (Groovy keeps working)',
  await verifyHousehold(legacy, { token: SECRETS.token }) === true);
check('legacy entry + wrong token rejected',
  await verifyHousehold(legacy, { token: 'WRONG-TOKEN-00000000' }) === false);
check('legacy entry is flagged as legacy', householdIsLegacy(legacy) === true);
check('modern entry is not flagged legacy', householdIsLegacy(modern) === false);
check('empty entry is not flagged legacy', householdIsLegacy({ config: {} }) === false);

console.log('\n--- the neighbour');
{
  // A neighbour can still READ the entry. Prove that what they read does not
  // let them authenticate.
  // The neighbour CAN still read the entry. Prove that everything they find
  // in it is useless for authenticating as this household.
  const seen = JSON.parse(JSON.stringify(cloud));
  const stored = { config: { tokenHash: seen.config.tokenHash } };
  check('replaying the stored hash as a token fails',
    await verifyHousehold(stored, { token: seen.config.tokenHash }) === false);
  check('replaying the stored hash as a hash fails',
    await verifyHousehold(stored, { tokenHash: seen.config.tokenHash }) === false);
  check('every field the neighbour can read fails as a credential',
    (await Promise.all(Object.values(seen.config).map(v =>
      verifyHousehold(stored, { token: typeof v === 'string' ? v : JSON.stringify(v) }))))
      .every(r => r === false));
  check('only the real token, which is not in the entry, works',
    await verifyHousehold(stored, { token: SECRETS.token }) === true);
}

console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL ? 1 : 0);

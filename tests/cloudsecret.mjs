/* The household secret's lifecycle and what actually goes on the wire.
 *
 * This suite exists because the previous ones did not constrain this code at
 * all. A reviewer mutated the shipped source two ways -- deleted the line that
 * strips the secret out of the record it encrypts, and replaced
 * crypto.getRandomValues with a constant so every household shared one key --
 * and the full suite stayed green both times. `cloudharness.mjs` stubs out the
 * crypto and asserts only *whether* a PUT happens, never what is in it.
 *
 * So everything here runs the REAL brace-extracted functions with real
 * WebCrypto, and asserts the bytes. Both of those mutants must fail this file.
 *
 * Run: node tests/cloudsecret.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf8');

function fn(name) {
  const m = new RegExp('(async )?function ' + name + '\\s*\\(').exec(SRC);
  if (!m) throw new Error('missing ' + name + ' in dashboard.html');
  let d = 0;
  for (let j = SRC.indexOf('{', m.index); j < SRC.length; j++) {
    if (SRC[j] === '{') d++;
    else if (SRC[j] === '}' && --d === 0) return SRC.slice(m.index, j + 1);
  }
}

let PASS = 0, FAIL = 0;
const check = (l, c, x = '') => { c ? PASS++ : FAIL++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${x ? `  ${x}` : ''}`); };

/* ── a world that runs the real cloudSyncPush end to end ────────────── */
function world({ cloudSecret = 'a'.repeat(64), hubOk = true } = {}) {
  const sent = [];
  const logs = [];
  const api = new Function('crypto', 'btoa', 'atob', 'TextEncoder', 'TextDecoder', '__sent', '__log', `
    let _cloudLastPushError = null, _lastCloudPushAt = 0, _cloudSyncDebounce = null;
    let _cloudPendingConfig = null;
    const HESTIA_VERSION = '1.6.9';
    const CLOUD_SYNC_API = '/api/config';
    const SANDBOX = false;
    const CONFIG = { cloudSecret: ${JSON.stringify(cloudSecret)} };
    // Mirrors dashboard.html's module-level constant, which _cloudKey() reads.
    const _CLOUD_INFO_ENC = 'hestia-enc';
    // Must join ALL args: the real code logs "Push failed:" and the reason as
    // two arguments, so a single-arg stub silently swallows every reason.
    const console = { log: (...a) => __log(a.join(' ')), warn: (...a) => __log(a.join(' ')) };
    function clearTimeout(){} function setTimeout(){}
    function sbxBlocked(){ return false; }
    const deepClone = (o) => JSON.parse(JSON.stringify(o));
    function _cloudGetIp(){ return Promise.resolve('203.0.113.5'); }
    function fetch(url, init){ __sent(JSON.parse(init.body)); return Promise.resolve({ ok: ${hubOk}, status: ${hubOk ? 200 : 401} }); }
    ${fn('_cloudKey')}
    ${fn('_cloudEncryptWithKey')}
    ${fn('_cloudDecryptWithKey')}
    ${fn('_cloudTokenHash')}
    ${fn('buildServiceHalf')}
    ${fn('cloudSyncPush')}
    return { push: (p) => cloudSyncPush(p), key: (s,u) => _cloudKey(s,u),
             dec: (b,k) => _cloudDecryptWithKey(b,k), err: () => _cloudLastPushError };
  `)(globalThis.crypto, globalThis.btoa, globalThis.atob, TextEncoder, TextDecoder,
     (b) => sent.push(b), (m) => logs.push(m));
  return { api, sent, logs };
}

const PAYLOAD = () => ({
  config: {
    hub: 'https://192.168.50.139:8443', appId: '219', token: 'maker-token-uuid',
    cloudSecret: 'a'.repeat(64),
    settingsPin: 'PINHASH', artemisPin: 'PINHASH2', pinInstallSalt: 'SALT',
    athenaApiKey: 'sk-ant-SECRET', athenaGoogleApiKey: 'AIza-SECRET',
    cameras: [{ snapshotUrl: 'http://cam/CAMSECRET.jpg' }],
    artemisSensors: { contacts: [{ id: 21, subtype: 'door', name: 'Front Door' }],
                      motions: [], smokes: [], waters: [], glass: [{ id: 61, name: 'Glass' }] },
    locks: [{ id: 13, label: 'Front Door Lock' }],
    pushEnabled: true, pushDoors: true, pushWindows: false, pushLocks: true,
    pushMotion: false, pushMotionDevices: [], pushSmoke: true, pushWater: true,
    pushOpen: true, pushClose: false,
  },
  rooms: [{ name: 'Master Bedroom' }], thermostats: [], staging: [], savedAt: 111,
});

console.log('=== 1. What actually goes on the wire ===');
{
  const w = world();
  await w.api.push(PAYLOAD());
  await new Promise(r => setTimeout(r, 50));
  check('exactly one PUT was sent', w.sent.length === 1,
    w.sent.length === 1 ? '' : `${w.sent.length} — logs: ${w.logs.join(' | ') || '(none)'}`);
  if (w.sent.length !== 1) { console.log(`\n${PASS} passed, ${FAIL} failed`); process.exit(1); }
  const body = w.sent[0];
  const wire = JSON.stringify(body);

  // THE MUTANT TEST: deleting the strip in cloudSyncPush must fail here.
  check('the household secret is NOT anywhere in the request', !wire.includes('a'.repeat(64)),
    'the key is derived from it — shipping it inside is circular');

  check('the raw token IS present (write proof, discarded server-side)', body.token === 'maker-token-uuid');
  check('the service half is present', !!body.service);
  check('the ciphertext is present', body.encrypted === true && !!body.payload);

  for (const [label, needle] of [
    ['PIN hash', 'PINHASH'], ['PIN salt', 'SALT'],
    ['Anthropic key', 'sk-ant-SECRET'], ['Google key', 'AIza-SECRET'],
    ['camera URL', 'CAMSECRET'], ['room name', 'Master Bedroom'],
    ['hub URL', '192.168.50.139'],
  ]) check(`${label} absent from the service half`, !JSON.stringify(body.service).includes(needle));
}

console.log('\n=== 2. The ciphertext really is keyed on the secret ===');
{
  const w = world();
  await w.api.push(PAYLOAD());
  await new Promise(r => setTimeout(r, 50));
  const blob = w.sent[0].payload;

  const right = await w.api.key('a'.repeat(64), ['decrypt']);
  const got = await w.api.dec(blob, right);
  check('decrypts with the household secret', !!got && !!got.config);
  check('and the private half really contains the token',
    got.config.config.token === 'maker-token-uuid');
  check('the secret was stripped from the encrypted half too',
    got.config.config.cloudSecret === undefined);

  const wrong = await w.api.key('b'.repeat(64), ['decrypt']);
  let threw = false;
  try { await w.api.dec(blob, wrong); } catch (e) { threw = true; }
  check('does NOT decrypt with a different secret', threw,
    'a shared/constant secret would make this pass wrongly');

  // THE SECOND MUTANT: a constant secret means two households collide.
  const legacySeed = await w.api.key('203.0.113.5', ['decrypt']);
  let legacyThrew = false;
  try { await w.api.dec(blob, legacySeed); } catch (e) { legacyThrew = true; }
  check('does NOT decrypt from the public IP', legacyThrew, 'that was the original bug');
}

console.log('\n=== 3. No secret means no write, loudly ===');
{
  const w = world({ cloudSecret: null });
  await w.api.push(PAYLOAD());
  await new Promise(r => setTimeout(r, 50));
  check('nothing is sent without a secret', w.sent.length === 0);
  check('and it says why', /no household secret/i.test(w.api.err() || ''), w.api.err() || '(silent)');
}

console.log('\n=== 4. A rejected write is surfaced, never silent ===');
{
  const w = world({ hubOk: false });
  await w.api.push(PAYLOAD());
  await new Promise(r => setTimeout(r, 50));
  check('the PUT was attempted', w.sent.length === 1);
  check('the rejection is recorded for Diagnostics', /HTTP 401/.test(w.api.err() || ''),
    w.api.err() || '(silent — this was the bug)');
  check('and logged', w.logs.some(l => /rejected/i.test(l)));
}

console.log('\n=== 5. Minting is gated on the hub accepting the write ===');
{
  // Real saveConfigToHub, with hubStoreFetch stubbed to fail.
  const mk = (ok) => new Function('crypto', '__calls', `
    const CONFIG = {};
    const SANDBOX = false;
    const HUB_STORE = { appId: '1', token: 't' };
    const console = { log(){}, warn(){} };
    function sbxBlocked(){ return false; }
    function hubStoreFetch(){ __calls('write'); return Promise.resolve({ ok: ${ok} }); }
    ${fn('saveConfigToHub')}
    return { save: (p) => saveConfigToHub(p), cfg: () => CONFIG };
  `)(globalThis.crypto, () => {});

  const good = mk(true);
  const p1 = { config: { token: 'x' } };
  const ok1 = await good.save(p1);
  check('a successful hub write mints and keeps the secret',
    ok1 === true && /^[0-9a-f]{64}$/.test(good.cfg().cloudSecret || ''));
  check('and the payload carries it to the hub', p1.config.cloudSecret === good.cfg().cloudSecret);

  const bad = mk(false);
  const p2 = { config: { token: 'x' } };
  const ok2 = await bad.save(p2);
  check('a FAILED hub write mints nothing', ok2 === false && !bad.cfg().cloudSecret,
    'otherwise this device holds a secret no one else has');
  check('and the failed payload is not left carrying one', p2.config.cloudSecret === undefined);

  // Two devices, both failing to reach the hub, must not diverge.
  const a = mk(false), b = mk(false);
  await a.save({ config: { token: 'x' } });
  await b.save({ config: { token: 'x' } });
  check('two hub-less devices produce zero secrets, not two',
    !a.cfg().cloudSecret && !b.cfg().cloudSecret);

  /* Two separate households must never land on the same secret. Without this
     a constant in place of crypto.getRandomValues passes every other
     assertion in this file -- each household's record still decrypts with
     "its" secret, because every household has the same one. That mutant
     survived the entire suite before this check existed. */
  const secrets = new Set();
  for (let i = 0; i < 8; i++) {
    const h = mk(true);
    await h.save({ config: { token: 'x' } });
    secrets.add(h.cfg().cloudSecret);
  }
  check('eight independent households produce eight distinct secrets',
    secrets.size === 8, `${secrets.size} distinct`);
  check('and each is full-length random hex, not a constant',
    [...secrets].every(s => /^[0-9a-f]{64}$/.test(s)));
}

console.log('\n=== 6. Applying a cloud config must not delete the secret ===');
{
  const api = new Function('__store', `
    const CONFIG = { cloudSecret: ${JSON.stringify('c'.repeat(64))} };
    const _LS = { setItem: (k, v) => __store(k, v) };
    const console = { warn(){} };
    ${fn('_cloudHasSecret')}
    ${fn('_persistConfigKeepingSecret')}
    return { persist: (c) => _persistConfigKeepingSecret(c) };
  `)((k, v) => { store[k] = v; });
  const store = {};
  // cloudSyncPush strips the secret, so a discovered config never carries one.
  api.persist({ config: { hub: 'x', token: 'y' }, savedAt: 1 });
  const written = JSON.parse(store['dashboard-config']);
  check('the secret is re-injected before persisting',
    written.config.cloudSecret === 'c'.repeat(64),
    'without this the next reload mints a second one');
  check('the rest of the config is untouched', written.config.hub === 'x' && written.savedAt === 1);
}

console.log('\n=== 7. A minting save must land the secret in localStorage ===');
{
  /* saveConfigToHub() mints AFTER saveConfig() has already written
     localStorage, so without an explicit re-persist the very save that creates
     the secret drops it and the next boot mints a second one. An earlier guard
     for this compared two values that are always equal by the time it runs, so
     it was dead code with a comment claiming otherwise. */
  const store = {};
  const api = new Function('crypto', '__store', `
    const CONFIG = {};
    const SANDBOX = false;
    const HUB_STORE = { appId: '1', token: 't' };
    const _LS = { setItem: (k, v) => __store(k, v), getItem: () => null };
    const console = { log(){}, warn(){} };
    let _cfgAppliedSavedAt = 0;
    function sbxBlocked(){ return false; }
    function hubStoreFetch(){ return Promise.resolve({ ok: true }); }
    function isLocalHubUrl(){ return false; }
    function discoverHubStore(){ return Promise.resolve(); }
    function cloudSyncPush(){}
    function buildConfigPayload(){ return { config: { token: 'maker', appId: '219', cloudSecret: CONFIG.cloudSecret }, savedAt: 1 }; }
    ${fn('_cloudHasSecret')}
    ${fn('saveConfigToHub')}
    ${fn('saveConfig')}
    return { save: () => saveConfig(), cfg: () => CONFIG };
  `)(globalThis.crypto, (k, v) => { store[k] = v; });

  await api.save();
  const inMemory = api.cfg().cloudSecret;
  check('the save minted a secret', /^[0-9a-f]{64}$/.test(inMemory || ''), inMemory || '(none)');
  const persisted = store['dashboard-config'] ? JSON.parse(store['dashboard-config']).config.cloudSecret : null;
  check('and it reached localStorage on that same save', persisted === inMemory,
    persisted ? 'ok' : 'MISSING — the next boot would mint a second one');
}

console.log('\n=== 8. A device holding a secret must not read legacy records ===');
{
  /* The legacy key is SHA-256(publicIP + a constant in this repo), so anyone
     sharing the address can forge a record that decrypts cleanly. A device that
     already holds a household secret must never fall back to it -- the forged
     config would be handed to applyParsedConfig() and blind-assigned over
     CONFIG, PIN hashes included. */
  const IP = '203.0.113.5';
  async function legacyBlob(obj) {
    const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(IP + ':hestia-cloud-sync'));
    const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key,
      new TextEncoder().encode(JSON.stringify(obj))));
    return { iv: btoa(String.fromCharCode(...iv)), data: btoa(String.fromCharCode(...ct)) };
  }
  const forged = await legacyBlob({ config: { config: { artemisPin: 'ATTACKER-PIN', hub: 'http://evil' } } });

  const mk = (secret) => {
    const logs = [];
    const api = new Function('crypto', 'btoa', 'atob', 'TextEncoder', 'TextDecoder', '__log', `
      const CONFIG = { cloudSecret: ${JSON.stringify(secret)} };
      const _CLOUD_INFO_ENC = 'hestia-enc';
      const CLOUD_SYNC_API = '/api/config';
      const console = { log: (...a) => __log(a.join(' ')), warn: (...a) => __log(a.join(' ')) };
      function _cloudGetIp(){ return Promise.resolve(${JSON.stringify(IP)}); }
      function fetch(){ return Promise.resolve({ ok: true, json: () => Promise.resolve(
        { found: true, encrypted: true, payload: ${JSON.stringify(forged)} }) }); }
      ${fn('_cloudKey')}
      ${fn('_cloudDecryptWithKey')}
      ${fn('_cloudDeriveKey')}
      ${fn('_cloudDecrypt')}
      ${fn('cloudSyncDiscover')}
      return { discover: () => cloudSyncDiscover() };
    `)(globalThis.crypto, globalThis.btoa, globalThis.atob, TextEncoder, TextDecoder, m => logs.push(m));
    return { api, logs };
  };

  const withSecret = mk('a'.repeat(64));
  const got = await withSecret.api.discover();
  check('a device WITH a secret refuses the forged legacy record', got === null,
    got ? `adopted ${JSON.stringify(got).slice(0, 60)}` : 'refused');
  check('and says why', withSecret.logs.some(l => /cannot read it/i.test(l)),
    withSecret.logs.join(' | ') || '(silent)');

  const noSecret = mk(null);
  const migrated = await noSecret.api.discover();
  check('a device with NO secret may still migrate its own legacy record',
    migrated !== null && !!migrated.config,
    'this path is what carries pre-split households forward');
}

/* Sections 9-12 exist because a mutation sweep found the suite did not
   constrain any of this. Eleven deliberate breaks survived a green run,
   including "accept a malformed secret from a URL", "let a link overwrite the
   secret this device already holds" and "mint with no credentials at all". */

console.log('\n=== 9. The household secret arriving by URL ===');
{
  /* Runs the REAL boot block, sliced out of dashboard.html, rather than a
     paraphrase of it -- this is inline boot code, not a function, and the
     three guards in it are the entire defence for a link-borne secret. */
  const start = SRC.indexOf('const _urlParams = new URLSearchParams');
  const anchor = "console.log('[Boot] Household secret adopted from Wall Panel link');";
  const at = SRC.indexOf(anchor, start);
  if (start < 0 || at < 0) throw new Error('boot URL-intake block not found in dashboard.html');
  const BLOCK = SRC.slice(start, SRC.indexOf('}', at) + 1);

  const run = (search, existing) => {
    const replaced = [];
    const api = new Function('URLSearchParams', '__replaced', `
      const CONFIG = { cloudSecret: ${JSON.stringify(existing)} };
      const window = { location: { search: ${JSON.stringify(search)} } };
      const location = { pathname: '/', search: ${JSON.stringify(search)} };
      const history = { replaceState: (a, b, url) => __replaced(url) };
      const console = { log(){}, warn(){} };
      ${BLOCK}
      return { secret: CONFIG.cloudSecret };
    `)(URLSearchParams, u => replaced.push(u));
    return { ...api, replaced };
  };

  const GOOD = 'b'.repeat(64);
  const adopted = run('?hs=' + GOOD, null);
  check('a well-formed secret in the link is adopted', adopted.secret === GOOD);
  check('...and is scrubbed from the address bar', adopted.replaced.length === 1,
    'a link carrying only hs would otherwise leave it in history permanently');

  for (const bad of ['xyz', 'B'.repeat(64), 'b'.repeat(63), 'b'.repeat(65), 'b'.repeat(62) + 'zz']) {
    const r = run('?hs=' + bad, null);
    check(`a malformed secret (${bad.slice(0, 6)}…, len ${bad.length}) is refused`,
      !r.secret,
      'a garbage secret is truthy, so it suppresses the legacy path AND fails every decrypt');
  }

  const held = run('?hs=' + 'c'.repeat(64), 'a'.repeat(64));
  check('a link must NOT overwrite a secret this device already holds',
    held.secret === 'a'.repeat(64),
    'otherwise a crafted link silently moves the device to another household');

  const none = run('?hub=192.168.1.10', null);
  check('a link with no hs leaves the secret alone', !none.secret);
}

console.log('\n=== 10. _cloudHasSecret is a format gate, not a truthiness check ===');
{
  const has = (v) => new Function(`
    const CONFIG = { cloudSecret: ${JSON.stringify(v)} };
    ${fn('_cloudHasSecret')}
    return _cloudHasSecret();
  `)();
  check('a real secret passes', has('a'.repeat(64)) === true);
  for (const bad of [null, '', 'yes', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64)]) {
    check(`rejects ${JSON.stringify(String(bad).slice(0, 10))} (len ${String(bad).length})`, has(bad) === false);
  }
}

console.log('\n=== 11. Minting on a household with no companion app ===');
{
  /* The early return used to sit above this branch, so these households never
     minted at all and their push died silently when the pre-split record hit
     its TTL. It is the one place a secret is created without a hub to confirm
     it, so its guards are the only thing standing between it and a write-war. */
  const run = ({ hubStore = null, sandbox = false, cfg = {}, payload }) => {
    const logs = [];
    const api = new Function('crypto', '__log', `
      let HUB_STORE = ${JSON.stringify(hubStore)};
      const SANDBOX = ${sandbox};
      const CONFIG = ${JSON.stringify(cfg)};
      const console = { log: (...a) => __log(a.join(' ')), warn: (...a) => __log(a.join(' ')) };
      // Mirrors the real gate: sbxBlocked('hub config write') is true in the
      // sandbox, which is what actually stops a sandbox mint.
      function sbxBlocked(){ return SANDBOX; }
      function hubStoreFetch(){ return Promise.resolve({ ok: true }); }
      ${fn('saveConfigToHub')}
      return { save: (p) => saveConfigToHub(p), cfg: () => CONFIG };
    `)(globalThis.crypto, m => logs.push(m));
    return { api, logs, payload };
  };

  const creds = () => ({ config: { token: 'maker-token', appId: '219' } });

  const minted = run({ payload: creds() });
  await minted.api.save(minted.payload);
  check('a household with no companion app DOES mint a secret',
    /^[0-9a-f]{64}$/.test(minted.api.cfg().cloudSecret || ''),
    'without this their push dies silently at the record TTL');
  check('...and the secret is put on the payload it is saving',
    minted.payload.config.cloudSecret === minted.api.cfg().cloudSecret);

  const sbx = run({ sandbox: true, payload: creds() });
  await sbx.api.save(sbx.payload);
  check('the sandbox does not mint a real household secret',
    !sbx.api.cfg().cloudSecret,
    'a sandbox that mints would claim the real household record');

  const bare = run({ payload: { config: {} } });
  await bare.api.save(bare.payload);
  check('no Maker credentials means no mint',
    !bare.api.cfg().cloudSecret,
    'an unconfigured device minting would claim the slot before the real one');

  const already = run({ cfg: { cloudSecret: 'a'.repeat(64) },
                        payload: { config: { token: 't', appId: '219', cloudSecret: 'a'.repeat(64) } } });
  await already.api.save(already.payload);
  check('a device that already holds a secret does not mint a second one',
    already.api.cfg().cloudSecret === 'a'.repeat(64),
    'two secrets for one household is the write-war this design exists to avoid');
}

console.log('\n=== 12. The key really is HKDF-SHA256 over the secret ===');
{
  /* Pins the derivation itself. Round-tripping through the shipped code alone
     proves only that it agrees with itself: swapping HKDF for a bare SHA-256,
     or dropping the info string, stays perfectly self-consistent and every
     other assertion in this file still passes. Devices would still interop --
     until one of them shipped on a different build. */
  const SECRET = 'd'.repeat(64);
  const w = world({ cloudSecret: SECRET });

  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), 'HKDF', false, ['deriveKey']);
  const expected = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('hestia-enc') },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);

  const shipped = await w.api.key(SECRET, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, shipped,
    new TextEncoder().encode('{"probe":1}'));

  let crossOk = false;
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, expected, ct);
    crossOk = new TextDecoder().decode(pt) === '{"probe":1}';
  } catch (e) {}
  check('the shipped key matches an independent HKDF-SHA256(info="hestia-enc")', crossOk,
    'changing the KDF or the info string silently forks every household');

  const wrongInfo = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('') },
    base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  let empty = false;
  try { await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, wrongInfo, ct); empty = true; } catch (e) {}
  check('a different info string does NOT produce the same key', !empty);
}

console.log('\n=== 13. Diagnostics must not report a forged record as Synced ===');
{
  /* ROLLBACK.md names Settings > Diagnostics > Cloud Sync as detection signal
     number one, so a false green here disables the rollback trigger itself.
     The check used to fall back to the legacy IP key whenever the household
     key failed -- and that key is SHA-256(publicIP + a constant in this repo),
     so a neighbour's forged record decrypted cleanly and read "Synced" on a
     device that could not actually read its own household's record. */
  const IP = '203.0.113.5';
  async function legacyBlob(obj) {
    const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(IP + ':hestia-cloud-sync'));
    const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key,
      new TextEncoder().encode(JSON.stringify(obj))));
    return { iv: btoa(String.fromCharCode(...iv)), data: btoa(String.fromCharCode(...ct)) };
  }
  async function householdBlob(secret, obj) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'HKDF', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('hestia-enc') },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key,
      new TextEncoder().encode(JSON.stringify(obj))));
    return { iv: btoa(String.fromCharCode(...iv)), data: btoa(String.fromCharCode(...ct)) };
  }

  const SECRET = 'e'.repeat(64);
  const run = async (secret, payload) => {
    const out = [];
    const api = new Function('crypto', 'btoa', 'atob', 'TextEncoder', 'TextDecoder', '__set', `
      const CONFIG = { cloudSecret: ${JSON.stringify(secret)} };
      const _CLOUD_INFO_ENC = 'hestia-enc';
      const CLOUD_SYNC_API = '/api/config';
      let _cloudLastPushError = null;
      const console = { log(){}, warn(){} };
      function diagSetStatus(id, colour, label, detail){ __set({ id, colour, label, detail }); }
      function fetch(url){
        if (String(url).endsWith('/whoami')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ ip: ${JSON.stringify(IP)} }) });
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(
          { found: true, encrypted: true, payload: ${JSON.stringify(payload)} }) });
      }
      ${fn('_cloudKey')}
      ${fn('_cloudDecryptWithKey')}
      ${fn('_cloudDeriveKey')}
      ${fn('_cloudDecrypt')}
      ${fn('diagCheckCloud')}
      return { go: () => diagCheckCloud() };
    `)(globalThis.crypto, globalThis.btoa, globalThis.atob, TextEncoder, TextDecoder, r => out.push(r));
    await api.go();
    return out[out.length - 1] || {};
  };

  const own = await run(SECRET, await householdBlob(SECRET, { config: { hub: 'https://mine' } }));
  check('a record this device can really read reads green', own.colour === 'green',
    `${own.colour} / ${own.label}`);

  const forged = await run(SECRET, await legacyBlob({ config: { config: { artemisPin: 'ATTACKER' } } }));
  check('a forged legacy record does NOT read green on a device holding a secret',
    forged.colour !== 'green',
    `${forged.colour} / ${forged.label} — a false all-clear disables the rollback trigger`);

  const premigration = await run(null, await legacyBlob({ config: { config: { hub: 'http://mine' } } }));
  check('a device with no secret yet is told it is not migrated, not that it is broken',
    premigration.colour === 'amber' && /not migrated/i.test(premigration.label || ''),
    `${premigration.colour} / ${premigration.label}`);

  const junk = await run(SECRET, { iv: btoa('0'.repeat(12)), data: btoa('unreadable-by-anyone') });
  check('a record readable by nobody is flagged, not passed',
    junk.colour === 'amber' && /household key/i.test(junk.label || ''),
    `${junk.colour} / ${junk.label}`);
  /* The wording matters as much as the colour here. This is what a user sees
     when their device has lost the key, and the previous text led with "it
     belongs to a different household sharing this public address" -- alarming,
     usually wrong, and with nothing to act on. A real user hit exactly this on
     v2.0.1 and concluded their settings were gone. */
  check('...and tells them how to actually recover',
    /Wall Panel/i.test(junk.detail || ''), junk.detail || '(no detail)');
}

console.log('\n=== 14. Boot mints the secret without the user touching Settings ===');
{
  /* Found by testing a real household after v2.0.0 shipped: its record was
     still in the legacy shape. Boot pushes to the cloud, cloudSyncPush()
     refuses without a secret, and the secret is only minted inside
     saveConfigToHub() -- which only ran from saveConfig(), i.e. a settings
     change. A household that updated and never opened Settings stayed on the
     old IP-derived key indefinitely, so the release did not protect them at
     all. Clicking Save & Apply fixed it, which confirmed the diagnosis.

     Runs the REAL boot guard, sliced from dashboard.html, not a paraphrase. */
  const start = SRC.indexOf('if (!_cloudHasSecret() && !_cloudPendingConfig) {');
  if (start < 0) throw new Error('boot mint guard not found in dashboard.html');
  const BLOCK = SRC.slice(start, SRC.indexOf('}', SRC.indexOf('await saveConfig();', start)) + 1);

  // The sliced block contains `await`, so it runs inside an async wrapper.
  const run = async ({ secret = null, pending = false } = {}) => {
    const calls = [];
    await new Function('__call', `
      const CONFIG = { cloudSecret: ${JSON.stringify(secret)} };
      const _cloudPendingConfig = ${pending ? '{ foreign: true }' : 'null'};
      const console = { log(){} };
      async function saveConfig(){ __call('saveConfig'); }
      ${fn('_cloudHasSecret')}
      return (async () => { ${BLOCK} })();
    `)(c => calls.push(c));
    return calls;
  };

  check('no secret: boot mints one without any user action',
    (await run()).includes('saveConfig'),
    'this is the whole fix — without it the release never engages');

  check('secret already held: boot does not mint again',
    !(await run({ secret: 'a'.repeat(64) })).includes('saveConfig'),
    'a second mint would encrypt the shared record under a different key');

  check('a malformed secret still counts as none, so it is replaced',
    (await run({ secret: 'not-a-real-secret' })).includes('saveConfig'),
    '_cloudHasSecret() is a format gate, and a garbage secret must not wedge the household');

  check('adoption prompt pending: boot does NOT write',
    !(await run({ pending: true })).includes('saveConfig'),
    'that record belongs to a household this device has not accepted');
}

console.log('\n=== 15. A secret minted while seeding the hub must reach localStorage ===');
{
  /* The other half of the same bug. When loadConfigFromHub() returns nothing,
     boot seeds the hub from local cache -- and saveConfigToHub() may MINT the
     secret during that call. The mint lands in CONFIG, not in localStorage, so
     without persisting it the next boot starts with no secret and mints a
     second one, encrypting the shared record under a key the first device
     cannot read. Same dropped-secret bug saveConfig() already guards against
     at its own call site; this path had no guard at all. */
  const start = SRC.indexOf('const seed = buildConfigPayload();');
  if (start < 0) throw new Error('boot hub-seed block not found in dashboard.html');
  const BLOCK = SRC.slice(start, SRC.indexOf(';', SRC.indexOf('_persistConfigKeepingSecret(seed)', start)) + 1);

  const run = async (persist) => {
    const store = {};
    await new Function('__store', `
      const CONFIG = { hub: 'https://hub', token: 't', appId: '219' };
      const _LS = { setItem: (k, v) => { __store[k] = v; } };
      const console = { log(){}, warn(){} };
      function buildConfigPayload(){ return { config: { hub: CONFIG.hub, token: 't' }, savedAt: 1 }; }
      // Mirrors the real saveConfigToHub() mint: sets CONFIG and the payload.
      async function saveConfigToHub(p){
        CONFIG.cloudSecret = 'f'.repeat(64);
        p.config.cloudSecret = CONFIG.cloudSecret;
        return true;
      }
      ${fn('_cloudHasSecret')}
      ${fn('_persistConfigKeepingSecret')}
      return (async () => { ${persist ? BLOCK : BLOCK.replace(/_persistConfigKeepingSecret\(seed\);/, '')} })();
    `)(store);
    return store['dashboard-config'] ? JSON.parse(store['dashboard-config']) : null;
  };

  const saved = await run(true);
  check('the minted secret is written to localStorage',
    !!(saved && saved.config && saved.config.cloudSecret === 'f'.repeat(64)),
    saved ? JSON.stringify(saved.config) : 'nothing persisted');

  const without = await run(false);
  check('...and without the persist call it would be lost, so this test bites',
    !without,
    'if this fails the assertion above proves nothing');
}

console.log('\n=== 16. A device without the key must not start a fresh household ===');
{
  /* Reported from the field on v2.0.1. A device that cannot reach the hub and
     has no local config opened hestari.com, could not decrypt the household
     record, and was shown the setup wizard. Completing it rebuilt rooms from
     scratch, minted a NEW household secret and rewrote the cloud record under
     it -- locking out every other device, which then hit the wizard in turn.
     The user's words: "afterwards I lost everything again."

     Before v2 this was impossible: the record used an IP-derived key, so any
     device on the network could read it. Removing that was the whole security
     fix, but it was also the bootstrap path, and nothing replaced it. */
  const IP = '203.0.113.5';
  async function legacyBlob(obj) {
    const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(IP + ':hestia-cloud-sync'));
    const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key,
      new TextEncoder().encode(JSON.stringify(obj))));
    return { iv: btoa(String.fromCharCode(...iv)), data: btoa(String.fromCharCode(...ct)) };
  }

  const run = async ({ secret = null, found = true, payload = null, ok = true, override = false }) => {
    const store = override ? { 'hestia-cloud-lockout-override': '1' } : {};
    return await new Function('crypto', 'btoa', 'atob', 'TextEncoder', 'TextDecoder', '__store', `
      const CONFIG = { cloudSecret: ${JSON.stringify(secret)} };
      const _CLOUD_INFO_ENC = 'hestia-enc';
      const CLOUD_SYNC_API = '/api/config';
      const _LS = {
        getItem: k => (k in __store ? __store[k] : null),
        removeItem: k => { delete __store[k]; },
      };
      /* Mirrors dashboard.html's real signature: (url, ms, opts) -- the
         TIMEOUT IS THE SECOND ARGUMENT. This stub used to ignore its
         arguments entirely, so the suite passed while the real call site
         passed {} as the timeout, making setTimeout fire immediately and
         abort every request. The guard failed open on every device and the
         bug it exists to fix was completely unfixed. A stub that does not
         check its own contract is how a test agrees with a bug. */
      function _fetchWithTimeout(url, ms, opts){
        if (typeof ms !== 'number' || !isFinite(ms)) {
          throw new Error('_fetchWithTimeout called with a non-numeric timeout: ' + JSON.stringify(ms));
        }
        return Promise.resolve({ ok: ${ok}, json: () => Promise.resolve(
          ${JSON.stringify({ found, encrypted: !!payload, payload })}) });
      }
      function _cloudGetIp(){ return Promise.resolve(${JSON.stringify(IP)}); }
      ${fn('_cloudHasSecret')}
      ${fn('_cloudDeriveKey')}
      ${fn('_cloudDecrypt')}
      ${fn('cloudRecordLockedOut')}
      return cloudRecordLockedOut();
    `)(globalThis.crypto, globalThis.btoa, globalThis.atob, TextEncoder, TextDecoder, store);
  };

  const householdBlob = await (async () => {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode('a'.repeat(64)), 'HKDF', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('hestia-enc') },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key,
      new TextEncoder().encode('{"config":{}}')));
    return { iv: btoa(String.fromCharCode(...iv)), data: btoa(String.fromCharCode(...ct)) };
  })();

  check('no key + a record it cannot read: LOCKED OUT, no wizard',
    (await run({ secret: null, payload: householdBlob })) === true,
    'this is the exact state that took a household down');

  check('holding the key: not locked out',
    (await run({ secret: 'a'.repeat(64), payload: householdBlob })) === false);

  check('no record at all: a genuinely new household proceeds normally',
    (await run({ secret: null, found: false })) === false,
    'first-time setup must never be blocked');

  check('a pre-v2 record it CAN still read: migrate, do not block',
    (await run({ secret: null, payload: await legacyBlob({ config: { config: {} } }) })) === false);

  check('backend unreachable: fail open to the wizard rather than trap them',
    (await run({ secret: null, ok: false })) === false,
    'a network hiccup must not look like a lockout');

  check('the deliberate override lets a real new household through',
    (await run({ secret: null, payload: householdBlob, override: true })) === false);

  /* Review finding: this fell through to "locked out" when the IP lookup
     itself could not be evaluated, contradicting the function's own contract.
     Those are different facts -- a decrypt tried and failed means this device
     really cannot read the record; a /whoami hiccup means we never got to ask.
     Conflating them sent a household still on the legacy scheme into a
     recovery flow it did not need, over an unrelated endpoint having a bad
     moment. */
  const noIp = await new Function('crypto', 'btoa', 'atob', 'TextEncoder', 'TextDecoder', `
    const CONFIG = { cloudSecret: null };
    const CLOUD_SYNC_API = '/api/config';
    const _LS = { getItem: () => null, removeItem(){} };
    function _fetchWithTimeout(url, ms){
      if (typeof ms !== 'number') throw new Error('timeout must be numeric');
      return Promise.resolve({ ok: true, json: () => Promise.resolve(
        ${JSON.stringify({ found: true, encrypted: true, payload: { iv: 'AAAA', data: 'AAAA' } })}) });
    }
    function _cloudGetIp(){ return Promise.resolve(null); }   // lookup unavailable
    ${fn('_cloudHasSecret')}
    ${fn('_cloudDeriveKey')}
    ${fn('_cloudDecrypt')}
    ${fn('cloudRecordLockedOut')}
    return cloudRecordLockedOut();
  `)(globalThis.crypto, globalThis.btoa, globalThis.atob, TextEncoder, TextDecoder);
  check('the IP lookup failing fails OPEN, it is not evidence of a lockout',
    noIp === false, 'never got to ask is not the same as asked and could not read');

  /* The override is a one-shot, and proving that needs TWO calls against the
     same storage -- a single call cannot tell "consumed once" from "disarmed
     forever". If it never cleared, one person choosing "set up as a new
     household" would silently switch the guard off on that device for good,
     and the next time they were genuinely locked out it would hand them the
     household-wiping wizard instead. */
  const twice = await new Function('crypto', 'btoa', 'atob', 'TextEncoder', 'TextDecoder', `
    const store = { 'hestia-cloud-lockout-override': '1' };
    const CONFIG = { cloudSecret: null };
    const CLOUD_SYNC_API = '/api/config';
    const _LS = {
      getItem: k => (k in store ? store[k] : null),
      removeItem: k => { delete store[k]; },
    };
    function _fetchWithTimeout(url, ms){
      if (typeof ms !== 'number') throw new Error('timeout must be numeric');
      return Promise.resolve({ ok: true, json: () => Promise.resolve(
        ${JSON.stringify({ found: true, encrypted: true, payload: { iv: 'AAAA', data: 'AAAA' } })}) });
    }
    function _cloudGetIp(){ return Promise.resolve('203.0.113.5'); }
    ${fn('_cloudHasSecret')}
    ${fn('_cloudDeriveKey')}
    ${fn('_cloudDecrypt')}
    ${fn('cloudRecordLockedOut')}
    return (async () => {
      const first  = await cloudRecordLockedOut();
      const second = await cloudRecordLockedOut();
      return { first, second, left: store['hestia-cloud-lockout-override'] || null };
    })();
  `)(globalThis.crypto, globalThis.btoa, globalThis.atob, TextEncoder, TextDecoder);

  check('the override is honoured once', twice.first === false);
  check('...and is consumed, not left disarming the guard forever',
    twice.second === true && twice.left === null,
    `second call returned ${twice.second}, flag left: ${twice.left}`);
}

console.log('\n=== 17. Boot must never hang on this check ===');
{
  /* Review finding, and the most severe of the three attempts at this fix.
     cloudRecordLockedOut() is awaited during BOOT. _cloudGetIp() was a bare
     fetch with no timeout -- the same unguarded-fetch class that produced the
     "hestari.com spins forever" report and caused _fetchWithTimeout to exist.
     A stalled /whoami meant the promise never settled, boot reached neither
     the wizard nor the lockout screen, and the page sat blank forever with
     nothing in the console. Worse than either earlier mistake: one failed
     open harmlessly, the other showed a wrong-but-visible screen. */
  // Brace-matched rather than a fixed slice: the explanatory comment inside
  // this function is long enough that a short window missed the call entirely
  // and failed while the code was correct.
  const src = fn('_cloudGetIp');
  check('_cloudGetIp uses the timeout helper, not a bare fetch',
    /_fetchWithTimeout\(\s*CLOUD_SYNC_API \+ '\/whoami'/.test(src) && !/await fetch\(/.test(src),
    'a bare fetch here hangs boot with a blank page');

  const guard = SRC.slice(SRC.indexOf('async function renderSetupOrLockout'),
                          SRC.indexOf('async function renderSetupOrLockout') + 900);
  check('the whole check is raced against a hard ceiling',
    /Promise\.race/.test(guard) && /setTimeout\(\(\) => resolve\(false\)/.test(guard),
    'per-call timeouts still leave the body read and any future await uncovered');
  check('and losing that race fails OPEN to the wizard',
    /resolve\(false\)/.test(guard),
    'being wrongly offered setup is recoverable; a page that never renders is not');

  /* The wiring, not the logic. Everything above proves cloudRecordLockedOut()
     decides correctly; this proves the decision is actually acted on. A
     mutation that changed `if (locked)` to `if (false)` survived the entire
     suite, because every other test called the decision function directly and
     never checked that anyone listened to it. */
  const wire = async (lockedResult) => {
    const calls = [];
    await new Function('__calls', '__locked', `
      function cloudRecordLockedOut(){ return Promise.resolve(__locked); }
      function renderCloudLockout(){ __calls.push('lockout'); }
      function renderOnboarding(){ __calls.push('wizard'); }
      // Never fires, so the real check always wins the race here.
      function setTimeout(){ return 1; }
      ${fn('renderSetupOrLockout')}
      return renderSetupOrLockout();
    `)(calls, lockedResult);
    return calls;
  };

  check('locked out -> the recovery screen is actually rendered',
    (await wire(true)).includes('lockout'),
    'deciding correctly means nothing if the result is ignored');
  check('not locked out -> the ordinary wizard is rendered',
    (await wire(false)).includes('wizard'));
  check('never both', (await wire(true)).length === 1 && (await wire(false)).length === 1);
}

console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL ? 1 : 0);

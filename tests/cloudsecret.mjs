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
function world({ cloudSecret = 'a'.repeat(64), hubOk = true, status = null } = {}) {
  // The rejection STATUS is selectable because the push handler now branches on
  // it. Hardcoding one status meant the other branches were never executed.
  status = (status === null) ? (hubOk ? 200 : 401) : status;
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
    function fetch(url, init){ __sent(JSON.parse(init.body)); return Promise.resolve({ ok: ${hubOk}, status: ${status} }); }
    ${fn('_cloudKey')}
    ${fn('_cloudEncryptWithKey')}
    ${fn('_cloudDecryptWithKey')}
    ${fn('_cloudTokenHash')}
    /* Real, not stubbed. R is the credential that survives a Maker API token
       rotation, and the whole point of it is that the value written into the
       ENCRYPTED half and the hash published in the plaintext half are produced
       in the same operation and cannot disagree. A stub would let them. */
    ${fn('_cloudEnsureRecovery')}
    ${fn('_cloudEnsureWebhookCap')}
    ${fn('buildServiceHalf')}
    ${fn('cloudSyncPush')}
    return { push: (p) => cloudSyncPush(p), key: (s,u) => _cloudKey(s,u),
             dec: (b,k) => _cloudDecryptWithKey(b,k), err: () => _cloudLastPushError,
             cfg: () => CONFIG };
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
  const reject = async (status) => {
    const w = world({ hubOk: false, status });
    await w.api.push(PAYLOAD());
    await new Promise(r => setTimeout(r, 50));
    return w;
  };

  const generic = await reject(413);
  check('the PUT was attempted', generic.sent.length === 1);
  check('an unexpected rejection still names its status',
    /HTTP 413/.test(generic.api.err() || ''),
    generic.api.err() || '(silent — this was the bug)');
  check('and logged', generic.logs.some(l => /rejected/i.test(l)));

  /* 401 and 409 each have exactly one cause a user can act on, and naming only
     the number left the most damaging one unexplained. A household recovering
     over its own record is authorised by the Maker API token stored in that
     record, so entering a freshly generated token during setup 401s forever:
     the dashboard works locally, nothing ever reaches another device, and the
     only symptom was a three-digit number. */
  const unauth = await reject(401);
  check('401 names the Maker API token as the cause',
    /Maker API token/i.test(unauth.api.err() || ''),
    unauth.api.err() || '(no message)');
  check('...and says which token to use, not just that one is wrong',
    /already had/i.test(unauth.api.err() || ''));

  const conflict = await reject(409);
  check('409 points at the household key rather than a fresh setup',
    /household key/i.test(conflict.api.err() || ''),
    conflict.api.err() || '(no message)');

  /* All three must still be distinguishable. Collapsing them back to one
     string is the regression this guards. */
  const msgs = [generic.api.err(), unauth.api.err(), conflict.api.err()];
  check('the three cases do not share one message',
    new Set(msgs).size === 3, JSON.stringify(msgs));
}

console.log('\n=== 5. Minting is gated on the hub accepting the write ===');
{
  // Real saveConfigToHub, with hubStoreFetch stubbed to fail.
  const mk = (ok, recordUnreadable = false) => new Function('crypto', '__calls', `
    const CONFIG = {};
    const SANDBOX = false;
    const HUB_STORE = { appId: '1', token: 't' };
    const console = { log(){}, warn(){} };
    function sbxBlocked(){ return false; }
    function hubStoreFetch(){ __calls('write'); return Promise.resolve({ ok: ${ok} }); }
    /* Mirrors dashboard.html's _cloudRecordUnreadable(): async, resolves to a
       boolean, no side effects. It MUST stay async -- saveConfigToHub awaits
       it, and a synchronous stub would let a truthy-Promise bug pass. */
    function _cloudRecordUnreadable(){ return Promise.resolve(${recordUnreadable}); }
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

  /* The HUB-REACHABLE mint, which had no guard at all until 2026-10-02 while
     the unreachable one had two.

     exportSettings() does not include cloudSecret, so importing a settings
     file onto a device that holds none leaves CONFIG without one. saveConfig()
     then builds a payload without one, this mints a brand new household key
     and POSTs it to the hub, and every other device inherits it on next boot
     through applyParsedConfig()'s unconditional assign. One import re-keys the
     whole household and nobody can read their own cloud record again. */
  const foreign = mk(true, true);
  const p3 = { config: { token: 'x' } };
  const ok3 = await foreign.save(p3);
  check('a record this device cannot read blocks the hub-reachable mint too',
    !foreign.cfg().cloudSecret && p3.config.cloudSecret === undefined,
    'this is the path an imported settings file travels; the !HUB_STORE guards never see it');
  check('...and the hub write itself still goes through',
    ok3 === true,
    'refusing the whole save would break a device that is otherwise fine -- only the re-key is refused');

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
        /* Mirrors dashboard.html's _cloudRecordUnreadable(): async, resolves to a
       boolean, side-effect free. It MUST stay async -- saveConfigToHub awaits
       it, and a synchronous stub would let a truthy-Promise bug pass here,
       which is exactly how an earlier guard in this file failed open on every
       device while the suite stayed green. False = no foreign record in the
       way, which is the scenario each of these sections is actually about. */
    function _cloudRecordUnreadable(){ return Promise.resolve(false); }
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
      /* Present so a missing binding cannot fake this section's result.
         cloudSyncDiscover() wraps everything in one try/catch, so an undefined
         helper throws, is swallowed, and returns null -- which is exactly the
         outcome these assertions want. The forged record would then be
         "refused" by a ReferenceError rather than by the guard under test. */
      const _LS = { getItem: () => null, setItem(){}, removeItem(){} };
      const CLOUD_SECRET_MEMO_KEY = 'hestia-cloud-secret-memo';
      const CLOUD_SECRET_MEMO_MAX = 3;
      ${fn('_cloudRememberGoodSecret')}
      ${fn('_cloudRememberedSecrets')}
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
  const run = ({ hubStore = null, sandbox = false, cfg = {}, payload,
                 recordUnreadable = false }) => {
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
      /* Mirrors dashboard.html's _cloudRecordUnreadable(): async, resolves to a
         boolean, no side effects. The real one fetches /api/config/discover and
         attempts a decrypt; the scenario supplies the answer. It must stay
         async -- saveConfigToHub awaits it, and a synchronous stub would make
         a truthy-Promise bug pass here. */
      function _cloudRecordUnreadable(){ return Promise.resolve(${recordUnreadable}); }
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

  /* The two guards added 2026-10-02, from two field reports.

     `!HUB_STORE` does NOT mean "this household has no companion app". It is
     also true when the device simply cannot reach it, which is the ORDINARY
     state on hestari.com -- discoverHubStore()'s fetch of
     /local/hestia-token.json is CORS-blocked cross-origin -- and whenever the
     stale-app-id breaker is open. Minting on that signal gave one physical
     device two different secrets across its two origins, and whichever wrote
     last re-encrypted the shared record and locked the other out. */
  const unreachable = run({ cfg: { hestiaAppId: '1042' }, payload: creds() });
  await unreachable.api.save(unreachable.payload);
  check('a known companion app that is merely unreachable does NOT mint',
    !unreachable.api.cfg().cloudSecret,
    'this is the hestari.com origin of a household that HAS a hub; the hub owns the secret');
  check('...and the payload it was saving is left clean',
    !unreachable.payload.config.cloudSecret,
    'a secret left on the payload would be persisted and published by the caller');

  const foreign = run({ payload: creds(), recordUnreadable: true });
  await foreign.api.save(foreign.payload);
  check('an existing record this device cannot read does NOT mint',
    !foreign.api.cfg().cloudSecret,
    'minting over a household already here encrypts a second record and locks out the real key');

  /* Fail OPEN. A genuine first-time setup must never be blocked by the record
     check having a bad moment, which is _cloudRecordUnreadable()'s own stated
     contract. */
  const genuinelyNew = run({ payload: creds(), recordUnreadable: false });
  await genuinelyNew.api.save(genuinelyNew.payload);
  check('a genuinely new household still mints',
    /^[0-9a-f]{64}$/.test(genuinelyNew.api.cfg().cloudSecret || ''),
    'the guards must not block the households this branch was added for');
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
  const run = async (secret, payload, pushError = null, opts = {}) => {
    const { hubUrl = null, hostname = 'hestari.com', origin = 'https://hestari.com',
            fetchThrows = false } = opts;
    const out = [];
    const api = new Function('crypto', 'btoa', 'atob', 'TextEncoder', 'TextDecoder', '__set', `
      const CONFIG = { cloudSecret: ${JSON.stringify(secret)}, hub: ${JSON.stringify(hubUrl)} };
      const _CLOUD_INFO_ENC = 'hestia-enc';
      const CLOUD_SYNC_API = '/api/config';
      let _cloudLastPushError = null;
      const console = { log(){}, warn(){} };
      function diagSetStatus(id, colour, label, detail){ __set({ id, colour, label, detail }); }
      function fetch(url){
        /* A relative path from a hub-served page reaches the hub, which has no
           such endpoint, so the real failure here is a rejected fetch -- not a
           non-ok response. That is the branch fix A lives in. */
        if (${fetchThrows}) return Promise.reject(new TypeError('Failed to fetch'));
        if (String(url).endsWith('/whoami')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ ip: ${JSON.stringify(IP)} }) });
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(
          { found: true, encrypted: true, payload: ${JSON.stringify(payload)} }) });
      }
      const HUB_STORE = null;
      let _sharedHubUrl = null;
      const window = { location: { origin: ${JSON.stringify(origin)}, hostname: ${JSON.stringify(hostname)} } };
      ${fn('_cloudKey')}
      ${fn('_cloudDecryptWithKey')}
      ${fn('_cloudDeriveKey')}
      ${fn('_cloudDecrypt')}
      /* Real, not stubbed: the ownership hint is appended to the message this
         section asserts on, so a stub would be asserting on the stub. */
      ${fn('_cloudRecordOwnershipHint')}
      ${fn('isServedFromHub')}
      /* Real, not stubbed. discover.js now withholds the record's plaintext
         half from an unauthenticated caller, and that half is what the
         ownership hint reads -- so if this device stopped sending credentials,
         the hint would silently go quiet and these assertions would be testing
         an empty string. */
      ${fn('_cloudTokenHash')}
      ${fn('_cloudHasSecret')}
      ${fn('_cloudAuthHeaders')}
      const CLOUD_EXPIRY_SEEN_KEY = 'hestia-cloud-expiry-seen';
      ${fn('_cloudRecordExpiryHint')}
      ${fn('diagCheckCloud')}
      return { go: (err) => { _cloudLastPushError = err || null; return diagCheckCloud(); } };
    `)(globalThis.crypto, globalThis.btoa, globalThis.atob, TextEncoder, TextDecoder, r => out.push(r));
    await api.go(pushError);
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
  /* It used to point at "Settings -> Wall Panel on a device that still works".
     For the households that reach this message there IS no working device --
     that is the definition of the state -- so the only route they could find
     was to wipe a device and start over, which mints a fresh secret and takes
     the rest of the household down with it. Two users did exactly that. The
     advice has to name something reachable from where they are standing. */
  check('...and tells them how to actually recover',
    /Household key box below/i.test(junk.detail || ''), junk.detail || '(no detail)');
  check('...and does not send them to a device that still works',
    !/device that still works/i.test(junk.detail || ''),
    'impossible for exactly the households that read this message');

  /* Behavioural, not source-text. An unauthorised write means the stored record
     still carries the household's PREVIOUS Maker API token, and
     functions/api/push/send.js:51 compares against that same stored hash. That
     endpoint is the only path for HSM intrusion trips and arm/disarm, so those
     are refused -- while webhook.js never checks the token and keeps delivering
     door, window, lock and motion. The household sees notifications arriving
     and concludes push is healthy while the alarm half is dead. */
  const UNREADABLE = { iv: btoa('0'.repeat(12)), data: btoa('unreadable-by-anyone') };
  const rejected = await run(SECRET, UNREADABLE,
    'cloud rejected the write as unauthorized — the saved record for this connection was created with a different Maker API token');
  check('a 401 on the write warns that ALARM pushes specifically are refused',
    /intrusion and arm\/disarm pushes are being refused/i.test(rejected.detail || ''),
    rejected.detail || '(no detail)');
  check('...and explains why that is easy to miss',
    /still arrive/i.test(rejected.detail || ''),
    'door and window pushes keep working, which is exactly what hides this');
  const notRejected = await run(SECRET, UNREADABLE, null);
  check('...and does not cry wolf when no write was rejected',
    !/intrusion and arm\/disarm/i.test(notRejected.detail || ''),
    'the warning is tied to the 401, not printed on every unreadable record');

  /* Fix A, 2026-10-02, from jkudave. CLOUD_SYNC_API is a RELATIVE path, so on a
     hub-served page it resolves to the hub, which serves no such endpoint. The
     request never goes near hestari.com -- and the old message said "could not
     reach the hestari.com backend", sending people to check a service that was
     never asked. It also claimed push was down, when push DELIVERY and hub-fired
     reminders go hub -> hestari.com directly (HestiaDashboard.groovy:66-67 are
     absolute URLs) and do not care what served this page. */
  const onHub = await run(SECRET, UNREADABLE, null,
    { hubUrl: 'http://192.168.50.139', hostname: '192.168.50.139',
      origin: 'http://192.168.50.139', fetchThrows: true });
  check('a hub-served page is told the real cause, not that hestari.com is down',
    /not available on this address/i.test(onHub.label || ''),
    `${onHub.colour} / ${onHub.label}`);
  check('...and it stays RED, because cloud sync really is unavailable here',
    onHub.colour === 'red',
    'naming the cause is not the same as softening the alarm');
  check('...and it does not blame a backend it never contacted',
    !/could not reach the hestari\.com backend/i.test(onHub.detail || ''),
    onHub.detail || '(no detail)');
  check('...and it says reminders and existing push are NOT affected',
    /reminders/i.test(onHub.detail || '') && /already registered/i.test(onHub.detail || ''),
    'telling a security household its alarms are down when they are not is its own harm');
  check('...and it names the address that actually served the page',
    (onHub.detail || '').includes('192.168.50.139'),
    'the check knows its own origin; printing it ends the guessing');

  const offHub = await run(SECRET, UNREADABLE, null, { fetchThrows: true });
  check('a hestari.com page that genuinely cannot reach the backend still says so',
    offHub.colour === 'red' && /unreachable/i.test(offHub.label || ''),
    `${offHub.colour} / ${offHub.label}`);
  check('...so the two causes are reported differently, which is the whole fix',
    offHub.label !== onHub.label,
    'if these collapse to one message the branch is doing nothing');
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
      /* Both halves are extracted, not stubbed. cloudRecordLockedOut() was
         split in two on 2026-10-02 so saveConfigToHub() could reuse the record
         test without consuming the one-shot lockout override on its way past.
         The split is an implementation detail of the same behaviour, so this
         section keeps asserting the whole thing rather than mocking the half
         that does the actual work. */
      ${fn('cloudRecordLockedOut')}
      ${fn('_cloudRecordUnreadable')}
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
    ${fn('_cloudRecordUnreadable')}
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
    ${fn('_cloudRecordUnreadable')}
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

console.log('\n=== 18. Recovering when NO device still has the key ===');
{
  /* Field report on v2.0.2, from the household the lockout screen was built
     for. Every one of his devices was locked out, which is the end state of the
     v2.0.0 wipe, and the screen's instruction was "open Hestia on a device that
     is already working". There was no such device. He followed it anyway, and
     the Wall Panel link he copied carried no `hs=` at all, because
     spWallPanelBody only appends the secret when the generating device holds
     one -- so the one documented recovery produced a link that looked right and
     did nothing. His words: "same results ... is there a way to start from
     scratch?"

     Entering the key by hand needs no second device, which is why it is now the
     first thing offered. These tests constrain the two halves that made the old
     advice fail silently: the extraction, and the fact that the link warns when
     it cannot carry a key. */
  const KEY = 'ab12'.repeat(16);                 // 64 hex
  const OTHER = 'ff00'.repeat(16);               // a DIFFERENT 64-hex value
  if (KEY.length !== 64 || OTHER.length !== 64) throw new Error('test fixture is not 64 chars');

  /* Stable element objects, not a fresh literal per getElementById call: the
     error element has to be readable AFTER the call or the message it shows
     cannot be asserted at all. */
  const drive = new Function('__value', '__nav', '__err', `
    const els = {
      'cl-key':     { value: __value, addEventListener(){}, focus(){} },
      'cl-key-err': { textContent: '', style: {}, },
    };
    Object.defineProperty(els['cl-key-err'], 'textContent', {
      get: () => __err.text, set: (v) => { __err.text = v; },
    });
    const document = { getElementById: (id) => els[id] || null };
    const location = { pathname: '/', replace: (u) => __nav.push(u) };
    const encodeURIComponent = globalThis.encodeURIComponent;
    ${fn('cloudLockoutUseKey')}
    cloudLockoutUseKey();
  `);

  const run = (value) => {
    const nav = [], err = { text: '' };
    drive(value, nav, err);
    return { nav, err: err.text };
  };
  const go = (value) => run(value).nav;

  check('a bare key navigates to the hs= boot path',
    go(KEY)[0] === '/?hs=' + KEY, go(KEY)[0]);

  check('a pasted JSON fragment has the key pulled out of it',
    go(`  "cloudSecret":"${KEY}",  `)[0] === '/?hs=' + KEY);

  check('a pasted link works too',
    go(`https://hestari.com/?hs=${KEY}`)[0] === '/?hs=' + KEY);

  check('uppercase is normalised, so boot\'s own gate accepts it',
    go(KEY.toUpperCase())[0] === '/?hs=' + KEY,
    'boot tests /^[0-9a-f]{64}$/ -- uppercase would be silently ignored there');

  /* The reason extraction is labelled-first rather than first-match. A user
     told to look for `cloudSecret` may paste the whole config blob, and that
     blob contains other 64-character hex strings. Taking the first run found
     would hand over a token hash, fail to decrypt, and return them to this
     exact screen with nothing explaining why. */
  const blob = `{"savedAt":1,"config":{"tokenHash":"${OTHER}","cloudSecret":"${KEY}","x":1}}`;
  check('a whole config blob yields cloudSecret, not the hash that precedes it',
    go(blob)[0] === '/?hs=' + KEY, go(blob)[0]);

  check('nothing usable in the paste means no navigation at all',
    go('not a key').length === 0 && go('').length === 0 && go('   ').length === 0,
    'navigating on junk would reload into the same screen with no error shown');

  check('a 63-character near-miss is refused rather than padded',
    go(KEY.slice(0, 63)).length === 0);

  /* An empty box and a wrong value are different mistakes and get different
     wording. Without this, dropping the early return changed nothing a test
     could see -- the format check below it refuses an empty string too, so the
     only casualty was telling someone who has not pasted yet that what they
     pasted is invalid. */
  check('an empty box asks for the key rather than calling it invalid',
    /paste your household key/i.test(run('   ').err), JSON.stringify(run('   ').err));
  check('...and a wrong value is described as wrong',
    /does not contain/i.test(run('nope').err), JSON.stringify(run('nope').err));

  /* The extracted value is only useful if boot still accepts it, and boot's
     gate is inline in the boot IIFE so it cannot be brace-extracted. Assert the
     literal is still there: if that gate is ever widened or narrowed, this
     fails and the extraction above gets re-checked against it. */
  check('boot still gates hs= on exactly 64 lowercase hex characters',
    /_urlHs && \/\^\[0-9a-f\]\{64\}\$\/\.test\(_urlHs\) && !CONFIG\.cloudSecret/.test(SRC),
    'extraction and adoption must agree on the format');

  /* The other half of the field failure. A link that cannot carry the key must
     say so, or the lockout screen's fallback advice sends people to copy it. */
  const wp = fn('spWallPanelBody');
  check('the Wall Panel section warns when the link carries no household key',
    /CONFIG\.cloudSecret \? '' :/.test(wp) &&
    /does not carry your household key/.test(wp),
    'a keyless link that looks correct is what made the original advice fail');

  /* And the lockout screen must actually offer the field, wired to the handler.
     Rendering the explanation without the input would read as fixed and
     recover nobody. */
  /* The instructions told people to take "appId and token" from
     hestia-token.json. That file holds FOUR credentials -- appId/token for the
     companion app and makerApiAppId/makerApiToken for Maker API -- and picking
     the wrong pair yields a blank page with nothing to say which mistake was
     made. jbwrd3 followed the instructions and got exactly that. The page
     knows which fields it wants, so it builds the URL itself. */
  const build = (value, hub = '') => new Function('__value', '__hub', `
    const els = {
      'cl-tok':     { value: __value },
      'cl-tok-out': { innerHTML: '', style: {}, querySelector: () => null },
    };
    const document = { getElementById: (id) => els[id] || null };
    const CONFIG = { hub: __hub };
    const encodeURIComponent = globalThis.encodeURIComponent;
    function h(s){ return String(s); }
    ${fn('cloudLockoutBuildLink')}
    cloudLockoutBuildLink();
    return els['cl-tok-out'].innerHTML;
  `)(value, hub);

  const REAL = '{"appId":"222","token":"tok-companion","hubIp":"192.168.50.139",' +
               '"makerApiAppId":"219","makerApiToken":"tok-maker"}';
  const built = build(REAL);
  check('the link is built from the COMPANION credentials, not the Maker API ones',
    /\/apps\/api\/222\/config\?access_token=tok-companion/.test(built) &&
    !/219/.test(built) && !/tok-maker/.test(built),
    built.slice(0, 140));
  check('...and works out the hub address with no local config at all',
    /192\.168\.50\.139/.test(built),
    'a locked-out device often knows nothing about the hub');

  check('a paste of only the Maker API fields is refused, not silently wrong',
    !/apps\/api/.test(build('{"makerApiAppId":"219","makerApiToken":"x","hubIp":"1.2.3.4"}')),
    'building a broken link is what produced the blank page');
  check('an empty paste asks for the file rather than erroring obscurely',
    /paste the contents/i.test(build('')));
  check('a pretty-printed paste still works, since that is what a browser shows',
    /apps\/api\/222/.test(build('{\n  "appId": "222",\n  "token": "tok-companion"\n}', 'http://h')));
  check('the result warns that a blank or null page means no saved settings',
    /blank or says "null"/.test(built),
    'that case needs a different remedy and used to look identical');

  const lock = fn('renderCloudLockout');
  check('the lockout screen renders the key input and wires it up',
    /id="cl-key"/.test(lock) && /cloudLockoutUseKey\(\)/.test(lock));
  check('...and the link builder too',
    /id="cl-tok"/.test(lock) && /cloudLockoutBuildLink\(\)/.test(lock));

  /* Diagnostics carried its own copy of the impossible advice. v2.1.2 fixed
     the lockout screen and missed this one, so the household that could not
     recover was still being told to use a device that does not exist. */
  const diag = fn('diagCheckCloud');
  check('Diagnostics no longer leads with "use a device that is already working"',
    /hestia-token\.json/.test(diag),
    'it must name the self-service path, like the lockout screen does');
  /* Anchor on the appended text, not on the variable name: the variable is
     declared above the message, so searching after the title found nothing
     while the feature was present. */
  /* Pin the BINDING, not the occurrence. Both the message string and the
     variable name appear elsewhere in this function, so asserting they exist
     passed with the branch hard-wired off -- the third time tonight a
     text-presence assertion agreed with a disabled feature. */
  /* Comments stripped FIRST, every time, in this section. Three assertions in
     one release series passed by matching the explanatory comment above the
     code they were meant to prove. */
  const decomment = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const diagCode = decomment(diag);
  check('...and surfaces a rejected write instead of suppressing it',
    /const rejected = _cloudLastPushError/.test(diagCode) &&
    /last save was also rejected/.test(diagCode),
    'a 401 explains why setting up fresh does not stick; hiding it wastes the user\'s time');
  /* 2026-10-02. An unauthorised write means the stored record still carries the
     household's PREVIOUS Maker API token -- and functions/api/push/send.js:51
     compares against that same stored hash. That endpoint is the only path for
     HSM intrusion trips and arm/disarm, so those pushes are refused, while
     webhook.js never checks the token and keeps delivering door/window/motion.
     The household sees notifications arriving and concludes push is healthy
     while the alarm half is dead. Reported by two users. */
  check('...and names the notifications an unauthorised write actually kills',
    /\/unauthor\/i\.test\(rejected\)/.test(diagCode) &&
    /intrusion and arm\/disarm pushes are being refused/.test(diagCode),
    'saying "the last save was rejected" without this lets a household believe its alarm pushes work');
  check('...and no longer claims nothing has been lost',
    !/nothing has been lost/.test(lock),
    'untrue for the household that already lost it, which is who reads this');
}

console.log('\n=== 19. Holding the household secret IS the proof of ownership ===');
{
  /* The v2.1.3 recovery screen led straight back into the v2.0.2 disaster.
     jbwrd3 did exactly what he was told: got his household key, cleared the
     cache, entered the key. Boot decrypted the record with it -- and then
     _cloudConfigTrusted() said untrusted, because it only knew "the hub this
     device already uses" and "a household accepted here before", BOTH of which
     the cache clear had wiped. So it showed the setup wizard. Finishing that
     minted a NEW secret and overwrote the household again.

     His words: "entered the secret key finished setup and still have it asking
     for household key and now have to re enter my devices again."

     The trust check was written before the household secret existed and was
     never taught about it. Decrypting the record under the secret this device
     holds is the STRONGEST proof available -- stronger than a hostname and an
     app id, which are guessable -- and it was the one signal being ignored. */
  const SECRET = 'c'.repeat(64);
  const OTHER  = 'd'.repeat(64);
  const IP = '203.0.113.5';
  const CFG = { config: { hub: 'http://192.168.50.139', appId: '219', token: 't' },
                rooms: [{ id: 'r1', name: 'Kitchen' }] };

  const sealHousehold = async (secret, body) => {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'HKDF', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('hestia-enc') },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key,
      new TextEncoder().encode(JSON.stringify({ config: body }))));
    return { iv: btoa(String.fromCharCode(...iv)), data: btoa(String.fromCharCode(...ct)) };
  };
  const sealLegacy = async (body) => {
    const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(IP + ':hestia-cloud-sync'));
    const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key,
      new TextEncoder().encode(JSON.stringify({ config: body }))));
    return { iv: btoa(String.fromCharCode(...iv)), data: btoa(String.fromCharCode(...ct)) };
  };

  /* A device with a WIPED cache: no hub, no appId, no remembered household --
     exactly the state a cache clear leaves, and the state the old check could
     never trust anything in. */
  const run = async (secret, payload) => await new Function(
    'crypto', 'btoa', 'atob', 'TextEncoder', 'TextDecoder', '__payload', `
    const CONFIG = { cloudSecret: ${JSON.stringify(secret)} };   // no hub, no appId
    const _CLOUD_INFO_ENC = 'hestia-enc';
    const CLOUD_SYNC_API = '/api/config';
    const CLOUD_HOUSEHOLD_KEY = 'hestia-cloud-household';
    const _LS = { getItem: () => null, setItem(){}, removeItem(){} };
    const console = { log(){}, warn(){} };
    function _cloudGetIp(){ return Promise.resolve(${JSON.stringify(IP)}); }
    function fetch(){ return Promise.resolve({ ok: true, json: () => Promise.resolve(
      { found: true, encrypted: true, payload: __payload }) }); }
    ${fn('_cloudKey')}
    ${fn('_cloudDeriveKey')}
    ${fn('_cloudDecrypt')}
    ${fn('_cloudDecryptWithKey')}
    ${fn('_cloudHouseholdId')}
    ${fn('_cloudLocalHouseholdId')}
    let _cloudSecretDecryptedId = null;
    ${fn('_cloudConfigTrusted')}
    /* Real functions, not stubs. _LS.getItem returns null here, so the memo is
       empty and the "try a previously working secret" fallback is inert --
       which is what these assertions want: they are about the PRIMARY key
       path, and a fallback firing would mask a regression in it. */
    const CLOUD_SECRET_MEMO_KEY = 'hestia-cloud-secret-memo';
    const CLOUD_SECRET_MEMO_MAX = 3;
    ${fn('_cloudRememberGoodSecret')}
    ${fn('_cloudRememberedSecrets')}
    ${fn('cloudSyncDiscover')}
    return cloudSyncDiscover().then(cfg => ({
      got: !!cfg,
      rooms: cfg && cfg.rooms ? cfg.rooms.length : 0,
      trusted: cfg ? _cloudConfigTrusted({ config: cfg.config || (cfg.hub ? cfg : null) }) : null,
      flag: _cloudSecretDecryptedId,
      /* A DIFFERENT household presented after the same successful discover.
         The vouch is for the record that was decrypted, not a licence to
         trust whatever is handed over next. */
      foreignTrusted: _cloudConfigTrusted({ config: { hub: 'http://10.0.0.9', appId: '999' } }),
    }));
  `)(globalThis.crypto, globalThis.btoa, globalThis.atob, TextEncoder, TextDecoder, payload);

  const mine = await run(SECRET, await sealHousehold(SECRET, CFG));
  check('THE FIELD BUG: a cache-wiped device that supplies the right key is TRUSTED',
    mine.got === true && mine.trusted === true,
    JSON.stringify(mine) + ' — untrusted here means the setup wizard, which destroys the household');
  check('...and the config really came back, not an empty shell',
    mine.rooms === 1, `${mine.rooms} room(s)`);
  /* The vouch names ONE household. Without the id comparison it degenerates
     into "a secret decrypt happened recently, trust anything" -- and the
     comment on that line claims the opposite, so the claim needs a test. */
  check('...but it vouches for THAT household only, not the next config offered',
    mine.foreignTrusted === false,
    'a vouch must not become a blanket licence to trust whatever comes next');

  /* The security-critical negative. A legacy record is decrypted with
     SHA-256(publicIP + a constant in a public repo), which any IP neighbour
     can recompute and therefore forge. Decrypting one proves nothing about
     whose household it is, so it must NOT set the vouching flag. */
  const legacy = await run(null, await sealLegacy(CFG));
  check('a legacy IP-key record is read but never vouched for',
    legacy.got === true && legacy.flag === null,
    JSON.stringify(legacy) + ' — a neighbour can forge one of these');
  check('...so an untrusted legacy record still goes through the prompt',
    legacy.trusted === false,
    'auto-applying a forgeable record is the hole the whole trust model closes');

  /* Someone else's record, encrypted under a secret this device does not hold:
     it must not decrypt at all, so there is nothing to trust. */
  const theirs = await run(SECRET, await sealHousehold(OTHER, CFG));
  check('a record sealed under a different secret does not decrypt',
    theirs.got === false && theirs.flag === null, JSON.stringify(theirs));

  /* The flag is per-call. A stale value from an earlier discover vouching for
     a later, different record would be its own vulnerability. */
  const src = fn('cloudSyncDiscover');
  check('the vouching flag is cleared on every call before anything sets it',
    /_cloudSecretDecryptedId = null;[\s\S]{0,200}viaSecret = false/.test(src),
    'a stale flag would vouch for a record it never read');
  /* Still pins the GUARD, not the occurrence: the assignment has to sit inside
     `if (viaSecret && out)`. It became a block on 2026-10-02 when remembering
     the proven secret was added beside it. */
  check('...and only the secret path sets it',
    /if \(viaSecret && out\) \{\s*_cloudSecretDecryptedId = _cloudHouseholdId\(out\);/.test(src));
}

console.log('\n=== 20. A device that ended up with the wrong secret heals itself ===');
{
  /* Two field reports, 2026-10-02. One physical device can hold two different
     secrets across its two origins: hestari.com cannot discover the companion
     app cross-origin (CORS), so saveConfigToHub()'s !HUB_STORE branch minted
     its own. Whichever origin wrote last re-encrypted the shared record and
     the other could no longer read its own settings.

     The rule is "the secret that decrypts the record wins". The record is the
     arbiter, which is a stronger claim than anything a device can assert about
     itself. Note the direction: this ADOPTS the working key rather than
     authorising with the broken one, which would re-encrypt the record under
     the spurious secret and lock out everybody holding the real one. */
  const REAL = '7'.repeat(64);
  const WRONG = '9'.repeat(64);
  const OTHER = 'c'.repeat(64);
  const IP = '203.0.113.9';
  const BODY = { config: { hub: 'http://192.168.50.139', appId: '219', token: 't' },
                 rooms: [{ id: 'r1', name: 'Kitchen' }] };

  const seal = async (secret, body) => {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'HKDF', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('hestia-enc') },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key,
      new TextEncoder().encode(JSON.stringify({ config: body }))));
    return { iv: btoa(String.fromCharCode(...iv)), data: btoa(String.fromCharCode(...ct)) };
  };

  const run = async ({ secret, memo, payload }) => await new Function(
    'crypto', 'btoa', 'atob', 'TextEncoder', 'TextDecoder', '__payload', '__store', `
    const CONFIG = { cloudSecret: ${JSON.stringify(secret)} };
    const _CLOUD_INFO_ENC = 'hestia-enc';
    const CLOUD_SYNC_API = '/api/config';
    const CLOUD_HOUSEHOLD_KEY = 'hestia-cloud-household';
    const CLOUD_SECRET_MEMO_KEY = 'hestia-cloud-secret-memo';
    const CLOUD_SECRET_MEMO_MAX = 3;
    const _LS = {
      getItem: k => (k in __store ? __store[k] : null),
      setItem: (k, v) => { __store[k] = v; },
      removeItem: k => { delete __store[k]; },
    };
    const console = { log(){}, warn(){} };
    function _cloudGetIp(){ return Promise.resolve(${JSON.stringify(IP)}); }
    function fetch(){ return Promise.resolve({ ok: true, json: () => Promise.resolve(
      { found: true, encrypted: true, payload: __payload }) }); }
    ${fn('_cloudKey')}
    ${fn('_cloudDeriveKey')}
    ${fn('_cloudDecrypt')}
    ${fn('_cloudDecryptWithKey')}
    ${fn('_cloudHouseholdId')}
    ${fn('_cloudLocalHouseholdId')}
    let _cloudSecretDecryptedId = null;
    ${fn('_cloudConfigTrusted')}
    ${fn('_cloudRememberGoodSecret')}
    ${fn('_cloudRememberedSecrets')}
    ${fn('cloudSyncDiscover')}
    return cloudSyncDiscover().then(cfg => ({
      got: !!cfg,
      rooms: cfg && cfg.rooms ? cfg.rooms.length : 0,
      adopted: CONFIG.cloudSecret,
      memo: JSON.parse(__store[CLOUD_SECRET_MEMO_KEY] || '[]'),
      flag: _cloudSecretDecryptedId,
    }));
  `)(globalThis.crypto, globalThis.btoa, globalThis.atob, TextEncoder, TextDecoder,
     payload, { 'hestia-cloud-secret-memo': JSON.stringify(memo) });

  const record = await seal(REAL, BODY);

  const healed = await run({ secret: WRONG, memo: [REAL], payload: record });
  check('a wrong secret plus a remembered working one: the record IS read',
    healed.got === true && healed.rooms === 1,
    JSON.stringify({ got: healed.got, rooms: healed.rooms }));
  check('...and the working secret is adopted back onto the device',
    healed.adopted === REAL,
    'without this the device stays split from its own household forever');
  check('...and it still vouches for the household it just opened',
    healed.flag !== null,
    'a record opened by a proven key is this household\'s, so boot may apply it');

  /* Does the memo actually do the work? Without it the same inputs must fail.
     If this passes, the assertions above prove nothing. */
  const noMemo = await run({ secret: WRONG, memo: [], payload: record });
  check('...and without the remembered secret it still fails, so the memo bites',
    noMemo.got === false && noMemo.adopted === WRONG,
    JSON.stringify({ got: noMemo.got, adopted: noMemo.adopted.slice(0, 6) }));

  const junkMemo = await run({ secret: WRONG, memo: [OTHER], payload: record });
  check('a remembered secret that does NOT open the record is not adopted',
    junkMemo.got === false && junkMemo.adopted === WRONG,
    'only a key proven against the live record may replace the held one');

  const proved = await run({ secret: REAL, memo: [], payload: record });
  check('a secret that opens the record is remembered for next time',
    proved.got === true && proved.memo.includes(REAL),
    'this is what makes the recovery above possible at all');
}

console.log('\n=== 21. The household key box verifies BEFORE it commits ===');
{
  /* The entry field exists because the only previous place to type a key was
     the boot lockout screen, which a device with a working config can never
     reach -- while Diagnostics told that exact device to "paste it into the
     recovery screen". The one way this button could leave someone worse off is
     by storing an unverified key, destroying a device's ability to read a
     record it can read today. So it is tested for refusal first. */
  const REAL = '4'.repeat(64);
  const WRONG = '5'.repeat(64);

  const seal = async (secret) => {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'HKDF', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('hestia-enc') },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key,
      new TextEncoder().encode(JSON.stringify({ config: { rooms: [] } }))));
    return { iv: btoa(String.fromCharCode(...iv)), data: btoa(String.fromCharCode(...ct)) };
  };

  const run = async ({ typed, payload, found = true, held = null }) => await new Function(
    'crypto', 'btoa', 'atob', 'TextEncoder', 'TextDecoder', '__payload', '__store', `
    const CONFIG = { cloudSecret: ${JSON.stringify(held)}, hub: 'http://192.168.50.139' };
    const _CLOUD_INFO_ENC = 'hestia-enc';
    const CLOUD_SYNC_API = '/api/config';
    const CLOUD_SECRET_MEMO_KEY = 'hestia-cloud-secret-memo';
    const CLOUD_SECRET_MEMO_MAX = 3;
    let _sharedHubUrl = null;
    const window = { location: { origin: 'https://hestari.com', hostname: 'hestari.com' } };
    let reloaded = false;
    const location = { reload: () => { reloaded = true; } };
    const setTimeout = (f) => { f(); return 0; };
    const _LS = {
      getItem: k => (k in __store ? __store[k] : null),
      setItem: (k, v) => { __store[k] = v; },
      removeItem: k => { delete __store[k]; },
    };
    const els = {
      'diag-hskey-input':  { value: ${JSON.stringify(typed)} },
      'diag-hskey-result': { textContent: '', style: {} },
      'diag-hskey-btn':    { disabled: false },
    };
    const document = { getElementById: id => els[id] || null };
    /* Real signature: (url, ms, opts). The timeout is the SECOND argument --
       a stub ignoring it is how an earlier guard passed while every real call
       aborted immediately. */
    function _fetchWithTimeout(url, ms){
      if (typeof ms !== 'number' || !isFinite(ms)) {
        throw new Error('_fetchWithTimeout called with a non-numeric timeout: ' + JSON.stringify(ms));
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(
        { found: ${found}, encrypted: true, payload: __payload }) });
    }
    ${fn('_cloudKey')}
    ${fn('_cloudDeriveKey')}
    ${fn('_cloudDecryptWithKey')}
    ${fn('isServedFromHub')}
    ${fn('_cloudRememberGoodSecret')}
    ${fn('_cloudRememberedSecrets')}
    ${fn('diagApplyHouseholdKey')}
    return diagApplyHouseholdKey().then(() => ({
      secret: CONFIG.cloudSecret,
      said: els['diag-hskey-result'].textContent,
      stored: __store['dashboard-config'] || null,
      reloaded,
    }));
  `)(globalThis.crypto, globalThis.btoa, globalThis.atob, TextEncoder, TextDecoder,
     payload, { 'dashboard-config': JSON.stringify({ config: { hub: 'http://192.168.50.139' } }) });

  const record = await seal(REAL);

  const bad = await run({ typed: WRONG, payload: record });
  check('a key that does not open the record is REFUSED',
    bad.secret === null,
    'storing it would break a device that can currently read its own settings');
  check('...and nothing is persisted', !/cloudSecret/.test(bad.stored || ''), bad.stored || '(none)');
  check('...and it says so rather than failing silently',
    /does not open/i.test(bad.said || ''), bad.said || '(said nothing)');
  check('...and it does not reload on a refusal', bad.reloaded === false);

  const good = await run({ typed: REAL, payload: record });
  check('a key proven against the live record is accepted', good.secret === REAL, good.said);
  check('...and is persisted so the reload keeps it',
    /cloudSecret/.test(good.stored || '') && good.stored.includes(REAL),
    good.stored || '(none)');
  check('...and reloads so boot applies the household through its tested path',
    good.reloaded === true,
    'half-applying a config from a settings panel is how partial states happen');

  /* A pasted config page contains a token hash and a secret proof too, both 64
     hex. Taking the first run found would adopt the wrong value and report a
     failure the user cannot explain. v2.1.3 learned this on the lockout screen. */
  const blob = await run({
    typed: '{"tokenHash":"' + 'b'.repeat(64) + '","cloudSecret":"' + REAL + '"}',
    payload: record });
  check('a pasted config blob picks the labelled cloudSecret, not the first 64 hex run',
    blob.secret === REAL, blob.said);

  const noRecord = await run({ typed: REAL, payload: record, found: false });
  check('no record to check against: refuse rather than store unverified',
    noRecord.secret === null && /no saved record/i.test(noRecord.said || ''),
    noRecord.said || '(said nothing)');

  /* Field report within hours of v2.2.0, from the household this box was built
     for. He pasted the key straight off his own hub and got "This device
     already holds that key" -- an early return that fired BEFORE verification.
     True, useless, and actively misleading: the fact that mattered is that the
     key he holds does NOT open his record, which is exactly why he is locked
     out. He went away thinking he had mis-copied something.

     A key that matches the held one must still be verified, and the answer must
     distinguish "you have it and it works" from "you have it and it does not". */
  const heldButWrong = await run({ typed: WRONG, payload: record, held: WRONG });
  check('a key the device already holds is STILL checked against the record',
    /does NOT open/i.test(heldButWrong.said || ''),
    heldButWrong.said || '(said nothing)');
  check('...and says the key is not the problem, so they stop hunting for a better one',
    /not the problem/i.test(heldButWrong.said || ''),
    'otherwise the only actionable fact is withheld at the moment it is needed');

  const heldAndRight = await run({ typed: REAL, payload: record, held: REAL });
  check('a held key that DOES open the record says so plainly',
    /does open/i.test(heldAndRight.said || '') && heldAndRight.reloaded === false,
    heldAndRight.said || '(said nothing)');
}

console.log('\n=== 22. "Will waiting clear this record?" ===');
{
  /* The record's 30-day expiry is refreshed by a SUCCESSFUL write and nothing
     else, so the date is evidence rather than just a countdown. A date that
     stays put means the record is abandoned and will lapse. A date that moves
     means something is writing it, so waiting never clears it. That is the
     only question a locked-out household can act on, and it previously had no
     way to ask it.

     This replaced a device-id comparison, which needed the gated half (so the
     households it was built for could never reach it) and would have been an
     enumeration oracle if served openly. */
  const run = ({ expiresAt, seen = null, now = 1793577600000 }) => new Function(
    '__store', '__now', `
    const _LS = {
      getItem: k => (k in __store ? __store[k] : null),
      setItem: (k, v) => { __store[k] = v; },
    };
    const Date = class extends globalThis.Date {
      constructor(...a){ super(...(a.length ? a : [__now])); }
      static now(){ return __now; }
    };
    /* Declared because fn() extracts the FUNCTION, not the module-level const
       it reads. Without it the lookup throws a ReferenceError straight into
       the function's own try/catch, "moved" silently stays false, and the one
       assertion that matters passes against a branch that never ran. */
    const CLOUD_EXPIRY_SEEN_KEY = 'hestia-cloud-expiry-seen';
    ${fn('_cloudRecordExpiryHint')}
    return { said: _cloudRecordExpiryHint(${JSON.stringify(expiresAt)}), store: __store };
  `)(seen === null ? {} : { 'hestia-cloud-expiry-seen': String(seen) }, now);

  const none = run({ expiresAt: undefined });
  check('a record with no stamp says the date is not known, rather than nothing',
    /not known/i.test(none.said),
    none.said);
  check('...and does not imply it never clears',
    !/never/i.test(none.said),
    '"we do not know" and "it never clears" are different facts, and conflating them is how someone wipes a device');

  const stamped = run({ expiresAt: 1793577600000 + 5 * 86400000 });
  check('a stamped record gives a real date and a day count',
    /clears on/i.test(stamped.said) && /5 days/.test(stamped.said),
    stamped.said);
  check('...and reassures that local settings are unaffected',
    /unaffected/i.test(stamped.said));

  /* The case that changes the advice. */
  const moved = run({ expiresAt: 1793577600000 + 10 * 86400000,
                      seen: 1793577600000 + 2 * 86400000 });
  check('a record whose date MOVED says waiting will not clear it',
    /will not clear it/i.test(moved.said),
    moved.said);
  /* Asserted on a value that actually CHANGED. Checking persistence in the
     unchanged case proves nothing, because the seeded value already satisfies
     it -- which let a mutant that deleted the write survive. */
  check('...and the new date is written back, or movement is undetectable next time',
    moved.store['hestia-cloud-expiry-seen'] === String(1793577600000 + 10 * 86400000),
    moved.store['hestia-cloud-expiry-seen'] || '(nothing stored)');

  /* Without this slack a household's own ordinary save would read as "a
     stranger is writing your record", which is alarming and wrong. */
  const sameish = run({ expiresAt: 1793577600000 + 5 * 86400000,
                        seen: 1793577600000 + 5 * 86400000 });
  check('an unchanged date is not reported as someone else writing',
    !/will not clear it/i.test(sameish.said),
    sameish.said);
  check('...and the newest value is remembered for the next check',
    sameish.store['hestia-cloud-expiry-seen'] === String(1793577600000 + 5 * 86400000),
    'without persisting it, movement could never be detected');
}

console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL ? 1 : 0);

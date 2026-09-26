/* Write authority on the config PUT, against the REAL handler.
 *
 * The endpoint was unauthenticated: everyone behind one public IP shares the
 * record, so under CGNAT any of many unrelated households could overwrite it --
 * including writing pushEnabled:false and silently killing the real
 * household's security notifications.
 *
 * Two earlier attempts at this were defeated in review, both the same way:
 *  A. write a malformed record so the read returns null, then walk a branch
 *     that treats "no record" as "allowed".
 *  B. write a record whose verifier the attacker chose, locking the real
 *     household out of its own slot.
 * Both are asserted against here, and both must FAIL to get through.
 *
 * Run: node tests/writeauth.mjs
 */
import path from 'path';
import { fileURLToPath } from 'url';
import * as configPut from '../functions/api/config/index.js';
import { getHouseholdConfig } from '../functions/_lib/householdConfig.js';

let PASS = 0, FAIL = 0;
const check = (l, c, x = '') => { c ? PASS++ : FAIL++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${x ? `  ${x}` : ''}`); };

function makeKV() {
  const m = new Map();
  return { _m: m,
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { m.set(k, v); },
  };
}
const env = (kv) => ({ HESTIA_KV: kv });
const req = (body, ip = '203.0.113.9') => new Request('https://hestari.com/api/config', {
  method: 'PUT', headers: { 'CF-Connecting-IP': ip, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const put = (kv, body, ip) => configPut.onRequestPut({ request: req(body, ip), env: env(kv) });

async function sha256Hex(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s)));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}
async function deriveKey(seed, usage) {
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed + ':hestia-cloud-sync'));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, usage);
}
async function encryptFor(seed, obj) {
  const key = await deriveKey(seed, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key,
    new TextEncoder().encode(JSON.stringify(obj))));
  return { iv: btoa(String.fromCharCode(...iv)), data: btoa(String.fromCharCode(...ct)) };
}

const OWNER_TOKEN = 'owner-maker-token-uuid';
const EVIL_TOKEN  = 'attacker-chosen-token';
const IP = '203.0.113.9';

const record = async (tokenHash, extra = {}) => ({
  encrypted: true,
  payload: { iv: btoa('0'.repeat(12)), data: btoa('ciphertext-the-server-cannot-read') },
  service: { tokenHash, pushEnabled: true, ...extra },
});

console.log('=== 1. First write: trust on first use ===');
{
  const kv = makeKV();
  /* MUST send `token`, exactly as the real client does on every write.
     An earlier version of this block omitted it, so the "raw token is NOT
     persisted" assertion below held vacuously -- `stored.token` was undefined
     because nothing ever sent one. Deleting the server's `delete body.token`
     line therefore survived this suite, storing the raw Maker API token in the
     plaintext half that discover.js serves to any IP neighbour. That single
     mutation collapses the entire point of the split. */
  // BOTH proofs are sent, exactly as the real client sends them, so neither
  // "is not persisted" assertion below can hold vacuously.
  const r = await put(kv, { ...(await record(await sha256Hex(OWNER_TOKEN))),
                            token: OWNER_TOKEN, secretProof: 'e'.repeat(64) });
  check('empty slot accepts the first write', r.status === 200, `HTTP ${r.status}`);
  check('the record was actually stored', kv._m.has(`ip:${(await sha256Hex(IP)).substring(0,16)}`));
  const stored = JSON.parse(kv._m.get(`ip:${(await sha256Hex(IP)).substring(0,16)}`));
  check('the raw token is NOT persisted', stored.token === undefined,
    'discover.js serves this record verbatim to any IP neighbour');
  check('the secret proof is NOT persisted either', stored.secretProof === undefined,
    'it is the recovery credential — storing it beside the ciphertext hands it over');
  check('the service half survived', !!(stored.service && stored.service.tokenHash));
}

console.log('\n=== 1b. A claimed verifier must match the presented token ===');
{
  const kv = makeKV();
  // Readable record carrying no verifier: the attacker tries to install one.
  const shortHash = (await sha256Hex(IP)).substring(0, 16);
  kv._m.set(`ip:${shortHash}`, JSON.stringify({
    encrypted: true, payload: { iv: btoa('0'.repeat(12)), data: btoa('x') },
    service: { pushEnabled: true },      // present, but no tokenHash
  }));
  const bogus = await put(kv, { ...(await record(await sha256Hex(EVIL_TOKEN))) });
  check('claiming a verifier without proving it → 401', bogus.status === 401, `HTTP ${bogus.status}`);

  const mismatched = await put(kv, { ...(await record(await sha256Hex(EVIL_TOKEN))), token: OWNER_TOKEN });
  check('claiming a verifier that does not match the token → 401',
    mismatched.status === 401, `HTTP ${mismatched.status}`);

  const honest = await put(kv, { ...(await record(await sha256Hex(OWNER_TOKEN))), token: OWNER_TOKEN });
  check('a matching pair claims the slot', honest.status === 200, `HTTP ${honest.status}`);
}

/* Round 13. Section 1b above proved a MISMATCHED attacker pair is refused, and
   that a matching pair claims a virgin slot. It never tried a SELF-CONSISTENT
   attacker pair against a household that had already established a recovery
   verifier -- and that was the whole attack, so all 290 tests passed over it.

   The attacker supplies both halves, so "does the claimed verifier match the
   presented token" is trivially true for any pair they invent. The only thing
   that still identifies the household at that moment is its wcap entry. */
console.log('\n=== 1d. Attack B: a self-consistent attacker pair vs. an established household ===');
{
  const kv = makeKV();
  const shortHash = (await sha256Hex(IP)).substring(0, 16);
  const OWNER_PROOF = 'a'.repeat(64);
  const EVIL_PROOF  = 'b'.repeat(64);

  /* Step 1: an ordinary, reachable state. The household holds a cloudSecret
     (so it sends secretProof, establishing wcap) but its Maker token is not
     set yet -- mid-onboarding is enough, since saveConfigToHub() mints the
     secret on any accepted hub write whether or not a token is present. The
     record therefore carries service.tokenHash = null. */
  const seed = await put(kv, {
    ...(await record(null)), secretProof: OWNER_PROOF });
  check('a household with a secret but no token can still save', seed.status === 200, `HTTP ${seed.status}`);
  check('...and that established its recovery verifier',
    kv._m.get(`wcap:${shortHash}`) === OWNER_PROOF);
  check('...over a record carrying no token verifier',
    JSON.parse(kv._m.get(`ip:${shortHash}`)).service.tokenHash === null);

  // Step 2: the neighbour invents a token AND the hash of that same token.
  const hijack = await put(kv, {
    ...(await record(await sha256Hex(EVIL_TOKEN), { pushEnabled: false })),
    token: EVIL_TOKEN, secretProof: EVIL_PROOF });
  check('a self-consistent attacker pair is REFUSED once a verifier exists',
    hijack.status === 401, `HTTP ${hijack.status} — an IP neighbour just took the record`);

  const after = JSON.parse(kv._m.get(`ip:${shortHash}`));
  check('the attacker did not install their own tokenHash',
    after.service.tokenHash === null);
  check('the attacker did not disable push',
    after.service.pushEnabled === true,
    'pushEnabled:false silently kills every security notification');
  check('the attacker did not replace the recovery verifier',
    kv._m.get(`wcap:${shortHash}`) === OWNER_PROOF,
    'replacing it locks the real household out durably, past the record TTL');

  // Step 3: the real household is still able to write. A fix that refused
  // everyone here would be a lockout wearing a fix's clothes.
  const owner = await put(kv, {
    ...(await record(await sha256Hex(OWNER_TOKEN))),
    token: OWNER_TOKEN, secretProof: OWNER_PROOF });
  check('the real household can still claim its slot', owner.status === 200, `HTTP ${owner.status}`);
  check('...and its verifier is now recorded',
    JSON.parse(kv._m.get(`ip:${shortHash}`)).service.tokenHash === await sha256Hex(OWNER_TOKEN));
}

console.log('\n=== 1e. A genuinely virgin household may still establish a verifier ===');
{
  // The fix must gate on "a verifier exists", not on "the record is readable".
  // With no wcap and no tokenHash there is nothing to authenticate against,
  // and refusing would strand a household that never had a secret.
  const kv = makeKV();
  const shortHash = (await sha256Hex(IP)).substring(0, 16);
  kv._m.set(`ip:${shortHash}`, JSON.stringify({
    encrypted: true, payload: { iv: btoa('0'.repeat(12)), data: btoa('x') },
    service: { pushEnabled: true },
  }));
  check('no recovery verifier exists for this household', !kv._m.has(`wcap:${shortHash}`));
  const claim = await put(kv, {
    ...(await record(await sha256Hex(OWNER_TOKEN))), token: OWNER_TOKEN });
  check('a matching pair still claims an unverified slot', claim.status === 200, `HTTP ${claim.status}`);
}

console.log('\n=== 1f. An expired record must not cost the household its recovery verifier ===');
{
  /* The record's TTL is 30 days, the verifier's is 60. A household quiet long
     enough for the record to lapse still holds a live verifier -- but the slot
     is now empty, so the next writer is accepted on trust-on-first-use. If that
     write also refreshed the verifier, a neighbour would take the record AND
     destroy the household's only way back in. Losing the slot in that window is
     unavoidable (an empty slot really is anonymous); losing the credential is
     not. */
  const kv = makeKV();
  const shortHash = (await sha256Hex(IP)).substring(0, 16);
  const OWNER_PROOF = 'a'.repeat(64);
  const EVIL_PROOF  = 'b'.repeat(64);

  await put(kv, { ...(await record(await sha256Hex(OWNER_TOKEN))),
                  token: OWNER_TOKEN, secretProof: OWNER_PROOF });
  check('the household established a verifier', kv._m.get(`wcap:${shortHash}`) === OWNER_PROOF);

  // The record lapses. The verifier, on a longer TTL, does not.
  kv._m.delete(`ip:${shortHash}`);

  const squat = await put(kv, { ...(await record(await sha256Hex(EVIL_TOKEN))),
                                token: EVIL_TOKEN, secretProof: EVIL_PROOF });
  check('the empty slot is claimable — TOFU, and honestly unavoidable', squat.status === 200,
    `HTTP ${squat.status}`);
  check('but the household KEEPS its recovery verifier',
    kv._m.get(`wcap:${shortHash}`) === OWNER_PROOF,
    'losing this is what turns a lapsed record into a permanent lockout');

  // And that is what lets them take it back.
  const reclaim = await put(kv, { ...(await record(await sha256Hex(OWNER_TOKEN))),
                                  token: OWNER_TOKEN, secretProof: OWNER_PROOF });
  check('so the real household reclaims its record', reclaim.status === 200, `HTTP ${reclaim.status}`);
  check('...and the squatter is locked back out',
    (await put(kv, { ...(await record(await sha256Hex(EVIL_TOKEN))),
                     token: EVIL_TOKEN, secretProof: EVIL_PROOF })).status === 401);
}

console.log('\n=== 1g. A legitimate secret rotation must still be able to replace the verifier ===');
{
  // The gate above must not freeze the verifier permanently. Proving the
  // current one, or the Maker token in the stored record, still rotates it.
  const kv = makeKV();
  const shortHash = (await sha256Hex(IP)).substring(0, 16);
  const OLD = 'a'.repeat(64), NEW = 'c'.repeat(64);

  await put(kv, { ...(await record(await sha256Hex(OWNER_TOKEN))),
                  token: OWNER_TOKEN, secretProof: OLD });

  const viaSecret = await put(kv, { ...(await record(await sha256Hex(OWNER_TOKEN))),
                                    token: OWNER_TOKEN, secretProof: OLD });
  check('proving the current verifier is accepted', viaSecret.status === 200, `HTTP ${viaSecret.status}`);

  const rotated = await put(kv, { ...(await record(await sha256Hex(OWNER_TOKEN))),
                                  token: OWNER_TOKEN, secretProof: NEW });
  check('proving the Maker token rotates the verifier to a new secret',
    rotated.status === 200 && kv._m.get(`wcap:${shortHash}`) === NEW,
    `HTTP ${rotated.status}, wcap=${String(kv._m.get(`wcap:${shortHash}`)).slice(0, 8)}…`);
}

console.log('\n=== 1c. Rotating the Maker token must not lock the household out ===');
{
  const kv = makeKV();
  const SECRET_PROOF = await sha256Hex('c'.repeat(64));
  await put(kv, { ...(await record(await sha256Hex(OWNER_TOKEN))), token: OWNER_TOKEN, secretProof: SECRET_PROOF });
  check('the recovery verifier is stored somewhere discover.js cannot reach',
    kv._m.has(`wcap:${(await sha256Hex(IP)).substring(0,16)}`),
    'beside the ciphertext it would be served straight to the neighbour');

  const ROTATED = 'rotated-maker-token';
  const noProof = await put(kv, { ...(await record(await sha256Hex(ROTATED))), token: ROTATED });
  check('the rotated token alone is rejected', noProof.status === 401, `HTTP ${noProof.status}`);

  const withProof = await put(kv, {
    ...(await record(await sha256Hex(ROTATED))), token: ROTATED, secretProof: SECRET_PROOF });
  check('the household secret gets them back in', withProof.status === 200, `HTTP ${withProof.status}`);

  const after = JSON.parse(kv._m.get(`ip:${(await sha256Hex(IP)).substring(0,16)}`));
  check('and the verifier is now the rotated token',
    after.service.tokenHash === await sha256Hex(ROTATED));

  const evil = await put(kv, {
    ...(await record(await sha256Hex(EVIL_TOKEN))), token: EVIL_TOKEN, secretProof: 'f'.repeat(64) });
  check('a wrong secret proof does not work', evil.status === 401, `HTTP ${evil.status}`);
}

console.log('\n=== 2. Subsequent writes require the token ===');
{
  const kv = makeKV();
  await put(kv, await record(await sha256Hex(OWNER_TOKEN)));

  const noTok = await put(kv, await record(await sha256Hex(EVIL_TOKEN)));
  check('no token → 401', noTok.status === 401, `HTTP ${noTok.status}`);

  const wrongTok = await put(kv, { ...(await record(await sha256Hex(EVIL_TOKEN))), token: EVIL_TOKEN });
  check('wrong token → 401', wrongTok.status === 401, `HTTP ${wrongTok.status}`);

  const rightTok = await put(kv, { ...(await record(await sha256Hex(OWNER_TOKEN))), token: OWNER_TOKEN });
  check('correct token → 200', rightTok.status === 200, `HTTP ${rightTok.status}`);
}

console.log('\n=== 3. ATTACK B — attacker cannot install their own verifier ===');
{
  const kv = makeKV();
  await put(kv, { ...(await record(await sha256Hex(OWNER_TOKEN))), token: OWNER_TOKEN });

  // Attacker shares the IP and tries to claim the slot with their own token.
  const evil = await put(kv, { ...(await record(await sha256Hex(EVIL_TOKEN))), token: EVIL_TOKEN });
  check('attacker cannot overwrite the verifier', evil.status === 401, `HTTP ${evil.status}`);

  const stored = JSON.parse([...kv._m.values()][0]);
  check('the stored verifier is still the owner\'s',
    stored.service.tokenHash === await sha256Hex(OWNER_TOKEN));

  const owner = await put(kv, { ...(await record(await sha256Hex(OWNER_TOKEN))), token: OWNER_TOKEN });
  check('the real household is NOT locked out', owner.status === 200, `HTTP ${owner.status}`);

  // The specific harm: silently disabling the household's notifications.
  const kill = await put(kv, { ...(await record(await sha256Hex(OWNER_TOKEN), { pushEnabled: false })) });
  check('attacker cannot write pushEnabled:false', kill.status === 401, `HTTP ${kill.status}`);
  const after = JSON.parse([...kv._m.values()][0]);
  check('push is still enabled for the household', after.service.pushEnabled === true);
}

console.log('\n=== 4. ATTACK A — a malformed record must not become a free claim ===');
{
  const kv = makeKV();
  await put(kv, { ...(await record(await sha256Hex(OWNER_TOKEN))), token: OWNER_TOKEN });

  // Corrupt the stored record so the read side cannot interpret it.
  const key = [...kv._m.keys()][0];
  kv._m.set(key, JSON.stringify({ encrypted: true, payload: { iv: 'AAAA', data: 'AAAA' } }));
  check('the corrupted record really is unreadable',
    (await getHouseholdConfig(env(kv), IP, key.slice(3))) === null);

  const grab = await put(kv, await record(await sha256Hex(EVIL_TOKEN)));
  check('unreadable record REFUSES the write rather than allowing it',
    grab.status === 409, `HTTP ${grab.status}`);
  check('the slot was not taken over',
    JSON.parse(kv._m.get(key)).service === undefined);

  /* The record above is valid JSON that merely fails to decrypt. A record that
     is not JSON at all takes a DIFFERENT branch (householdConfig's JSON.parse
     catch), and a mutation sweep showed nothing constrained it: making that
     catch return an empty config instead of null survived a green run. With an
     empty config there is no tokenHash, so the write falls through to the
     establish-a-verifier path and a self-consistent attacker pair claims the
     slot -- Attack A and Attack B chained. */
  kv._m.set(key, 'this is not json at all{{{');
  check('a non-JSON record is also unreadable',
    (await getHouseholdConfig(env(kv), IP, key.slice(3))) === null);

  const chained = await put(kv, {
    ...(await record(await sha256Hex(EVIL_TOKEN))), token: EVIL_TOKEN, secretProof: 'f'.repeat(64) });
  check('a non-JSON record REFUSES a self-consistent attacker pair',
    chained.status === 409, `HTTP ${chained.status}`);
  check('and no recovery verifier was installed off the back of it',
    !kv._m.has(`wcap:${key.slice(3)}`));
}

console.log('\n=== 5. Migration: a legacy record seeds its own verifier ===');
{
  const kv = makeKV();
  const shortHash = (await sha256Hex(IP)).substring(0, 16);
  // A record written before any of this: whole config encrypted under the old
  // IP-derived key, with the raw token inside it.
  const legacyInner = { config: { config: { token: OWNER_TOKEN, pushEnabled: true }, savedAt: 1 }, savedAt: 1 };
  kv._m.set(`ip:${shortHash}`, JSON.stringify({ encrypted: true, payload: await encryptFor(IP, legacyInner) }));

  const hh = await getHouseholdConfig(env(kv), IP, shortHash);
  check('legacy record is readable', !!hh && hh.legacy === true);
  check('and its verifier is DERIVED from the stored token, not supplied',
    hh.config.tokenHash === await sha256Hex(OWNER_TOKEN),
    'seeding from the request would be the land-grab');

  const evil = await put(kv, { ...(await record(await sha256Hex(EVIL_TOKEN))), token: EVIL_TOKEN });
  check('an attacker cannot migrate a legacy record to their own token',
    evil.status === 401, `HTTP ${evil.status}`);

  const owner = await put(kv, { ...(await record(await sha256Hex(OWNER_TOKEN))), token: OWNER_TOKEN });
  check('the real owner migrates it cleanly', owner.status === 200, `HTTP ${owner.status}`);
  const after = JSON.parse(kv._m.get(`ip:${shortHash}`));
  check('and the record is now the new shape', !!after.service);
}

console.log('\n=== 5b. A rejected caller cannot install a recovery credential ===');
{
  const kv = makeKV();
  const shortHash = (await sha256Hex(IP)).substring(0, 16);
  await put(kv, { ...(await record(await sha256Hex(OWNER_TOKEN))), token: OWNER_TOKEN });

  // Attacker tries to write, and to plant their own secretProof on the way.
  const evil = await put(kv, { ...(await record(await sha256Hex(EVIL_TOKEN))),
                               token: EVIL_TOKEN, secretProof: 'f'.repeat(64) });
  check('the write is rejected', evil.status === 401, `HTTP ${evil.status}`);
  check('and NO recovery credential was recorded',
    !kv._m.has(`wcap:${shortHash}`),
    'recording it before authorising would let an attacker install their own way back in');

  // The owner's proof is recorded only because their write was authorised.
  await put(kv, { ...(await record(await sha256Hex(OWNER_TOKEN))),
                  token: OWNER_TOKEN, secretProof: 'a'.repeat(64) });
  check('an authorised write does record one', kv._m.get(`wcap:${shortHash}`) === 'a'.repeat(64));
}

console.log('\n=== 5c. armed.js and send.js authenticate on the token hash ===');
{
  const armed = await import('../functions/api/push/armed.js');
  const send  = await import('../functions/api/push/send.js');

  const kvWith = async () => {
    const kv = makeKV();
    const shortHash = (await sha256Hex(IP)).substring(0, 16);
    kv._m.set(`ip:${shortHash}`, JSON.stringify({
      encrypted: true, payload: { iv: btoa('0'.repeat(12)), data: btoa('x') },
      service: { tokenHash: await sha256Hex(OWNER_TOKEN), pushEnabled: true },
    }));
    return kv;
  };
  const post = (mod, kv, body) => mod.onRequestPost({
    request: new Request('https://hestari.com/api/push/x', {
      method: 'POST', headers: { 'CF-Connecting-IP': IP, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env: { HESTIA_KV: kv, VAPID_PRIVATE_KEY: 'x' },
  });

  for (const [name, mod, body] of [
    ['armed.js', armed, { armed: true }],
    ['send.js',  send,  { category: 'test', title: 'T', body: 'B', armed: true }],
  ]) {
    const okRes = await post(mod, await kvWith(), { ...body, token: OWNER_TOKEN });
    check(`${name}: the real hub's token is accepted`, okRes.status !== 401, `HTTP ${okRes.status}`);

    const badRes = await post(mod, await kvWith(), { ...body, token: EVIL_TOKEN });
    check(`${name}: a wrong token is rejected`, badRes.status === 401, `HTTP ${badRes.status}`);

    const noneRes = await post(mod, await kvWith(), body);
    check(`${name}: no token is rejected`, noneRes.status === 401 || noneRes.status === 400,
      `HTTP ${noneRes.status}`);

    // The hash must not be replayable as if it were the token.
    const replay = await post(mod, await kvWith(), { ...body, token: await sha256Hex(OWNER_TOKEN) });
    check(`${name}: replaying the stored hash as a token is rejected`, replay.status === 401,
      `HTTP ${replay.status}`);
  }
}

console.log('\n=== 6. Shape validation still holds ===');
{
  const kv = makeKV();
  for (const [label, body] of [
    ['not encrypted',        { payload: { iv: 'a', data: 'b' } }],
    ['missing payload',      { encrypted: true }],
    ['payload not an object',{ encrypted: true, payload: 'x' }],
    ['service is an array',  { encrypted: true, payload: { iv: 'a', data: 'b' }, service: [] }],
  ]) {
    const r = await put(kv, body);
    check(`${label} → 400`, r.status === 400, `HTTP ${r.status}`);
  }
  check('nothing was written by any malformed request', kv._m.size === 0);
}

console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL ? 1 : 0);

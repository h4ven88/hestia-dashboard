/* Does the projected cloud payload make the Cloudflare Workers behave
 * IDENTICALLY to the full config?
 *
 * This is the test whose absence caused the last revert. The old suite proved
 * the projection's *contents* (no secrets present) and never proved its
 * *consumers* still worked, so a projection that silently dropped a field the
 * webhook reads passed everything and broke push in production.
 *
 * So this asserts equivalence, not presence: for a large matrix of real device
 * events, the decision the Workers reach from the projection must equal the
 * decision they reach from the full config. A dropped field fails on a
 * concrete event with a readable name, not on a key count.
 *
 * Extracts the REAL categorize()/describeEvent()/pushAllowed() out of
 * webhook.js rather than restating them.
 *
 * Run: node tests/projection-equivalence.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'functions/api/push/webhook.js'), 'utf8');

function extract(name) {
  const m = new RegExp('function ' + name + '\\s*\\(').exec(SRC);
  if (!m) throw new Error('missing ' + name + ' in webhook.js');
  let d = 0;
  for (let j = SRC.indexOf('{', m.index); j < SRC.length; j++) {
    if (SRC[j] === '{') d++;
    else if (SRC[j] === '}' && --d === 0) return SRC.slice(m.index, j + 1);
  }
}
const W = new Function(`
  ${extract('categorize')}
  ${extract('describeEvent')}
  ${extract('pushAllowed')}
  return { categorize, describeEvent, pushAllowed };
`)();

/* ── the REAL shipped projection ─────────────────────────────────────────
   Extracted from dashboard.html, not restated. A restated copy only proves
   that two copies of my assumptions agree, which is precisely how the last
   attempt passed its tests and broke in production. */
const DASH = fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf8');
function extractFrom(src, name) {
  const m = new RegExp('(async )?function ' + name + '\\s*\\(').exec(src);
  if (!m) throw new Error('missing ' + name + ' in dashboard.html');
  let d = 0;
  for (let j = src.indexOf('{', m.index); j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}' && --d === 0) return src.slice(m.index, j + 1);
  }
}
const buildServiceHalf = new Function(`
  ${extractFrom(DASH, 'buildServiceHalf')}
  return buildServiceHalf;
`)();
const projectService = (c) => buildServiceHalf(c, 'sha256-of-token');

let PASS = 0, FAIL = 0;
const check = (l, c, x = '') => { c ? PASS++ : FAIL++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${x ? `  ${x}` : ''}`); };

/* ── a full config with every category populated ─────────────────────── */
const FULL = {
  hub: 'https://192.168.50.139:8443', appId: '219', token: 'maker-token-uuid',
  settingsPin: 'hash', artemisPin: 'hash', pinInstallSalt: 'salt',
  athenaApiKey: 'sk-ant-secret', athenaGoogleApiKey: 'AIza-secret',
  cameras: [{ name: 'Porch', snapshotUrl: 'http://cam/x.jpg' }],
  reminders: [{ id: 1, text: 'private' }], routines: [{ id: 1, name: 'Goodnight' }],
  artemisSensors: {
    contacts: [
      { id: 21, subtype: 'door',   name: 'Front Door',    room: 'ROOMSENTINEL1' },
      { id: 22, subtype: 'window', name: 'Kitchen Window', room: 'ROOMSENTINEL2' },
      { id: 23, subtype: undefined, name: 'Unlabelled Contact' },
    ],
    motions: [{ id: 31, name: 'Hall Motion' }, { id: 32, name: 'Garage Motion' }],
    smokes:  [{ id: 41, name: 'Upstairs Smoke' }],
    waters:  [{ id: 51, name: 'Basement Leak' }],
    // Present locally, read by NO Worker. Must not change any decision.
    glass:   [{ id: 61, name: 'Living Room Glass' }],
  },
  locks: [{ id: 13, label: 'Front Door Lock', room: 'ROOMSENTINEL3' },
          { id: 14, label: 'Back Door Lock',  room: 'ROOMSENTINEL4' }],
  pushEnabled: true,
  pushDoors: true, pushWindows: false, pushLocks: true,
  pushMotion: true, pushMotionDevices: [31],
  pushSmoke: true, pushWater: false,
  pushOpen: true, pushClose: false,
  pushAlarming: true, pushArmStatus: true,
  announceDoors: true, announceMotion: true,
  rooms: [{ name: 'Master Bedroom' }], tempUnit: 'F',
};

/* ── the event matrix ────────────────────────────────────────────────── */
const DEVICE_IDS = [21, 22, 23, 31, 32, 41, 51, 61, 13, 14, 999];
const ATTRS = [
  ['contact', 'open'], ['contact', 'closed'],
  ['lock', 'locked'], ['lock', 'unlocked'],
  ['motion', 'active'], ['motion', 'inactive'],
  ['smoke', 'detected'], ['smoke', 'clear'],
  ['water', 'wet'], ['water', 'dry'],
  ['switch', 'on'],
];
const events = [];
for (const deviceId of DEVICE_IDS) {
  for (const [name, value] of ATTRS) {
    // displayName present and absent: categorize()'s name only surfaces as a
    // fallback (`evt.displayName || info.name`), so a dropped name is
    // invisible unless displayName is missing.
    events.push({ deviceId, name, value, displayName: 'Hub Label' });
    events.push({ deviceId, name, value });
  }
}

console.log(`=== Equivalence over ${events.length} events ===`);
{
  const service = projectService(FULL);
  const diffs = [];
  for (const evt of events) {
    const a = W.categorize(FULL, evt.deviceId);
    const b = W.categorize(service, evt.deviceId);
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      diffs.push(`categorize(${evt.deviceId}): ${JSON.stringify(a)} vs ${JSON.stringify(b)}`); continue;
    }
    if (!a) continue;
    const da = W.describeEvent(a, evt), db = W.describeEvent(b, evt);
    if (JSON.stringify(da) !== JSON.stringify(db)) {
      diffs.push(`describeEvent(${evt.deviceId},${evt.name}=${evt.value},dn=${!!evt.displayName}): ${JSON.stringify(da)} vs ${JSON.stringify(db)}`); continue;
    }
    if (!da) continue;
    const pa = W.pushAllowed(FULL, da, evt), pb = W.pushAllowed(service, da, evt);
    if (pa !== pb) diffs.push(`pushAllowed(${evt.deviceId},${evt.name}=${evt.value}): ${pa} vs ${pb}`);
  }
  check('every Worker decision is identical from the projection', diffs.length === 0,
    diffs.length ? `\n      ${diffs.slice(0, 8).join('\n      ')}` : `${events.length} events`);
}

console.log('\n=== The projection still reaches real decisions (not vacuously equal) ===');
{
  const service = projectService(FULL);
  const seen = new Set();
  let allowed = 0;
  for (const evt of events) {
    const info = W.categorize(service, evt.deviceId);
    if (!info) continue;
    const d = W.describeEvent(info, evt);
    if (!d) continue;
    seen.add(d.category);
    if (W.pushAllowed(service, d, evt)) allowed++;
  }
  check('all six push categories are exercised', seen.size === 6, [...seen].sort().join(','));
  check('some events are allowed and some denied', allowed > 0 && allowed < events.length,
    `${allowed} allowed`);
}

console.log('\n=== A dropped field must FAIL this suite, not pass it ===');
{
  // Mutants: each removes something a Worker reads. Every one must be caught.
  const mutants = {
    'sensor subtype dropped': (c) => { const s = projectService(c); s.artemisSensors.contacts.forEach(x => delete x.subtype); return s; },
    'sensor name dropped':    (c) => { const s = projectService(c); s.artemisSensors.contacts.forEach(x => delete x.name); return s; },
    'lock label dropped':     (c) => { const s = projectService(c); s.locks.forEach(x => delete x.label); return s; },
    'lock list dropped':      (c) => { const s = projectService(c); s.locks = []; return s; },
    'motions dropped':        (c) => { const s = projectService(c); s.artemisSensors.motions = []; return s; },
    'pushMotionDevices dropped': (c) => { const s = projectService(c); s.pushMotionDevices = []; return s; },
    'pushOpen dropped':       (c) => { const s = projectService(c); delete s.pushOpen; return s; },
    'pushClose dropped':      (c) => { const s = projectService(c); delete s.pushClose; return s; },
    'pushWindows dropped':    (c) => { const s = projectService(c); delete s.pushWindows; return s; },
    'pushWater dropped':      (c) => { const s = projectService(c); delete s.pushWater; return s; },
  };
  // Every push flag is read as `config.X !== false`, so dropping one whose
  // value is already true is genuinely equivalent and CANNOT be detected.
  // Each mutant therefore runs against both polarities; a flag is covered if
  // either polarity catches it. Testing only one polarity silently passes half
  // the flags, which is the shape of gap that caused the last revert.
  // pushAllowed() gates in two stages: the category flag, then the open/close
  // flag. With every flag false the category gate short-circuits and the
  // open/close flags are never reached, so a single all-false polarity cannot
  // exercise them. The cross product of {categories} x {open/close} can.
  const POLARITIES = [];
  for (const cat of [true, false]) {
    for (const oc of [true, false]) {
      POLARITIES.push([`cat=${cat} openclose=${oc}`, {
        pushDoors: cat, pushWindows: cat, pushLocks: cat, pushSmoke: cat, pushWater: cat,
        pushOpen: oc, pushClose: oc,
      }]);
    }
  }
  const detects = (base, mutate) => {
    const good = projectService(base), bad = mutate(base);
    for (const evt of events) {
      const a = W.categorize(good, evt.deviceId), b = W.categorize(bad, evt.deviceId);
      if (JSON.stringify(a) !== JSON.stringify(b)) return true;
      if (!a) continue;
      const da = W.describeEvent(a, evt), db = W.describeEvent(b, evt);
      if (JSON.stringify(da) !== JSON.stringify(db)) return true;
      if (!da) continue;
      if (W.pushAllowed(good, da, evt) !== W.pushAllowed(bad, da, evt)) return true;
    }
    return false;
  };
  const missed = [];
  for (const [label, mutate] of Object.entries(mutants)) {
    const caughtBy = POLARITIES.filter(([, flags]) => detects({ ...FULL, ...flags }, mutate));
    if (!caughtBy.length) missed.push(label);
  }
  check('every dropped-field mutant is detected in at least one polarity', missed.length === 0,
    missed.length ? missed.join('; ') : `${Object.keys(mutants).length} mutants, both polarities`);
}

console.log('\n=== Every config field the Worker SOURCE references must be present ===');
{
  /* The equivalence matrix above only covers the three functions it extracts.
     Fields read elsewhere in the handlers -- pushEnabled inside onRequestPost,
     the token comparison in armed.js and send.js -- are invisible to it, so a
     projection could drop them and still pass green. That is exactly the shape
     of gap that caused the last revert.

     So: scan the Worker sources for `config.<field>` and require each one to
     exist in the projection. Derived from source rather than hand-listed, so
     it cannot drift when a handler starts reading something new. */
  const WORKERS = ['functions/api/push/webhook.js', 'functions/api/push/armed.js', 'functions/api/push/send.js'];
  const referenced = new Set();
  for (const rel of WORKERS) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const m of src.matchAll(/\bconfig\.([A-Za-z_$][\w$]*)/g)) referenced.add(m[1]);
  }
  // `token` is deliberately NOT carried: it is replaced by tokenHash, and the
  // handlers change to hash what the caller sends. Everything else must be here.
  referenced.delete('token');

  const service = projectService(FULL);

  const missing = [...referenced].filter(k => !(k in service));
  check('every field the Worker sources read is in the service half',
    missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : `${referenced.size} fields: ${[...referenced].sort().join(', ')}`);
  check('tokenHash is carried (armed.js/send.js authenticate on it)',
    'tokenHash' in service);
  check('the raw token is NOT carried', !('token' in service));
}

console.log('\n=== Fields the Workers never read may be dropped freely ===');
{
  const service = projectService(FULL);
  const j = JSON.stringify(service);
  for (const [label, needle] of [
    ['Maker token', 'maker-token-uuid'], ['Anthropic key', 'sk-ant-secret'],
    ['Google key', 'AIza-secret'], ['PIN salt', 'salt'],
    ['camera URL', 'http://cam/x.jpg'], ['reminder text', 'private'],
    ['routine name', 'Goodnight'], ['room name', 'Master Bedroom'],
    ['hub URL', '192.168.50.139'], ['sensor/lock room', 'ROOMSENTINEL'],
  ]) check(`${label} absent from the service half`, !j.includes(needle));
  check('glass sensors absent (no Worker reads them)', !j.includes('Living Room Glass'));
  check('pushAlarming/pushArmStatus absent (gated in Groovy, not here)',
    service.pushAlarming === undefined && service.pushArmStatus === undefined);
}

console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL ? 1 : 0);

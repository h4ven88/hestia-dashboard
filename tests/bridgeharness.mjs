/* The native bridge shim, and the Phase 1 gate.
 *
 * THE GATE IS TWO STATES, NOT ONE. The plan said "the browser build is
 * provably unchanged with the bridge absent". Absent is the browser build and
 * is easy. But Phase 1 actually ships the bridge PRESENT AND EMPTY, and that
 * is the state that can regress, so both are asserted and required to behave
 * identically.
 *
 * Run: node tests/bridgeharness.mjs
 */
import { readFileSync } from 'fs';

const SHIM = readFileSync(new URL('../android/bridge/hestia-bridge.js', import.meta.url), 'utf8');
const DASH = readFileSync(new URL('../dashboard.html', import.meta.url), 'utf8');

let PASS = 0, FAIL = 0;
const check = (l, c, x = '') => { c ? PASS++ : FAIL++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${x ? `  ${x}` : ''}`); };

/* A fake WebView window plus the raw Android object. The raw object mirrors
   what @JavascriptInterface can actually do: synchronous, String in and String
   out, no Promises, and no way to call back except through the dispatcher. */
function makeWindow({ handshake, onCall } = {}) {
  const win = { console: { warn() {}, log() {} } };
  const sent = [];
  if (handshake !== null) {
    win.__hestiaNativeRaw = {
      handshake: () => (typeof handshake === 'string' ? handshake : JSON.stringify(
        handshake || { version: 1, platform: 'android', appVersion: '2.2.0', capabilities: [] })),
      call: (json) => { sent.push(JSON.parse(json)); return onCall ? onCall(JSON.parse(json)) : ''; },
    };
  }
  const fn = new Function('window', 'console', 'Promise', 'JSON', 'Object', 'String', 'Error', SHIM);
  fn(win, win.console, Promise, JSON, Object, String, Error);
  return { win, sent };
}

console.log('=== 1. With no bridge present, nothing is installed ===');
{
  const { win } = makeWindow({ handshake: null });
  check('window.hestiaNative is not created',
    win.hestiaNative === undefined,
    'the page must look exactly like the browser build, not like a bridge that answers nothing');
  check('...and no dispatcher is left behind either',
    win.__hestiaNativeSettle === undefined && win.__hestiaNativeEmit === undefined);
}

console.log('\n=== 2. A malformed or half-present bridge installs nothing ===');
{
  /* A stub would be worse than absence: the page branches on existence and
     then finds nothing behind it. */
  const bad = makeWindow({ handshake: 'not json at all' });
  check('an unreadable handshake installs nothing', bad.win.hestiaNative === undefined);

  const win2 = { console: { warn() {} } };
  win2.__hestiaNativeRaw = { handshake: () => '{}' };   // no call()
  new Function('window', 'console', 'Promise', 'JSON', 'Object', 'String', 'Error', SHIM)(
    win2, win2.console, Promise, JSON, Object, String, Error);
  check('a raw object missing call() installs nothing', win2.hestiaNative === undefined);
}

console.log('\n=== 3. Present and EMPTY: the state Phase 1 actually ships ===');
{
  const { win } = makeWindow();
  check('the contract exists', typeof win.hestiaNative === 'object' && win.hestiaNative !== null);
  check('capabilities is empty',
    Array.isArray(win.hestiaNative.capabilities) && win.hestiaNative.capabilities.length === 0,
    'Phase 1 is the contract, not the capabilities');
  check('...and is frozen, so nothing can widen what the page believes it has',
    Object.isFrozen(win.hestiaNative.capabilities));
  check('no capability METHODS are exposed',
    ['hub', 'mic', 'notify', 'push', 'net'].every(k => win.hestiaNative[k] === undefined),
    'each arrives in its own phase, behind its own capability string');
  check('the object itself is frozen', Object.isFrozen(win.hestiaNative));

  /* A later script replacing the bridge would be a trivial way to intercept
     everything the page later asks native to do. */
  try { win.hestiaNative = { capabilities: ['hub'] }; } catch (e) {}
  check('and window.hestiaNative cannot be reassigned',
    win.hestiaNative.capabilities.length === 0);
}

console.log('\n=== 4. The page branches on CAPABILITY, never on platform ===');
{
  /* This is the rule that keeps one web layer instead of five. iOS and the
     desktop targets implement subsets; Linux ships as a kiosk browser with no
     bridge at all. Branching on platform means editing dashboard.html for
     every new target. */
  const code = DASH.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('dashboard.html never reads hestiaNative.platform',
    !/hestiaNative\s*\.\s*platform/.test(code),
    'platform is for bug reports, not behaviour');
  check('...and never compares it to a platform name',
    !/platform\s*===\s*['"]android['"]/.test(code));
}

console.log('\n=== 5. Calls are async, settled only through the dispatcher ===');
{
  const { win, sent } = makeWindow();
  const p = win.hestiaNative.call('hub.request', { path: '/devices' });
  check('a call returns a Promise', typeof p.then === 'function');
  check('...and reaches native as one JSON request with an id',
    sent.length === 1 && typeof sent[0].id === 'string' && sent[0].method === 'hub.request',
    JSON.stringify(sent[0]));

  let settled = null;
  p.then(v => { settled = { ok: v }; }, e => { settled = { err: e.message }; });
  win.__hestiaNativeSettle(JSON.stringify({ id: sent[0].id, result: { status: 200 } }));
  await Promise.resolve(); await Promise.resolve();
  check('...and settles when native replies', settled && settled.ok && settled.ok.status === 200,
    JSON.stringify(settled));

  // A second reply must not resurrect a settled call.
  win.__hestiaNativeSettle(JSON.stringify({ id: sent[0].id, error: 'late' }));
  await Promise.resolve();
  check('a duplicate reply is ignored', settled.ok !== undefined && settled.err === undefined);
}

console.log('\n=== 6. A call that native refuses outright still settles ===');
{
  /* Without this the page holds a Promise nothing will ever resolve, which is
     a hang rather than an error, and a hang in a settings save or an arm
     command is the worst shape of failure available. */
  const { win } = makeWindow({ onCall: () => JSON.stringify({ error: 'unknown method' }) });
  let out = null;
  win.hestiaNative.call('nope').then(v => { out = { ok: v }; }, e => { out = { err: e.message }; });
  await Promise.resolve(); await Promise.resolve();
  check('a synchronous refusal rejects immediately', out && out.err === 'unknown method', JSON.stringify(out));

  const thrower = makeWindow({ onCall: () => { throw new Error('bridge died'); } });
  let out2 = null;
  thrower.win.hestiaNative.call('x').then(v => { out2 = { ok: v }; }, e => { out2 = { err: e.message }; });
  await Promise.resolve(); await Promise.resolve();
  check('...and a raw interface that throws rejects rather than hanging',
    out2 && /bridge died/.test(out2.err), JSON.stringify(out2));
}

console.log('\n=== 7. Events arrive on one channel and unsubscribe cleanly ===');
{
  const { win } = makeWindow();
  const seen = [];
  const off = win.hestiaNative.on('push', d => seen.push(d));
  win.__hestiaNativeEmit(JSON.stringify({ event: 'push', data: { title: 'Door' } }));
  check('a subscriber receives its event', seen.length === 1 && seen[0].title === 'Door');

  win.__hestiaNativeEmit(JSON.stringify({ event: 'micState', data: { on: false } }));
  check('...and not somebody else\'s', seen.length === 1);

  off();
  win.__hestiaNativeEmit(JSON.stringify({ event: 'push', data: { title: 'Again' } }));
  check('unsubscribing works', seen.length === 1);

  /* A handler that throws must not stop the others. On a security product the
     others might be the alarm. */
  const w2 = makeWindow().win;
  const got = [];
  w2.hestiaNative.on('push', () => { throw new Error('bad listener'); });
  w2.hestiaNative.on('push', d => got.push(d));
  w2.__hestiaNativeEmit(JSON.stringify({ event: 'push', data: 1 }));
  check('one throwing listener does not block the rest', got.length === 1);

  // A handler that unsubscribes mid-dispatch must not make the loop skip one.
  const w3 = makeWindow().win;
  const order = [];
  const offA = w3.hestiaNative.on('e', () => { order.push('a'); offA(); });
  w3.hestiaNative.on('e', () => order.push('b'));
  w3.__hestiaNativeEmit(JSON.stringify({ event: 'e' }));
  check('unsubscribing during dispatch does not skip the next listener',
    order.join('') === 'ab', order.join(''));
}

console.log('\n=== 8. Installing twice is a no-op ===');
{
  const { win } = makeWindow();
  const first = win.hestiaNative;
  new Function('window', 'console', 'Promise', 'JSON', 'Object', 'String', 'Error', SHIM)(
    win, win.console, Promise, JSON, Object, String, Error);
  check('a second injection leaves the original in place',
    win.hestiaNative === first,
    'reinjection on a client-side navigation would otherwise orphan every pending call');
}

console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL ? 1 : 0);

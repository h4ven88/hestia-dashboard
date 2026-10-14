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

/* ═══════════════════════════════════════════════════════════════════════════
   PHASE 2: the hub relay, against the real functions from dashboard.html.

   Extracted rather than reimplemented. Two copies of the same assumption
   agreeing proves nothing, and this is the code path that decides whether a
   browser user's traffic changes at all.
   ═══════════════════════════════════════════════════════════════════════════ */

/* Captures the optional `async `, which a bare /function <name>\(/ would drop
   -- taking the keyword off an async function silently turns every `await`
   inside it into a syntax error. */
function extractFn(name) {
  const m = new RegExp('(async\\s+)?function\\s+' + name + '\\s*\\(').exec(DASH);
  if (!m) throw new Error('missing ' + name + ' in dashboard.html');
  let depth = 0;
  for (let j = DASH.indexOf('{', m.index); j < DASH.length; j++) {
    if (DASH[j] === '{') depth++;
    else if (DASH[j] === '}' && --depth === 0) return DASH.slice(m.index, j + 1);
  }
  throw new Error('unbalanced braces in ' + name);
}

/* Comments stripped before any assertion over source text. Three false greens
   in one release series came from a test matching the prose above the code it
   meant to check -- one of them was satisfied by a comment naming the very call
   that had been deleted. */
function codeOnlyJs(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, ' ')
          .split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
}

const RELAY_SRC = ['_originOf', 'nativeHub', 'nativeHubSync', '_nativeHubFetch',
  'hubFetch', '_fetchWithTimeout', '_relayBody'].map(extractFn).join('\n\n');

/* The sentinel is the whole trick for the browser-equivalence tests: if
   hubFetch returns the very object the stub fetch returned, it cannot have
   wrapped, retried or rerouted anything. */
const SENTINEL = { iAmTheBrowserResponse: true };

function relay({ capabilities = ['hub'], pinned = null, onRequest = null, infoThrows = false } = {}) {
  const calls = [];      // what reached "native"
  const fetches = [];    // what went out as an ordinary browser fetch
  // Mutable so a test can make a LATER hub.info fail after an earlier one
  // succeeded, which is the only way a stale pinned origin can exist.
  const ctl = { infoThrows };
  const win = {
    location: { href: 'https://appassets.androidplatform.net/assets/index.html' },
  };
  if (capabilities !== null) {
    win.hestiaNative = {
      capabilities,
      call(method, params) {
        calls.push({ method, params });
        if (method === 'hub.info') {
          return ctl.infoThrows ? Promise.reject(new Error('relay unavailable'))
                                : Promise.resolve({ origin: pinned, pinned: !!pinned });
        }
        if (method === 'hub.request') {
          return onRequest ? onRequest(params) : Promise.resolve({ status: 200, body: '{"ok":1}' });
        }
        return Promise.reject(new Error('no such capability: ' + method));
      },
    };
  }
  const fakeFetch = (url, opts) => { fetches.push({ url, opts }); return Promise.resolve(SENTINEL); };
  const api = new Function('window', 'console', 'URL', 'Response', 'TypeError', 'Number',
    'fetch', 'AbortController', 'setTimeout', 'clearTimeout', `
      let _nativeHubOrigin = null;
      ${RELAY_SRC}
      return { hubFetch, nativeHub, nativeHubSync, _originOf,
               pin(v) { _nativeHubOrigin = v; }, pinned() { return _nativeHubOrigin; } };
    `)(win, { log() {}, warn() {} }, URL, Response, TypeError, Number,
       fakeFetch, AbortController, setTimeout, clearTimeout);
  return { ...api, calls, fetches, win, ctl };
}

const HUB = 'https://192.168.50.139';
const MAKER = `${HUB}/apps/api/42/devices/all?access_token=abc123`;

console.log('\n=== 9. In a browser, hubFetch IS fetch ===');
{
  /* The load-bearing invariant. If this holds, a browser user cannot reach the
     relay code at all, so a defect in it has to surface in the app. */
  const noBridge = relay({ capabilities: null });
  const r1 = await noBridge.hubFetch(MAKER);
  check('with no bridge, the browser Response is returned untouched',
    r1 === SENTINEL, 'not wrapped, not re-created');
  check('...called with exactly the url and options it was given',
    noBridge.fetches.length === 1 && noBridge.fetches[0].url === MAKER &&
    noBridge.fetches[0].opts === undefined,
    JSON.stringify(noBridge.fetches[0]));

  /* Present-and-empty is what Phase 1 shipped to real devices, so it is the
     state that can regress, exactly as section 3 argues. */
  const empty = relay({ capabilities: [] });
  check('present-and-empty behaves identically',
    (await empty.hubFetch(MAKER)) === SENTINEL && empty.calls.length === 0);

  /* Capability, not bridge presence: a future build offering mic but not hub
     must still use the browser path for hub traffic. */
  const otherCap = relay({ capabilities: ['mic', 'notify'] });
  check('a bridge without the hub capability uses the browser path',
    (await otherCap.hubFetch(MAKER)) === SENTINEL && otherCap.calls.length === 0);

  const withTimeout = relay({ capabilities: null });
  await withTimeout.hubFetch(MAKER, null, 4000);
  check('a timeout is applied only when the caller asks for one',
    withTimeout.fetches.length === 1 && !!withTimeout.fetches[0].opts.signal,
    'hubStoreFetch relies on its 4s guard surviving this change');

  /* No caller does this TODAY -- the nine Maker API sites are all bare GETs and
     hubStoreFetch always passes a timeout. It is asserted because a doorway
     that silently drops a POST body is a defect waiting for its first caller,
     and the failure would look like a config save that reported success and
     changed nothing. Found by the mutation gate, not by review. */
  const untimedPost = relay({ capabilities: null });
  const postOpts = { method: 'POST', body: '{"a":1}' };
  await untimedPost.hubFetch(MAKER, postOpts);
  check('options survive the untimed browser path',
    untimedPost.fetches[0].opts === postOpts,
    'a dropped body would be a save that succeeds and writes nothing');
}

console.log('\n=== 10. In the app, the request is relayed over the pinned hub ===');
{
  const r = relay({ pinned: HUB });
  await r.nativeHubSync();
  const res = await r.hubFetch(MAKER);
  const sentReq = r.calls.find(c => c.method === 'hub.request');
  check('the request reaches native, not the network',
    !!sentReq && r.fetches.length === 0);

  /* THE ONE THAT WOULD BREAK EVERYTHING SILENTLY. apiUrl() puts the Maker API
     token in the query string, so dropping the search turns every single
     request into a 401 and the dashboard would look authenticated-but-empty. */
  check('the query string survives, token and all',
    sentReq.params.path === '/apps/api/42/devices/all?access_token=abc123',
    sentReq.params.path);
  check('it is a path, never an absolute url',
    sentReq.params.path.startsWith('/') && !/^https?:/.test(sentReq.params.path));
  check('the relayed reply is a real Response the caller can use',
    res.ok === true && res.status === 200);
  check('...with a readable body', (await res.json()).ok === 1);

  const post = relay({ pinned: HUB });
  await post.nativeHubSync();
  await post.hubFetch(`${HUB}/apps/api/42/config`, {
    method: 'POST', body: '{"a":1}', headers: { 'Content-Type': 'application/json' },
  });
  const p = post.calls.find(c => c.method === 'hub.request').params;
  check('method, body and content type are forwarded',
    p.method === 'POST' && p.body === '{"a":1}' && p.contentType === 'application/json',
    JSON.stringify(p));
}

console.log('\n=== 11. The relay refuses rather than guessing ===');
{
  /* hub.request takes a path and sends it to the origin NATIVE pinned. If the
     page asks for a different hub, relaying anyway would deliver the request
     to the wrong house while the UI reported the right one. */
  const wrong = relay({ pinned: HUB });
  await wrong.nativeHubSync();
  let err = null;
  await wrong.hubFetch('https://192.168.50.40/apps/api/42/devices/all').catch(e => { err = e; });
  check('an origin mismatch rejects', !!err, err && err.message);
  check('...and nothing is sent to the wrong hub',
    !wrong.calls.some(c => c.method === 'hub.request'),
    'silently-wrong-hub is worse than unreachable');

  const unpinned = relay({ pinned: null });
  await unpinned.nativeHubSync();
  let err2 = null;
  await unpinned.hubFetch(MAKER).catch(e => { err2 = e; });
  check('with nothing pinned yet it rejects like an unreachable hub',
    !!err2 && !unpinned.calls.some(c => c.method === 'hub.request'),
    'every existing "Hub unreachable" path then applies unchanged');

  /* new Response() throws a RangeError below 200, which would surface as a
     confusing bug instead of the transport failure it is. */
  const noStatus = relay({ pinned: HUB, onRequest: () => Promise.resolve({ status: 0, body: '' }) });
  await noStatus.nativeHubSync();
  let err3 = null;
  await noStatus.hubFetch(MAKER).catch(e => { err3 = e; });
  check('a reply with no usable status rejects as a transport failure',
    !!err3 && err3 instanceof TypeError, err3 && err3.message);

  const noContent = relay({ pinned: HUB, onRequest: () => Promise.resolve({ status: 204, body: '' }) });
  await noContent.nativeHubSync();
  const r204 = await noContent.hubFetch(MAKER);
  check('204 is passed through rather than throwing on its own body',
    r204.status === 204, 'the Response constructor rejects a body on 204/205');

  const hubDown = relay({ pinned: HUB, onRequest: () => Promise.reject(new Error('pin-mismatch: xyz')) });
  await hubDown.nativeHubSync();
  let err4 = null;
  await hubDown.hubFetch(MAKER).catch(e => { err4 = e; });
  check('a native failure propagates with its own reason',
    !!err4 && /pin-mismatch/.test(err4.message), err4 && err4.message);
}

console.log('\n=== 12. Learning which hub is pinned ===');
{
  const none = relay({ capabilities: null });
  check('with no bridge the sync is a no-op',
    (await none.nativeHubSync()) === null && none.fetches.length === 0);

  const trailing = relay({ pinned: 'https://192.168.50.139/' });
  await trailing.nativeHubSync();
  check('the pinned origin is normalised before comparison',
    trailing.pinned() === HUB, trailing.pinned());

  /* If hub.info fails the relay must not fall back to a plain fetch that
     cannot work -- it must look unreachable, which is honest. */
  const broken = relay({ pinned: HUB, infoThrows: true });
  await broken.nativeHubSync();
  let err = null;
  await broken.hubFetch(MAKER).catch(e => { err = e; });
  check('a failed hub.info leaves the relay refusing, not falling back',
    broken.pinned() === null && !!err && broken.fetches.length === 0);

  /* The case that actually needs the reset: a sync that SUCCEEDED, then a
     later one that failed. Keeping the old origin means the wrong-hub guard
     is comparing against a value native may no longer be pinned to, which is
     the exact silently-wrong-hub outcome the guard exists to prevent. A fresh
     relay cannot show this -- its origin starts null either way -- so the
     mutation gate found it where the first test agreed with the code. */
  const wentStale = relay({ pinned: HUB });
  await wentStale.nativeHubSync();
  check('a good sync records the origin', wentStale.pinned() === HUB);
  wentStale.ctl.infoThrows = true;
  await wentStale.nativeHubSync();
  check('...and a later failed sync clears it rather than trusting it',
    wentStale.pinned() === null,
    'a stale origin makes the mismatch guard compare against the wrong hub');
}

console.log('\n=== 13. Nothing aimed at the hub bypasses the doorway ===');
{
  const code = DASH.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const bare = code.match(/(?<!hub)[Ff]etch(WithTimeout)?\s*\(\s*apiUrl\s*\(/g) || [];
  check('no Maker API call still uses a bare fetch', bare.length === 0, bare.join(', '));
  const routed = (code.match(/hubFetch\s*\(\s*apiUrl\s*\(/g) || []).length;
  check('every Maker API call site goes through hubFetch', routed === 9, `found ${routed}, expected 9`);

  /* THE CHECK THAT WOULD HAVE CAUGHT THE REAL BUG, and the reason it is written
     this way. The first sweep looked for `fetch(apiUrl(` and found nine sites.
     Five more built the same hub URL INLINE, across two statements:

         const url = `${CONFIG.hub}/apps/api/${CONFIG.appId}/hsm?...`;
         const res = await fetch(url);

     A line-based grep cannot see that, so arm/disarm, the HSM poll, the version
     check, webhook registration and the onboarding device fetch were all left
     on a plain fetch -- which in the app cannot reach the hub at all. It showed
     up on a real phone as "[Artemis] HSM sync failed: Failed to fetch".

     So this asserts on the URL being CONSTRUCTED rather than on how the call is
     spelled, and looks at the lines that follow it. Any new hub URL is covered
     the moment it is written, without anyone remembering to add it here. */
  const src = code.split('\n');
  const bypass = [];
  src.forEach((line, i) => {
    if (!/\/apps\/api\//.test(line)) return;
    if (/function apiUrl|hubStoreFetch|href=|show\(/.test(line)) return;   // the doorway itself, and displayed links
    const after = src.slice(i, i + 4).join('\n');
    if (/(?<!hub)(?<!_)\bfetch\s*\(/.test(after)) bypass.push(`line ${i + 1}: ${line.trim().slice(0, 60)}`);
  });
  check('no inline-built hub URL is fetched outside the doorway',
    bypass.length === 0, bypass.join(' | '));
  check('the companion-app doorway is routed too',
    /const res = await hubFetch\(url, fetchOpts, 4000\);/.test(code),
    'one line covers all 13 hubStoreFetch callers');
}

console.log('\n=== 14. First run belongs to the app and nowhere else ===');
{
  const FIRSTRUN_SRC = ['nativeHub', 'nativeFirstRunNeeded', 'nativeFirstRun', 'nfrReason',
    'nfrManualConnect'].map(extractFn).join('\n\n');

  function firstRun({ capabilities = ['hub'], pinned = null, addr = '' } = {}) {
    const inspected = [];
    const win = { location: { href: 'https://appassets.androidplatform.net/assets/index.html' } };
    if (capabilities !== null) win.hestiaNative = { capabilities, call: () => Promise.resolve({}) };
    return new Function('window', 'document', `
      let _nativeHubOrigin = ${JSON.stringify(pinned)};
      let NFR = { err: '', manual: '' }, _nfrResolve = null;
      const inspected = [];
      function nfrRender() {}
      function nfrLockBodyScroll() {}
      function nfrInspect(origin) { inspected.push(origin); }
      ${FIRSTRUN_SRC}
      return { nativeFirstRunNeeded, nativeFirstRun, nfrReason, nfrManualConnect,
               inspected, NFR };
    `)(win, { getElementById: () => ({ value: addr }) });
  }

  /* The gate. If this is ever true in a browser, every hestari.com user is
     shown a setup flow for a capability their browser does not have. */
  check('a browser never needs first run',
    firstRun({ capabilities: null }).nativeFirstRunNeeded() === false);
  check('...nor does a bridge that does not offer hub',
    firstRun({ capabilities: ['mic'] }).nativeFirstRunNeeded() === false);
  check('a device that already trusts a hub is not asked again',
    firstRun({ pinned: 'https://192.168.50.139' }).nativeFirstRunNeeded() === false,
    'first run is for the first run');
  check('a fresh app install does need it',
    firstRun().nativeFirstRunNeeded() === true);

  /* Boot AWAITS this, so a wrong answer here does not show a stray screen --
     it hangs the dashboard before anything renders. */
  const skipped = firstRun({ capabilities: null });
  check('when it is not needed it resolves immediately rather than blocking boot',
    (await skipped.nativeFirstRun()) === null);

  /* The app never sends cleartext -- that is what lets the manifest keep
     usesCleartextTraffic false -- and an http hub has no key to pin, which is
     the entire subject of the screen that follows. */
  for (const typed of ['192.168.1.100', 'http://192.168.1.100', 'HTTP://192.168.1.100/',
                       'https://192.168.1.100', '  192.168.1.100  ']) {
    const f = firstRun({ addr: typed });
    f.nfrManualConnect();
    check(`a typed address becomes https: ${JSON.stringify(typed)}`,
      f.inspected.length === 1 && f.inspected[0] === 'https://192.168.1.100',
      f.inspected[0]);
  }
  const empty = firstRun({ addr: '   ' });
  empty.nfrManualConnect();
  check('an empty address asks again instead of connecting to nothing',
    empty.inspected.length === 0 && /address/i.test(empty.NFR.err));

  /* The bridge prefixes its own reasons. A user should be told the cause, not
     handed the protocol. */
  const r = firstRun();
  check('a certificate change is named as one',
    /different certificate/i.test(r.nfrReason(new Error('pin-mismatch: abc vs def'))));
  check('an unreachable hub is not reported as a certificate problem',
    /could not reach/i.test(r.nfrReason(new Error('not-configured: no hub'))));
  check('something that is not a hub says so',
    /not a Hubitat/i.test(r.nfrReason(new Error('hub answered 404 rather than identifying itself'))));
  check('an unknown failure still says something rather than nothing',
    r.nfrReason(new Error('')).length > 0);
}

console.log('\n=== 15. A denied permission names a remedy that exists ===');
{
  /* Reported from a real phone. Athena was denied the microphone and told the
     user to click the padlock in the address bar. An app has no address bar,
     so the instruction was not merely unhelpful, it was impossible -- the same
     failure class as v2.0.2's recovery screen telling a locked-out household
     to open a device that was already working. */
  const COPY_SRC = ['inNativeApp', 'permRemedyHTML'].map(extractFn).join('\n\n');
  const copy = (native) => new Function('window', `
      ${COPY_SRC}
      return { inNativeApp, permRemedyHTML };
    `)(native ? { hestiaNative: { capabilities: [] } } : {});

  const browser = copy(false).permRemedyHTML('the microphone');
  const app = copy(true).permRemedyHTML('the microphone');

  check('a browser user is pointed at site settings',
    /address bar|Site settings/i.test(browser), browser.slice(0, 60));
  check('an app user is NOT pointed at an address bar',
    !/address bar|Site settings|browser/i.test(app), app);
  check('...and is pointed at the device settings instead',
    /device's Settings/i.test(app) && /Hestia/.test(app), app);
  check('both name the permission they are about',
    browser.includes('the microphone') && app.includes('the microphone'));

  /* Present-and-empty counts as the app: a shell offering no capabilities is
     still a place where browser instructions are wrong, which is why this
     cannot be a capability test. */
  check('a capability-less shell still counts as the app',
    copy(true).inNativeApp() === true && copy(false).inNativeApp() === false);

  /* The OS is never named. Naming it would be a platform branch, the exact
     fork the bridge contract exists to prevent, and the wording has to stay
     true on every target we ship. */
  check('no platform is named in the app remedy',
    !/android|ios|iphone|samsung/i.test(app), app);
}

console.log('\n=== 16. Push registers through native only when native offers it ===');
{
  /* The browser path must be untouched. Web Push is live for every household
     today, and the app's path is new, so the regression that matters is a
     browser being sent down a route that does not exist for it. */
  const PUSH_SRC = ['nativePush', 'pushSubscribeNative'].map(extractFn).join('\n\n');

  function pushEnv({ capabilities = ['hub', 'push'], register = { permitted: true, token: 'tok', kind: 'fcm' } } = {}) {
    const win = {};
    if (capabilities !== null) {
      win.hestiaNative = {
        capabilities,
        call: (m) => (m === 'push.register'
          ? (register instanceof Error ? Promise.reject(register) : Promise.resolve(register))
          : Promise.reject(new Error('no such capability: ' + m))),
      };
    }
    /* Both arrays live OUT here and are handed in. An earlier version declared
       `alerts` inside the sandbox too, which shadowed the injected spy, so the
       returned array was always empty and the "it still warns" test passed on
       a function that had raised nothing. The sandbox gets no copy of its
       own. */
    const sent = [], alerts = [];
    const api = new Function('window', 'console', 'alert', 'JSON', 'sent', `
      const PUSH_API = '/api/push', DEVICE_ID = 'dev-1', DEVICE_NAME = 'Phone';
      function _cloudAuthHeaders() { return Promise.resolve({}); }
      /* Mirrors the doorway pushSubscribeNative actually calls. It used to
         stub _fetchWithTimeout, and when registration moved onto cloudFetch
         the stub stopped being reached: the sent list stayed empty and the
         suite crashed rather than silently passing, which is the only reason
         this was caught. NOTE: no backticks in here, this lives inside a
         template literal and one would end the string. */
      function cloudFetch(url, opts, ms) { sent.push({ url, opts }); return Promise.resolve({ ok: true, status: 200 }); }
      ${PUSH_SRC}
      return { nativePush, pushSubscribeNative };
    `)(win, { log() {}, warn() {} }, (m) => alerts.push(m), JSON, sent);
    return { ...api, sent, alerts };
  }

  check('a browser offers no native push', pushEnv({ capabilities: null }).nativePush() === null);
  check('a hub-only bridge offers no native push',
    pushEnv({ capabilities: ['hub'] }).nativePush() === null,
    'hub and push are independent capabilities');
  check('a push-capable bridge does', pushEnv().nativePush() !== null);

  const ok = pushEnv();
  const okResult = await ok.pushSubscribeNative(ok.nativePush(), 'armed');
  const body = JSON.parse(ok.sent[0].opts.body);
  check('registration succeeds and PUTs once', okResult === true && ok.sent.length === 1);
  /* kind is what the backend uses to tell the transports apart. Omitting it
     would store an FCM token where a Web Push subscription is expected, and
     that only fails at SEND time, which is the worst place to learn it. */
  check('...declaring the transport explicitly', body.kind === 'fcm' && body.token === 'tok', JSON.stringify(body));
  check('...and carrying the mode the caller asked for', body.mode === 'armed');
  check('...with no subscription field', body.subscription === undefined,
    'one shape or the other, never both');

  const denied = pushEnv({ register: { permitted: false, token: null } });
  check('a denied permission does not register',
    (await denied.pushSubscribeNative(denied.nativePush(), 'always')) === false && denied.sent.length === 0);

  const noToken = pushEnv({ register: { permitted: true, token: null } });
  check('no token means no registration',
    (await noToken.pushSubscribeNative(noToken.nativePush(), 'always')) === false && noToken.sent.length === 0,
    'registering without a token would store a device that can never be reached');

  const threw = pushEnv({ register: new Error('play services missing') });
  check('a native failure is reported, not swallowed',
    (await threw.pushSubscribeNative(threw.nativePush(), 'always')) === false);

  /* Boot calls this on every launch. A modal there is noise the user cannot
     act on at that moment, and a failing resync would make the app unusable
     rather than merely un-notified. */
  const quiet = pushEnv({ register: { permitted: false } });
  await quiet.pushSubscribeNative(quiet.nativePush(), 'always', { silent: true });
  check('silent mode raises no dialog', quiet.alerts.length === 0);
  const loud = pushEnv({ register: { permitted: false } });
  await loud.pushSubscribeNative(loud.nativePush(), 'always');
  check('...but an interactive failure still says why', loud.alerts.length === 1, loud.alerts[0]);
}

console.log('\n=== 17. The module screens only offer what the household can use ===');
{
  /* These screens announce the modules that need an active toggle-on. Showing
     one a household cannot use is worse than skipping it: a security module
     pitched to a home with no sensors reads as broken, and a push screen on a
     device with no push capability promises something that will never arrive. */
  const STEP_SRC = ['nativePush', 'nativeHub', 'nfmSteps'].map(extractFn).join('\n\n');

  const steps = ({ capabilities = ['hub', 'push'], sensors = {}, athenaKey = '' } = {}) => {
    const win = {};
    if (capabilities !== null) win.hestiaNative = { capabilities };
    return new Function('window', `
      const CONFIG = { artemisSensors: ${JSON.stringify(sensors)},
                       athenaApiKey: ${JSON.stringify(athenaKey)} };
      ${STEP_SRC}
      return nfmSteps();
    `)(win);
  };

  check('always starts with Hestia, the module everything else builds on',
    steps()[0] === 'hestia');

  check('a household with no sensors is not pitched Artemis',
    !steps({ sensors: {} }).includes('artemis'),
    'a security module with nothing to watch reads as broken');
  check('...and one with sensors is',
    steps({ sensors: { contacts: [{ id: 1 }] } }).includes('artemis'));
  /* Counted across every category, not just contacts: a household with only
     smoke detectors still has a security module worth having. */
  check('any sensor category counts, not only contacts',
    steps({ sensors: { smokes: [{ id: 1 }] } }).includes('artemis') &&
    steps({ sensors: { waters: [{ id: 2 }] } }).includes('artemis'));

  check('the keys screen is skipped when a key is already held',
    !steps({ athenaKey: 'sk-ant-xyz' }).includes('athenakeys'),
    'asking again for something the household already synced is noise');
  check('...and shown when it is not', steps().includes('athenakeys'));

  check('push is offered only when native can deliver it',
    steps({ capabilities: ['hub', 'push'] }).includes('push') &&
    !steps({ capabilities: ['hub'] }).includes('push'));

  check('announcements always close the sequence',
    steps().at(-1) === 'announce' &&
    steps({ capabilities: ['hub'] }).at(-1) === 'announce');

  /* Order is the design: three modules in the order they build on each other,
     then the add-ons that ride on top. */
  const full = steps({ sensors: { contacts: [{ id: 1 }] } });
  check('order is Hestia, Artemis, Athena, then add-ons',
    full.join(',') === 'hestia,artemis,athena,athenakeys,push,announce', full.join(','));

  const minimal = steps({ capabilities: ['hub'], sensors: {}, athenaKey: 'sk' });
  check('a minimal household still gets a coherent sequence',
    minimal.join(',') === 'hestia,athena,announce', minimal.join(','));
}

console.log('\n=== 18. The cloud relay carries the whole request, credentials included ===');
{
  /* This section exists because of a real failure on a real phone. The relay
     read Content-Type out of the headers and forwarded nothing else, so every
     authorised call reached the backend anonymous. The backend answered 401
     with "no credential was supplied" about credentials the page had set
     correctly, and the only visible symptom was a three-digit number in a
     dialog. The relay stands in for fetch; a relay that drops headers is not
     standing in for anything. */
  const CF_SRC = ['nativeCloud', 'cloudFetch', '_relayBody'].map(extractFn).join('\n\n');

  const cloudEnv = ({ capabilities = ['hub', 'cloud'] } = {}) => {
    const win = {};
    const calls = [];
    if (capabilities !== null) {
      win.hestiaNative = {
        capabilities,
        call: (method, params) => {
          calls.push({ method, params });
          return Promise.resolve({ status: 200, body: '{}' });
        },
      };
    }
    const SENTINEL = { sentinel: true };
    const plain = [];
    const api = new Function(
      'window', 'JSON', 'Number', 'String', 'TypeError', 'Response', 'fetch', 'plain',
      `function _fetchWithTimeout(u, ms, o) { plain.push({ u, ms, o, timed: true }); return u; }
       ${CF_SRC}
       return { nativeCloud, cloudFetch };`,
    )(win, JSON, Number, String, TypeError,
      /* Enforces the real constructor's null-body rule. A stub that accepted a
         body on a 304 would have agreed with the bug it is here to catch --
         "a stub that drifts from the code it mirrors tests fiction", applied to
         a stub written in the same change as the fix. Verified against node's
         own Response, which throws on exactly this set. */
      function Response(body, init) {
        const status = init && init.status;
        if ([101, 103, 204, 205, 304].indexOf(status) >= 0 && body != null) {
          throw new TypeError(`Response constructor: Invalid response status code ${status}`);
        }
        this.body = body; this.status = status;
      },
      (u) => { plain.push({ u }); return SENTINEL; }, plain);
    return { ...api, win, calls, plain, SENTINEL };
  };

  const browser = cloudEnv({ capabilities: null });
  check('a browser gets plain fetch, by identity',
    browser.cloudFetch('/api/x', { method: 'GET' }) === browser.SENTINEL,
    'the relay must be unreachable without the capability, or a defect in it reaches every household');
  const hubOnly = cloudEnv({ capabilities: ['hub'] });
  check('...and so does a bridge that does not offer cloud',
    hubOnly.cloudFetch('/api/x', {}) === hubOnly.SENTINEL);

  const native = cloudEnv();
  await native.cloudFetch('/api/push/subscribe', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Hestia-Token': 'maker-token',
      'X-Hestia-Proof': 'secret-proof',
      'X-Hestia-Recovery': 'recovery-r',
    },
    body: '{"deviceId":"d"}',
  });
  const p = native.calls[0].params;
  check('the relay is used when the capability is there',
    native.calls.length === 1 && native.calls[0].method === 'cloud.request');
  /* Named one by one on purpose. Asserting "headers is the same object" would
     pass against a relay that forwards an empty object just as happily, and
     these three are the ones the backend authorises on. */
  check('...carrying the Maker token', p.headers['X-Hestia-Token'] === 'maker-token', JSON.stringify(p.headers));
  check('...carrying the secret proof', p.headers['X-Hestia-Proof'] === 'secret-proof');
  check('...carrying the recovery proof', p.headers['X-Hestia-Recovery'] === 'recovery-r');
  check('...with the method and body intact',
    p.method === 'PUT' && p.body === '{"deviceId":"d"}');
  check('...and the content type still called out separately',
    p.contentType === 'application/json',
    'the body media type is set on the request, not only sent as a header');

  const lower = cloudEnv();
  await lower.cloudFetch('/api/x', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' });
  check('a lowercase content-type is recognised too',
    lower.calls[0].params.contentType === 'text/plain');

  const bare = cloudEnv();
  await bare.cloudFetch('/api/x');
  check('no options at all still relays a GET',
    bare.calls[0].params.method === 'GET' && bare.calls[0].params.body === null);

  /* `ms` has to mean the same thing on both paths. It bounds an AbortController
     in a browser; if the relay ignored it, the callers that pass one -- all of
     them boot-path guards whose entire job is to bound a stall -- would be
     unbounded in the app and bounded everywhere else. */
  const timed = cloudEnv();
  await timed.cloudFetch('/api/x', null, 4000);
  check('a timeout is carried across the relay, not dropped',
    timed.calls[0].params.timeoutMs === 4000);
  const untimed = cloudEnv();
  await untimed.cloudFetch('/api/x', null);
  check('...and omitting one asks for the relay defaults',
    untimed.calls[0].params.timeoutMs === 0,
    'a bare fetch has no timeout either');

  /* The Response constructor throws on a body for these. 204 and 205 were
     handled and 304 was not, so a conditional request came back as a rejected
     promise -- and forwarding If-None-Match is exactly what the header change
     made possible, so the gap and the means to reach it arrived together. */
  const nullBody = cloudEnv();
  nullBody.calls.length = 0;
  for (const st of [204, 205, 304]) {
    const env = cloudEnv();
    env.win.hestiaNative.call = () => Promise.resolve({ status: st, body: 'should not be here' });
    let threw = null, out = null;
    try { out = await env.cloudFetch('/api/x'); } catch (e) { threw = e; }
    check(`${st} yields a response with no body`,
      threw === null && out && out.body === null, threw ? String(threw.message) : `body=${out && out.body}`);
  }
  const ok200 = cloudEnv();
  ok200.win.hestiaNative.call = () => Promise.resolve({ status: 200, body: '{"a":1}' });
  check('...while an ordinary status keeps its body',
    (await ok200.cloudFetch('/api/x')).body === '{"a":1}');
}

console.log('\n=== 19. Every call to the backend goes through the relay ===');
{
  /* The relay shipped 12 of 15 converted. The three left behind were
     _cloudGetIp, _cloudRecordUnreadable and the lockout screen's key verifier
     -- which, in the app, meant the lockout detector and BOTH household-secret
     mint guards failed open on every launch, because each of them treats an
     unreachable backend as "not locked out". A second phone set up away from
     home would have run the wizard, minted a new secret and rewritten the
     household's record, locking out every other device. That is v2.0.2 again,
     caused by the conversion being incomplete rather than by anything in it.

     Asserted over the source because that is where the property lives: there is
     no runtime moment at which a missed call site announces itself. Comments
     are stripped first -- three false greens in one release series came from an
     assertion matching the prose above the code it meant to check. */
  const code = DASH
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');

  const CONSTS = ['CLOUD_SYNC_API', 'PUSH_API', 'ACTIVITY_API'];
  const stray = [];
  let total = 0;
  for (const c of CONSTS) {
    // Every use that builds a URL, and who is being handed it.
    for (const m of code.matchAll(new RegExp(`(\\w*)\\s*\\(\\s*${c}\\s*\\+`, 'g'))) {
      total++;
      if (m[1] !== 'cloudFetch') stray.push(`${m[1] || '(anonymous)'}(${c} + ...)`);
    }
    // And any that escapes into a bare fetch by another route.
    for (const m of code.matchAll(new RegExp(`(fetch|_fetchWithTimeout)\\s*\\([^)\\n]*${c}`, 'g'))) {
      stray.push(m[0].slice(0, 60));
    }
  }
  check('every backend URL is built inside a cloudFetch call',
    stray.length === 0, stray.join(' | '));
  check('...and there are still as many of them as the app was verified with',
    total >= 13, `found ${total}`);
}

console.log('\n=== 20. Pull to refresh reaches the app and nothing else ===');
{
  /* Mobile browsers already implement this gesture. A second implementation on
     top of theirs would mean two indicators fighting over one pull, so the
     native bridge is the whole gate -- and that makes browser-inertness the
     property worth asserting, not the gesture maths. */
  const PTR_SRC = ['nativePullToRefreshInit', '_ptrScrollerAt', '_ptrBlocked'].map(extractFn).join('\n\n');

  const ptrEnv = ({ native = true } = {}) => {
    const listeners = [];
    const win = {};
    if (native) win.hestiaNative = { capabilities: ['hub'], call: () => Promise.resolve({}) };
    const doc = {
      addEventListener: (type) => listeners.push(type),
      getElementById: () => null,
      body: {},
    };
    const api = new Function('window', 'document', 'console', 'getComputedStyle', `
      let _ptr = null;
      const PTR_TRIGGER = 72, PTR_MAX = 110;
      let artemisTransition = null, artemisAlarmType = null, NFM = null;
      function nativeRefreshNow(){}
      function _ptrReset(){}
      function _ptrIndicator(){ return { classList: { add(){}, remove(){}, toggle(){} }, style: {} }; }
      ${PTR_SRC}
      return { nativePullToRefreshInit, _ptrScrollerAt, _ptrBlocked, state: () => _ptr };
    `)(win, doc, { log() {}, warn() {} }, (el) => ({ overflowY: el.__oy || 'visible' }));
    api.nativePullToRefreshInit();
    return { ...api, listeners };
  };

  const browser = ptrEnv({ native: false });
  check('a browser gets no listeners at all',
    browser.listeners.length === 0 && browser.state() === null,
    'the browser already has this gesture; two would fight over one pull');

  const app = ptrEnv();
  check('the app does', app.listeners.length > 0 && app.state() !== null);
  check('...covering cancel as well as end',
    app.listeners.includes('touchcancel') && app.listeners.includes('touchend'),
    'a cancelled gesture that never resets leaves the indicator stuck on screen');

  /* Calling init twice must not double every listener. Boot has re-run before
     -- a config sync or a household adoption can reload mid-sequence. */
  const twice = ptrEnv();
  const n = twice.listeners.length;
  twice.nativePullToRefreshInit();
  check('a second init adds nothing', twice.listeners.length === n);

  /* THE TRAP this exists for. A native SwipeRefreshLayout keyed on
     webView.scrollY would fire anywhere on the page, because body is
     overflow:hidden and the real scrolling is in inner containers. */
  const scrollEnv = ptrEnv();
  const node = (oy, sh, ch, parent) => ({ __oy: oy, scrollHeight: sh, clientHeight: ch, parentElement: parent });
  const outer = node('auto', 1000, 600, null);
  const inner = node('visible', 10, 10, outer);
  check('the scroller under the finger is found through its ancestors',
    scrollEnv._ptrScrollerAt(inner) === outer);
  check('...ignoring a container that does not actually overflow',
    scrollEnv._ptrScrollerAt(node('visible', 10, 10, node('auto', 100, 100, null))) === null,
    'an overflow style alone is not a scroller');

  /* A refresh repaints. Doing that mid-countdown or during a sounding alarm is
     the exact class of bug that cost v1.6.5 three rounds to find. */
  const blockEnv = (over) => new Function('document', 'getComputedStyle', `
    let artemisTransition = ${over.transition ? "'entry'" : 'null'};
    let artemisAlarmType = ${over.alarm ? "'intrusion'" : 'null'};
    let NFM = ${over.nfm ? '{}' : 'null'};
    ${extractFn('_ptrBlocked')}
    return _ptrBlocked;
  `)({ getElementById: (id) => (over.ids || []).includes(id) ? { classList: { contains: () => true } } : null },
      () => ({}));

  check('an entry-delay countdown blocks the gesture', blockEnv({ transition: true })() === true);
  check('a sounding alarm blocks it', blockEnv({ alarm: true })() === true);
  check('the PIN sheet blocks it', blockEnv({ ids: ['a-pin-sheet'] })() === true,
    'refreshing while somebody types a PIN under time pressure is worse than not refreshing');
  check('first run and the lockout screen block it',
    blockEnv({ ids: ['ob-wrap'] })() === true && blockEnv({ ids: ['nfr-wrap'] })() === true);
  check('the module screens block it', blockEnv({ nfm: true })() === true);
  check('Settings and Athena block it',
    blockEnv({ ids: ['settings-panel'] })() === true && blockEnv({ ids: ['ath-overlay'] })() === true);
  check('an ordinary dashboard does NOT block it', blockEnv({})() === false,
    'blocking everywhere would be a feature that never runs');

  /* A failed hub read must not be mistaken for an empty household here either.
     That confusion is what erased a household's disarm PIN. */
  const refresh = codeOnlyJs(extractFn('nativeRefreshNow'));
  check('refresh applies a config only when one actually came back',
    /const cfg = await loadConfigFromHub\(\);[\s\S]{0,120}if \(cfg\) \{/.test(refresh),
    'the PIN-wipe bug, one function over');
  check('...and never reloads the page instead',
    !/location\.reload/.test(refresh),
    'a reload tears down the wake-word listener and the mic it holds');
  check('a failed refresh says so', /showDeviceToast\(/.test(refresh),
    'silence is indistinguishable from a refresh that found nothing new');

  /* Found by running it, not by reading it. Snapshots share one host with
     device polling, OkHttp allows 5 concurrent per host, and a hub snapshot
     takes seconds -- so three of them beside a device fetch starved the 1s
     poll into its 10s timeout and put "Lost connection to your hub" on screen
     while the hub was answering in 75ms. */
  check('refresh does NOT kick the cameras', !/camRefreshAll/.test(refresh),
    'they have their own timer, and they starve device polling for the same host');
}

console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL ? 1 : 0);

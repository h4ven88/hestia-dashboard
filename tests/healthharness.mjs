import fs from 'fs';
const src = fs.readFileSync('C:/Users/rbodd/hestia-dashboard/dashboard.html', 'utf8');
const a = src.indexOf('const _ringConn = {');
const b = src.indexOf('async function fetchAllDevices() {');
const block = src.slice(a, b);
const modeKey = (() => { const m = src.indexOf('function _ringModeKey('); let d = 0; for (let j = src.indexOf('{', m); ; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) return src.slice(m, j + 1); } })();

let now = 1_000_000_000_000;
const log = [];
const api = new Function('__now', '__log', `
  const Date = { now: () => __now() };
  const Math2 = Math;
  let CONFIG = { artemisEnabled: true, artemisRingDeviceId: '204' };
  let artemisHsmReady = true, artemisTransition = null, artemisMode = 'disarm';
  const els = { 'alarm-sync-banner': { classList: { _v: false, add(){ this._v = true; }, remove(){ this._v = false; } } }, 'alarm-sync-msg': { textContent: '' }, 'alarm-sync-a1': { hidden: true, textContent: '' }, 'alarm-sync-a2': { hidden: true, textContent: '' } };
  const document = { getElementById: id => els[id] || null };
  async function cmd(id, c){ __log('CMD ' + id + ' ' + c); return true; }
  function isMobile(){ return true; } function selectTab(){ __log('selectTab'); } function selectRoom(){} function artemisOpenSheet(){ __log('PIN SHEET'); }
  async function artemisHsmOnlyCmd(c){ __log('HSM ' + c); } async function artemisHsmSync(){} async function artemisAlarmPanelCmd(c){ __log('RING ' + c); }
  function setTimeout(){ }
  const console = { log(){} };
  ${modeKey}
  ${block}
  _ringConn.jitterMs = 0;
  return {
    tick: (conns, panels) => artemisAlarmHealthSync(conns, panels),
    banner: () => ({ visible: els['alarm-sync-banner'].classList._v, msg: els['alarm-sync-msg'].textContent, a1: els['alarm-sync-a1'].hidden ? null : els['alarm-sync-a1'].textContent, a2: els['alarm-sync-a2'].hidden ? null : els['alarm-sync-a2'].textContent, pinAllowed: _artemisMismatchDisarm }),
    run: n => alarmSyncRun(n), dismiss: () => alarmSyncDismiss(),
    set: (k, v) => eval(k + '=v'),
  };
`)(() => now, m => log.push(m));

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}  ${extra}`); };
const conn = ws => [{ id: '203', label: 'Home - Kingsport Location', websocket: ws }];
const panel = (mode, extra = {}) => [{ id: '204', live: true, attrs: { mode, entryDelay: 'inactive', exitDelay: 'inactive', ...extra } }];
const step = (sec, conns, panels) => { now += sec * 1000; log.length = 0; api.tick(conns, panels); return api.banner(); };

console.log('--- Ring cloud connection drops');
let s = step(1, conn('connected'), panel('off'));
check('connected + matching: no banner', !s.visible);
s = step(1, conn('failure'), panel('off'));
check('just dropped: no banner yet (driver retries first)', !s.visible && log.length === 0);
s = step(61, conn('failure'), panel('off'));
check('down 62s: banner shown, no auto-reconnect yet', s.visible && /cloud connection is down/.test(s.msg) && s.a1 === 'Reconnect now' && !log.some(l => l.startsWith('CMD')), JSON.stringify(s));
s = step(60, conn('failure'), panel('off'));
check('down 2m: auto initialize sent once', log.filter(l => l === 'CMD 203 initialize').length === 1, log.join('|'));
s = step(60, conn('failure'), panel('off'));
check('3m: not repeated within 5 minutes', !log.some(l => l.startsWith('CMD')));
s = step(241, conn('failure'), panel('off'));
check('7m: retried after 5 minutes', log.includes('CMD 203 initialize'));
log.length = 0; api.run(0);
check('Reconnect now button sends initialize immediately', log.includes('CMD 203 initialize'));
s = step(1, conn('failure'), panel('home'));
check('while down, stale Ring mode never raises a mismatch', !/Safety Monitor/.test(s.msg));
s = step(5, conn('connected'), panel('off'));
check('reconnected: "back" confirmation', s.visible && /is back/.test(s.msg), JSON.stringify(s));

console.log('--- HSM disarmed, Ring still armed (last night)');
api.set('artemisMode', "'disarm'".slice(1, -1));
s = step(1, conn('connected'), panel('home'));
check('under 45s: no banner (rules/driver sync still catching up)', !/Safety Monitor/.test(s.msg));
s = step(46, conn('connected'), panel('home'));
check('46s: mismatch banner', s.visible && s.msg === 'Hubitat Safety Monitor is Disarmed but Ring is Armed Home.', JSON.stringify(s));
check('offers Disarm Ring (PIN) and Arm HSM Home', s.a1 === 'Disarm Ring' && s.a2 === 'Arm HSM Home');
check('PIN pad allowed while Artemis reads Disarmed', s.pinAllowed === true);
log.length = 0; api.run(0);
check('Disarm Ring opens the PIN pad, sends nothing by itself', log.includes('PIN SHEET') && !log.some(l => l.startsWith('RING') || l.startsWith('HSM')), log.join('|'));
log.length = 0; api.run(1);
check('Arm HSM Home sends only the HSM command', log.join('|') === 'HSM armHome', log.join('|'));
api.dismiss();
s = step(1, conn('connected'), panel('home'));
check('dismissed: stays hidden for the same situation', !s.visible);
s = step(1, conn('connected'), panel('off'));
check('resolved: banner gone, PIN exception cleared', !s.visible && s.pinAllowed === false);

console.log('--- A dismissed banner returns if the trouble happens again');
api.set('artemisMode', 'disarm');
step(1, conn('connected'), panel('home'));
s = step(46, conn('connected'), panel('home'));
check('mismatch shown again after resolving once', s.visible && /Armed Home/.test(s.msg));
api.dismiss();
check('dismissed hides it', !api.banner().visible);
s = step(1, conn('connected'), panel('off'));   // resolved
step(1, conn('connected'), panel('away'));      // new mismatch starts
s = step(46, conn('connected'), panel('away'));
check('a NEW mismatch after resolution is not silenced', s.visible && /Armed Away/.test(s.msg), JSON.stringify(s));
step(1, conn('connected'), panel('off'));
step(1, conn('failure'), panel('off'));
s = step(61, conn('failure'), panel('off'));
check('connection banner shows', s.visible && /connection is down/.test(s.msg));
api.dismiss();
step(1, conn('connected'), panel('off'));       // recovered
step(1, conn('failure'), panel('off'));         // drops again later
s = step(61, conn('failure'), panel('off'));
check('a later outage is not silenced by the earlier dismiss', s.visible && /connection is down/.test(s.msg), JSON.stringify(s));
step(1, conn('connected'), panel('off'));

console.log('--- HSM armed away, Ring disarmed (keypad disarm without Ring->HSM sync)');
api.set('artemisMode', 'away');
step(1, conn('connected'), panel('off'));
s = step(46, conn('connected'), panel('off'));
check('banner with Disarm HSM and Set Ring to Away', s.msg === 'Hubitat Safety Monitor is Armed Away but Ring is Disarmed.' && s.a1 === 'Disarm HSM' && s.a2 === 'Set Ring to Away', JSON.stringify(s));
check('no PIN exception needed (Artemis already armed)', s.pinAllowed === false);

console.log('--- Legitimate differences never flag');
api.set('artemisMode', 'disarm');
step(1, conn('connected'), panel('away', { exitDelay: 'active' }));
s = step(60, conn('connected'), panel('away', { exitDelay: 'active' }));
check('Ring exit delay active: no mismatch', !/Safety Monitor/.test(s.msg) || !s.visible);
api.set('artemisTransition', 'arming');
s = step(60, conn('connected'), panel('away'));
check('Hestia countdown running: no mismatch', !s.visible);
api.set('artemisTransition', null); api.set('artemisHsmReady', false);
s = step(60, conn('connected'), panel('away'));
check('HSM not configured: no mismatch', !s.visible);
api.set('artemisHsmReady', true);
s = step(60, [], []);
check('no Ring integration at all: nothing', !s.visible);
api.set('_ringConn.downSince', 0); api.set('_ringConn.lastAttempt', 0); api.set('_ringConn.bannerShown', false);
log.length = 0;
step(61, conn('failure'), []);
s = step(240, conn('failure'), []);
check('connection down but no alarm panel behind it: silent, no initialize', !s.visible && !log.some(l => l.startsWith('CMD')), log.join('|'));

/* ── The lost-connection screen's cause text ──────────────────────────
   A browser cannot tell an untrusted certificate from a blocked
   mixed-content request from an unplugged hub, so this picks by setup. The
   screen is the main thing a user sees when the hub goes away, and nothing
   constrained which of the three messages it shows. */
console.log('\n--- Lost-connection screen: naming the likely cause');
{
  const fn = (name) => {
    const m = new RegExp('(async )?function ' + name + '\\s*\\(').exec(src);
    if (!m) throw new Error('missing ' + name);
    let d = 0;
    for (let j = src.indexOf('{', m.index); j < src.length; j++) {
      if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) return src.slice(m.index, j + 1);
    }
  };
  const banner = (hub, pageProto, pageHost) => new Function(`
    const CONFIG = { hub: ${JSON.stringify(hub)} };
    const window = { location: { protocol: ${JSON.stringify(pageProto)}, hostname: ${JSON.stringify(pageHost)} } };
    const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    ${fn('isServedFromHub')}
    ${fn('_offlineBannerHTML')}
    return _offlineBannerHTML();
  `)();

  const cert = banner('https://192.168.50.139:8443', 'https:', 'hestari.com');
  check('https hub + page not served from the hub: names the certificate',
    /accepted the hub's certificate/.test(cert) && /192\.168\.50\.139:8443/.test(cert), cert.slice(0, 70));

  const mixed = banner('http://192.168.50.139', 'https:', 'hestari.com');
  check('http hub on an https page: names mixed content and suggests :8443',
    /blocks it/.test(mixed) && /:8443/.test(mixed), mixed.slice(0, 70));

  const plain = banner('http://192.168.50.139', 'http:', '192.168.50.139');
  check('served from the hub itself: falls back to power/network',
    /powered on and on the same network/.test(plain), plain.slice(0, 70));

  const onHub = banner('https://192.168.50.139:8443', 'https:', '192.168.50.139');
  check('https hub while served BY that hub: no certificate nag',
    !/certificate/.test(onHub), onHub.slice(0, 70));

  const none = banner('', 'https:', 'hestari.com');
  check('no hub configured at all: still returns the generic message, no crash',
    /powered on and on the same network/.test(none), none.slice(0, 70));
}

console.log(`\n${pass} passed, ${fail} failed`);

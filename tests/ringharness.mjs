// Functional harness: pulls the real v1.6.7 functions out of dashboard.html
// and drives them with the user's real Ring device shapes.
import fs from 'fs';
const src = fs.readFileSync('C:/Users/rbodd/hestia-dashboard/dashboard.html', 'utf8');

function extractFn(name) {
  const re = new RegExp('(async )?function ' + name + '\\s*\\(');
  const m = re.exec(src);
  if (!m) throw new Error('missing ' + name);
  let i = src.indexOf('{', m.index), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(m.index, j + 1); }
  }
}
const names = ['_ringNum', '_ringRemaining', '_ringArmState', 'artemisRingSync', 'artemisSetTransition', 'artemisClearTransition',
  '_artemisOnSecurityView', 'artemisBeginEntryDelay', 'artemisEndEntryDelay', 'artemisEscalateAlarm',
  'artemisCompanionSecuritySync', '_versionCmp', 'artemisHsmSync', 'artemisAlarmPanelCmd', '_ringModeKey'];
const code = names.map(extractFn).join('\n');

const log = [];
let now = 1_000_000_000_000;
const env = `
let CONFIG = { artemisEnabled: true, artemisEntryDelay: 60, artemisExitDelay: 60, hub: 'h', appId: '1', token: 't' };
let artemisTransition = null, artemisArmingTarget = null, artemisTransitionSource = null;
let artemisCountdownEnd = null, artemisCountdownTotal = null, artemisCountdownInterval = null;
let artemisAlarmType = null, artemisMode = 'away', activeTab = 'home', activeRoom = 'home';
let HUB_STORE = { appId: 1 }, _companionAppVersion = '1.6.7', _companionAppVersionFor = '1';
let _hsmAlertHandledAt = null, _hsmAlertLoggedAt = null, _hsmSecInFlight = false, _hsmSecFails = 0, _hsmSecRetryAt = 0;
let artemisHsmReady = null, _artemisLastUnrecognizedHsm = null, hsmResp = 'armedAway';
const _ringPrev = { seen: false, entry: false, exit: false, siren: false, lastAt: 0, exitEndedAt: 0 };
let mobile = true, hubResp = null;
const Date = { now: () => __now(), parse: (s) => globalThis.Date.parse(s) };
function isMobile(){ return mobile; }
function setInterval(){ return 1; } function clearInterval(){} function artemisTickCountdown(){}
function announceHsmEvent(t){ __log('SAY: ' + t); }
function renderSecurity(){} function renderSidebar(){} function updateArmedStatus(){}
function selectTab(t){ activeTab = t; __log('selectTab ' + t); }
function selectRoom(r){ activeRoom = r; __log('selectRoom ' + r); }
function artemisOpenSheet(){ __log('OPEN PIN SHEET'); }
function artemisCloseSheet(){ __log('close sheet'); }
function artemisShowAlarm(t){ artemisAlarmType = t; __log('ALARM SCREEN ' + t); }
function artemisClearAlarm(){ artemisAlarmType = null; }
const document = { querySelector: () => null, querySelectorAll: () => [] };
let _artemisAlarmDevices = [];
let deviceLookup = null;
function apiUrl(p){ return p; }
async function _fetchWithTimeout(u){ __log('LOOKUP ' + u); return deviceLookup ? { ok: true, json: async () => deviceLookup } : { ok: false }; }
function parseAttrs(d){ return d.attributes || {}; }
async function cmd(id, c, a){ __log('CMD ' + id + ' ' + c + (a !== undefined ? ' ' + a : '')); return true; }
async function fetch(){ return { ok: true, json: async () => ({ hsm: hsmResp }) }; }
async function hubStoreFetch(p){ __log('fetch ' + p); return hubResp ? { ok: true, res: { json: async () => hubResp } } : { ok: false }; }
${code}
return { artemisAlarmPanelCmd, artemisRingSync, artemisCompanionSecuritySync, artemisHsmSync,
  st: () => ({ t: artemisTransition, src: artemisTransitionSource, left: artemisCountdownEnd ? Math.round((artemisCountdownEnd - __now())/1000) : null, total: artemisCountdownTotal, alarm: artemisAlarmType }),
  set: (k, v) => eval(k + '=v') };
`;
const api = new Function('__now', '__log', env)(() => now, (m) => log.push(m));

const iso = (msAgo) => new globalThis.Date(now - msAgo).toISOString();
const hub = (a, date = null) => ({ id: '204', cmds: ['setMode'], official: false, live: true, date, attrs: { mode: 'away', alarm: 'off', entryDelay: 'inactive', exitDelay: 'inactive', countdownTimeLeft: 0, countdownTotal: 0, ...a } });
const official = { id: '240', cmds: ['armAway', 'disarm', 'createChildDevices'], official: true, live: false, attrs: { alarm: 'off' } };
let pass = 0, fail = 0;
function check(label, expect, s = api.st()) {
  const ok = Object.entries(expect).every(([k, v]) => s[k] === v);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  ->  ${JSON.stringify(s)}${log.length ? '  [' + log.join(' | ') + ']' : ''}`);
}
function step(label, devsFn, expect, advance = 1) {
  now += advance * 1000;
  log.length = 0;
  api.artemisRingSync(typeof devsFn === 'function' ? devsFn() : devsFn);
  check(label, expect);
}

console.log('--- A: armed away, door opens, disarm at Ring keypad');
step('armed, idle (first poll)', [hub(), official], { t: null });
step('idle', [hub(), official], { t: null });
step('entryDelay goes active (59/60)', [hub({ entryDelay: 'active', countdownTimeLeft: 59, countdownTotal: 60 }), official], { t: 'entry-delay', src: 'ring', left: 59, total: 60 });
step('still active 10s later', [hub({ entryDelay: 'active', countdownTimeLeft: 59, countdownTotal: 60 }), official], { t: 'entry-delay', left: 49 }, 10);
step('disarmed at keypad', [hub({ mode: 'off' }), official], { t: null });

console.log('--- B: countdown expires, siren');
step('armed idle', [hub()], { t: null });
step('entry active', [hub({ entryDelay: 'active', countdownTimeLeft: 60, countdownTotal: 60 })], { t: 'entry-delay' });
step('siren on + entryDelay inactive', [hub({ alarm: 'siren' })], { t: null, alarm: 'intrusion' }, 60);
step('siren still on, no repeat', [hub({ alarm: 'siren' })], { alarm: 'intrusion' });
api.set('artemisAlarmType', null);
step('user cleared screen, siren still on: stays cleared', [hub({ alarm: 'siren' })], { alarm: null });

console.log('--- C: siren test while disarmed');
step('siren off', [hub({ mode: 'off' })], { alarm: null });
step('siren test, mode off', [hub({ mode: 'off', alarm: 'siren' })], { alarm: null, t: null });

console.log('--- D: HSM countdown, Ring quiet (zone mismatch)');
now += 5000; log.length = 0;
api.set('hubResp', { alert: 'intrusion-home-pending', alertAt: 42, alertAgeMs: 4000, alertActive: true });
await api.artemisCompanionSecuritySync();
check('HSM pending starts countdown', { t: 'entry-delay', src: 'hsm', left: 56 });
step('Ring poll with no delay must NOT end HSM countdown', [hub({ mode: 'home' })], { t: 'entry-delay', src: 'hsm' });
log.length = 0; await api.artemisCompanionSecuritySync();
check('same HSM alert again: no restart', { t: 'entry-delay', left: 55 });
api.set('hubResp', { alert: 'cancel', alertAt: 43, alertAgeMs: 0, alertActive: false });
log.length = 0; await api.artemisCompanionSecuritySync();
check('HSM cancel ends HSM countdown', { t: null });

console.log('--- E: companion version gates');
api.set('_companionAppVersion', '1.6.6'); log.length = 0; await api.artemisCompanionSecuritySync();
(log.length === 0 ? pass++ : fail++); console.log(`${log.length === 0 ? 'PASS' : 'FAIL'}  v1.6.6 never called`);
api.set('_companionAppVersion', null); log.length = 0; await api.artemisCompanionSecuritySync();
(log.length === 0 ? pass++ : fail++); console.log(`${log.length === 0 ? 'PASS' : 'FAIL'}  unknown version never called`);
api.set('_companionAppVersion', '1.6.7'); api.set('HUB_STORE', { appId: 99 }); log.length = 0; await api.artemisCompanionSecuritySync();
(log.length === 0 ? pass++ : fail++); console.log(`${log.length === 0 ? 'PASS' : 'FAIL'}  app id changed since version check: not called`);
api.set('HUB_STORE', { appId: 1 });

console.log('--- F: boot mid-countdown with stale artemisMode, then 10s HSM sync (review #1)');
api.set('artemisMode', 'disarm'); api.set('_ringPrev.seen', false); api.set('_ringPrev.entry', false); api.set('hsmResp', 'armedAway');
now += 1000; log.length = 0;
api.artemisRingSync([hub({ entryDelay: 'active', countdownTimeLeft: 60, countdownTotal: 60 }, iso(20000))]);
check('first poll, delay started 20s ago', { t: 'entry-delay', left: 40 });
log.length = 0; await api.artemisHsmSync();
check('HSM sync (armedAway vs stale disarm) keeps Ring countdown', { t: 'entry-delay', src: 'ring' });
api.set('hsmResp', 'disarmed'); log.length = 0; await api.artemisHsmSync();
check('observed real disarm clears it (backstop)', { t: null });

console.log('--- G: Ring exit ends, HSM still arming (review #3)');
api.set('artemisMode', 'disarm'); api.set('hsmResp', 'armingAway');
step('Ring exit delay starts', [hub({ exitDelay: 'active', countdownTimeLeft: 45, countdownTotal: 60 })], { t: 'arming', src: 'ring', left: 45 });
log.length = 0; await api.artemisHsmSync();
check('HSM still disarmed/arming does not clear Ring exit', { t: 'arming', src: 'ring' });
step('Ring exit ends', [hub()], { t: null }, 45);
log.length = 0; await api.artemisHsmSync();
check('HSM still says armingAway: no replayed countdown', { t: null });

console.log('--- H: non-Ring panel alarm "clear" is not a siren (review #8)');
api.set('artemisMode', 'away');
step('alarm clear, armed', [{ id: '9', cmds: ['armAway', 'disarm'], live: true, attrs: { alarmMode: 'away', alarm: 'clear' } }], { alarm: null });

console.log('--- I: late poll (throttled tab) corrects remaining (review #6)');
now += 29000; log.length = 0;
api.artemisRingSync([hub({ entryDelay: 'active', countdownTimeLeft: 60, countdownTotal: 60 }, iso(30000))]);
check('delay started 30s ago, previous poll 29s ago: capped at 29s elapsed', { t: 'entry-delay', left: 31 });

console.log('--- J: HSM stays disarmed while Ring counts down; PIN sheet must not be closed by sync (verify #1)');
api.set('artemisTransition', null); api.set('artemisMode', 'disarm'); api.set('hsmResp', 'disarmed');
log.length = 0; await api.artemisHsmSync();
api.set('_ringPrev.entry', false);
step('Ring entry starts', [hub({ entryDelay: 'active', countdownTimeLeft: 60, countdownTotal: 60 })], { t: 'entry-delay' });
log.length = 0; await api.artemisHsmSync(); await api.artemisHsmSync();
{ const closed = log.includes('close sheet'); const s = api.st(); const ok = !closed && s.t === 'entry-delay'; ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  two syncs, HSM disarmed: countdown kept, sheet not closed -> ${JSON.stringify(s)} [${log.join(' | ')}]`); }

console.log('--- K: Ring exit attribute never clears; backstop after countdown + 30s');
api.set('artemisTransition', null); api.set('artemisMode', 'away'); api.set('hsmResp', 'armedAway'); api.set('_ringPrev.exit', false); api.set('_ringPrev.entry', false);
step('Ring exit starts, 10s left', [hub({ exitDelay: 'active', countdownTimeLeft: 10, countdownTotal: 60 })], { t: 'arming', src: 'ring' });
now += 20000; log.length = 0; await api.artemisHsmSync();
check('20s later (10s past end): still shown', { t: 'arming' });
now += 25000; log.length = 0; await api.artemisHsmSync();
check('45s later (35s past end): backstop clears it', { t: null });

console.log('--- L: command routing to alarm panels');
async function route(label, devices, selectedId, hsmCmd, expectCmd) {
  api.set('_artemisAlarmDevices', devices); api.set('CONFIG.artemisRingDeviceId', selectedId);
  log.length = 0; await api.artemisAlarmPanelCmd(hsmCmd);
  const got = log.filter(l => l.startsWith('CMD')).join(' | ') || '(none)';
  const ok = got === expectCmd; ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  ->  ${got}`);
}
const community = (mode) => ({ id: '204', cmds: ['setMode', 'siren', 'off'], live: true, official: false, attrs: { mode } });
const deadOfficial = { id: '240', cmds: ['armAway', 'armHome', 'disarm', 'createChildDevices'], live: false, official: true, attrs: { alarm: 'off' } };
const liveOfficial = (alarmMode) => ({ id: '240', cmds: ['armAway', 'armHome', 'disarm', 'createChildDevices'], live: true, official: true, attrs: { alarmMode } });
await route('community, off -> Arm Away', [community('off'), deadOfficial], '204', 'armAway', 'CMD 204 setMode Away');
await route('community, away -> Arm Home', [community('away')], '204', 'armHome', 'CMD 204 setMode Home');
await route('community, away -> Disarm', [community('away')], '204', 'disarm', 'CMD 204 setMode Disarmed');
await route('community shows away (maybe stale) -> Arm Away still sent', [community('away')], '204', 'armAway', 'CMD 204 setMode Away');
await route('dead official -> arm not sent', [deadOfficial], '240', 'armAway', '(none)');
await route('dead official -> disarm still sent', [deadOfficial], '240', 'disarm', 'CMD 240 disarm');
api.set('deviceLookup', { commands: [{ command: 'setMode' }, { command: 'siren' }], attributes: { mode: 'away' } });
await route('no poll yet, saved id is community hub -> looks it up, setMode Disarmed', [], '204', 'disarm', 'CMD 204 setMode Disarmed');
api.set('deviceLookup', null);
await route('live official, disarmed -> native armAway', [liveOfficial('disarmed')], '240', 'armAway', 'CMD 240 armAway');
await route('live official, home -> disarm', [liveOfficial('home')], '240', 'disarm', 'CMD 240 disarm');
await route('no poll data yet -> native command to stored id', [], '240', 'disarm', 'CMD 240 disarm');
await route('community already off -> Disarm still sent (stale-poll safety)', [community('off')], '204', 'disarm', 'CMD 204 setMode Disarmed');
await route('no panel configured -> nothing', [], '', 'armAway', '(none)');

console.log(`\n${pass} passed, ${fail} failed`);

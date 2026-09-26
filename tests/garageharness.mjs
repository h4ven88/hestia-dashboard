// Garage door regression harness.
// Extracts the REAL functions out of dashboard.html rather than reimplementing
// them, same approach as ringharness/healthharness/cloudharness.
//
// Device shapes below mirror what Hubitat's Maker API actually returns, per
// the platform research: commands are [{command:"..."}] and may repeat, a
// relay opener (ZEN17-style) declares Switch + ContactSensor and NO
// GarageDoorControl, DoorControl is a real separate capability, and the door
// attribute is not limited to its documented enum.
import fs from 'fs';

const SRC = fs.readFileSync('C:/Users/rbodd/hestia-dashboard/dashboard.html', 'utf8');

function grab(name) {
  const start = SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error('not found: ' + name);
  let i = SRC.indexOf('{', start), depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (!depth) break; }
  }
  return SRC.slice(start, i + 1);
}

const FNS = ['_garageDev', 'garageDevCmds', '_garageDevCaps', 'garageCmdStyle',
             'garageReportsDoor', 'garageIsPulse', 'garageSend', 'garageState',
             'garageLabel', 'garageIsShut', 'garageIsUnknown', 'garageClearPending',
             'garageTap', 'garageRender', '_athenaGarageCmd', '_athenaGarageIsSafeClose',
             '_athenaGarageNeedsConfirm', '_athenaAffirmative', '_athenaNegative',
             'migrateGarageDevices', 'capToType'];

const harness = `
let lastPollDevices = [];
let rooms = [], staging = [];
const S = {}, DEVICE_TYPE = {};
const _garagePending = {}, _garagePendingAction = {}, _garagePendingAt = {};
const CONFIG = { artemisEnabled: false };
function _artemisOnSecurityView() { return false; }
function patchSecurityView() {}
const GARAGE_CONFIRM_MS = 5000;
const GARAGE_MOTION_MAX_MS = 45000;
let _garageMigrationDone = false;
const sent = [], toasts = [];
function realDeviceId(id) { return String(id).split(':')[0]; }
function cmd(id, c, v) { sent.push(String(id) + ':' + c + (v !== undefined ? ':' + v : '')); return true; }
function scheduleNextPoll() {}
function saveConfig() {} function initState() {} function snapshotState() {}
function refreshActiveView() {} function updateStats() {}
function showDeviceToast(t) { toasts.push(t); }
const document = { querySelectorAll: () => [] };
${FNS.map(grab).join('\n')}
`;

const api = new Function(harness + `
  return { S, DEVICE_TYPE, sent, toasts, _garagePending, _garagePendingAction,
           set rooms(v) { rooms = v; }, get rooms() { return rooms; },
           set staging(v) { staging = v; }, get staging() { return staging; },
           set lastPollDevices(v) { lastPollDevices = v; }, get lastPollDevices() { return lastPollDevices; },
           set _garageMigrationDone(v) { _garageMigrationDone = v; },
           garageSend, garageTap, garageState, garageLabel, garageIsShut, garageIsUnknown,
           garageReportsDoor, garageDevCmds, garageCmdStyle, garageIsPulse, garageClearPending,
           migrateGarageDevices, capToType,
           _athenaGarageCmd, _athenaGarageIsSafeClose, _athenaGarageNeedsConfirm,
           _athenaAffirmative, _athenaNegative };
`)();

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else { fail++; console.log(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
};

// 900 real opener · 901 ZEN17-style relay (NO GarageDoorControl) · 902 momentary
// 903 DoorControl-only (MyQ style) · 950 a light that happens to live in the garage
const DEVICES = [
  { id: '900', capabilities: ['GarageDoorControl', 'ContactSensor', 'Refresh'],
    commands: [{ command: 'open' }, { command: 'close' }, { command: 'refresh' }, { command: 'refresh' }],
    attributes: { door: 'closed', contact: 'closed', dataType: 'ENUM', values: ['open', 'closed'] } },
  { id: '901', capabilities: ['Switch', 'ContactSensor'],
    commands: [{ command: 'on' }, { command: 'off' }], attributes: { switch: 'off', contact: 'closed' } },
  { id: '902', capabilities: ['Momentary', 'Switch'],
    commands: [{ command: 'push' }, { command: 'on' }], attributes: { switch: 'off' } },
  { id: '903', capabilities: ['DoorControl'],
    commands: [{ command: 'open' }, { command: 'close' }], attributes: { door: 'open' } },
  { id: '950', capabilities: ['Switch'], commands: [{ command: 'on' }, { command: 'off' }], attributes: { switch: 'off' } },
];
function reset() {
  api.lastPollDevices = DEVICES;
  api.sent.length = 0; api.toasts.length = 0;
  ['900', '901', '902', '903'].forEach(id => { api.S[id] = { door: 'closed' }; api.DEVICE_TYPE[id] = 'garage'; api.garageClearPending(id); });
  api.rooms = [{ id: 'gar', name: 'Garage', switches: [], garages: [{ id: '900', name: 'Garage Door' }] }];
}

// ── command style comes from capabilities, not from guessing ──
reset();
t('GarageDoorControl is door-style', api.garageCmdStyle('900'), 'door');
t('relay with no garage capability is pulse', api.garageCmdStyle('901'), 'pulse');
t('Momentary is push-style', api.garageCmdStyle('902'), 'push');
t('DoorControl is door-style too', api.garageCmdStyle('903'), 'door');
t('unknown device has no style', api.garageCmdStyle('999'), null);
t('duplicate commands are de-duplicated', api.garageDevCmds('900'), ['open', 'close', 'refresh']);

reset(); api.garageSend('900', 'open');  t('door-style opens with open', api.sent.slice(), ['900:open']);
reset(); api.garageSend('900', 'close'); t('door-style closes with close', api.sent.slice(), ['900:close']);
reset(); api.garageSend('903', 'close'); t('DoorControl closes with close', api.sent.slice(), ['903:close']);
reset(); api.garageSend('901', 'open');  t('relay opens with on', api.sent.slice(), ['901:on']);
reset(); api.garageSend('901', 'close'); t('relay closes with the same pulse', api.sent.slice(), ['901:on']);
reset(); api.garageSend('902', 'open');  t('momentary uses push', api.sent.slice(), ['902:push']);

// A plain Switch reclassified as a garage IS operable as a pulse: that is the
// documented remedy for relay openers, which never declare a door capability.
reset();
api.DEVICE_TYPE['950'] = 'garage'; api.S['950'] = { door: 'closed' };
t('a switch typed as a garage is pulse-operable', api.garageCmdStyle('950'), 'pulse');
api.garageSend('950', 'open');
t('...and pulses it', api.sent.slice(), ['950:on']);

// But hardware with no way to be operated must never be guessed at.
reset();
api.lastPollDevices = DEVICES.concat([{ id: '960', capabilities: ['ContactSensor'], commands: [{ command: 'refresh' }], attributes: { contact: 'closed' } }]);
api.DEVICE_TYPE['960'] = 'garage'; api.S['960'] = { door: 'closed' };
t('a sensor-only device has no command style', api.garageCmdStyle('960'), null);
api.garageSend('960', 'open');
t('...nothing is sent', api.sent.slice(), []);
t('...the user is told why', api.toasts.length, 1);

reset();
api.lastPollDevices = [];
api.garageSend('900', 'open');
t('a cold poll cache sends nothing', api.sent.slice(), []);
t('...and says to wait for the hub', /Waiting for the hub/.test(api.toasts[0] || ''), true);

// ── confirm gate ──
reset();
api.garageTap('900');                 t('first tap sends nothing', api.sent.slice(), []);
api.garageTap('900');                 t('second tap opens', api.sent.slice(), ['900:open']);
reset();
api.S['900'].door = 'open';
api.garageTap('900');                 t('door-style close is one tap', api.sent.slice(), ['900:close']);

// a pulse opener's "close" can open the door, so it is confirmed too
reset();
api.S['901'].door = 'open';
api.garageTap('901', 'close');         t('pulse close needs confirming', api.sent.slice(), []);
api.garageTap('901', 'close');         t('...then it fires', api.sent.slice(), ['901:on']);

// tapping the other direction re-arms rather than firing what was armed
reset();
api.S['900'].door = 'unknown';
api.garageTap('900', 'open');
api.garageTap('900', 'close');
t('an armed open does not fire from a close tap', api.sent.slice(), ['900:close']);
reset();
api.S['901'].door = 'unknown';
api.garageTap('901', 'open');
api.garageTap('901', 'close');
t('pulse: switching direction re-arms, sends nothing', api.sent.slice(), []);

// ── state honesty ──
reset();
t('unrecognised value is unknown', (api.S['900'].door = 'stopped', api.garageState('900')), 'unknown');
t('driver "?" is unknown', (api.S['900'].door = '?', api.garageState('900')), 'unknown');
t('missing state is unknown', (api.S['900'] = {}, api.garageState('900')), 'unknown');
t('unknown is never shut', api.garageIsShut('900'), false);
reset();
api.S['900'] = { door: 'opening', moveAt: Date.now() };
t('motion shows while it is fresh', api.garageState('900'), 'opening');
api.S['900'].moveAt = Date.now() - 46000;
t('a driver stuck in motion ages out to unknown', api.garageState('900'), 'unknown');
t('label for unknown', api.garageLabel('900'), 'Unknown');

// ── classification ──
t('GarageDoorControl classifies as garage', api.capToType(['GarageDoorControl'], 'Main Door'), 'garage');
t('DoorControl classifies as garage', api.capToType(['DoorControl'], 'Main Door'), 'garage');
t('relay named "Garage Door" classifies as garage', api.capToType(['Switch', 'ContactSensor'], 'Garage Door Opener'), 'garage');
t('"Garage Light" stays a switch', api.capToType(['Switch'], 'Garage Light'), 'switch');
t('"Garage Fan" is not a door', api.capToType(['Switch'], 'Garage Fan') !== 'garage', true);
t('"Garage" alone is not a door', api.capToType(['Switch'], 'Garage') !== 'garage', true);
t('"Garage Door Sensor" is not a door control', api.capToType(['Switch'], 'Garage Door Sensor') !== 'garage', true);

// ── migration: capability only, never by name ──
reset();
api.rooms = [{ id: 'gar', name: 'Garage', switches: [{ id: '900', name: 'Garage Door' }, { id: '950', name: 'Garage Light' }], garages: [] }];
api.staging = [];
api._garageMigrationDone = false;
api.migrateGarageDevices(api.lastPollDevices);
t('real opener moves out of switches', api.rooms[0].garages.map(g => g.id), ['900']);
t('a light named "garage" is left alone', api.rooms[0].switches.map(s => s.id), ['950']);
api._garageMigrationDone = true;
api.rooms = [{ id: 'g', name: 'G', switches: [{ id: '900', name: 'D' }], garages: [] }];
api.migrateGarageDevices(api.lastPollDevices);
t('migration runs only once', api.rooms[0].switches.length, 1);

// ── Athena gating: allow-list of what is safe ──
reset();
api.DEVICE_TYPE['10'] = 'switch';
const g = (id, c) => ({ deviceId: id, command: c });
t('open is gated', api._athenaGarageNeedsConfirm(g('900', 'open')), true);
t('close on door-style hardware is allowed', api._athenaGarageNeedsConfirm(g('900', 'close')), false);
t('"open " with whitespace is still gated', api._athenaGarageNeedsConfirm(g('900', 'open ')), true);
t('"push" is gated', api._athenaGarageNeedsConfirm(g('900', 'push')), true);
t('"toggle" is gated', api._athenaGarageNeedsConfirm(g('900', 'toggle')), true);
t('"on" is gated', api._athenaGarageNeedsConfirm(g('900', 'on')), true);
t('a driver-specific command is gated', api._athenaGarageNeedsConfirm(g('900', 'setDoor')), true);
t('an empty command is gated', api._athenaGarageNeedsConfirm(g('900', '')), true);
t('close on a PULSE opener is gated (same pulse opens)', api._athenaGarageNeedsConfirm(g('901', 'close')), true);
t('a light is never gated', api._athenaGarageNeedsConfirm(g('10', 'on')), false);

['yes', 'Yeah', 'yep', 'sure', 'confirm', 'do it', 'go ahead'].forEach(w =>
  t('affirmative: ' + w, api._athenaAffirmative(w), true));
['no', 'nope', 'cancel', 'stop', 'never mind', "don't"].forEach(w =>
  t('negative: ' + w, api._athenaNegative(w), true));
t('unrelated speech is neither', [api._athenaAffirmative('turn on the lights'), api._athenaNegative('turn on the lights')], [false, false]);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

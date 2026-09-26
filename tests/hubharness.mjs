// Hub URL per-device resolution: SRamsdell's reload sequence and the May
// cross-device propagation bug, against the real functions.
import fs from 'fs';
const src = fs.readFileSync('C:/Users/rbodd/hestia-dashboard/dashboard.html', 'utf8');
function extractFn(name) {
  const m = new RegExp('function ' + name + '\\s*\\(').exec(src);
  if (!m) throw new Error('missing ' + name);
  let depth = 0;
  for (let j = src.indexOf('{', m.index); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(m.index, j + 1);
  }
}
const code = ['isServedFromHub', '_hubUrlForThisDevice', '_hubUrlToShare'].map(extractFn).join('\n');

// One simulated device = its own page location + its own CONFIG.
function device(pageUrl) {
  const loc = new URL(pageUrl);
  return new Function('window', `
    let CONFIG = { hub: '' }, _sharedHubUrl = null;
    ${code}
    return {
      // what applyParsedConfig() now does with a synced/cached config
      load(sharedHub) { CONFIG.hub = sharedHub; _sharedHubUrl = CONFIG.hub; CONFIG.hub = _hubUrlForThisDevice(CONFIG.hub); },
      // Mirrors dashboard.html:15865-15867 exactly. The assignment to
      // _sharedHubUrl is UNCONDITIONAL there -- an earlier draft of this stub
      // guarded it with "if (v !== CONFIG.hub)", which silently inverted the
      // meaning of the "edit becomes the shared value" case below: on a
      // hub-served page CONFIG.hub is already the page origin, so the guard
      // was always false and a deliberate edit never propagated.
      // If this stub and those lines ever diverge again, this suite is
      // testing fiction.
      saveSettings(fieldValue) { const v = fieldValue.trim(); _sharedHubUrl = v; CONFIG.hub = _hubUrlForThisDevice(v); },
      connectsWith: () => CONFIG.hub,
      shares: () => _hubUrlToShare(),
    };
  `)({ location: { hostname: loc.hostname, origin: loc.origin, protocol: loc.protocol } });
}
let pass = 0, fail = 0;
const eq = (label, got, want) => { const ok = got === want; ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${got}${ok ? '' : '  (want ' + want + ')'}`); };

console.log('--- SRamsdell: Safari tab on https://192.168.1.50/local/index.html, saved hub is http://');
let safari = device('https://192.168.1.50/local/index.html');
safari.load('http://192.168.1.50');
eq('reload connects with the page origin, not blocked http', safari.connectsWith(), 'https://192.168.1.50');
eq('does not rewrite what other devices get', safari.shares(), 'http://192.168.1.50');
safari.saveSettings('https://192.168.1.50');
eq('edits hub URL to https: connects', safari.connectsWith(), 'https://192.168.1.50');
eq('edit becomes the shared value', safari.shares(), 'https://192.168.1.50');
safari = device('https://192.168.1.50/local/index.html'); safari.load('https://192.168.1.50');
eq('close + reopen tab: still https (no strip)', safari.connectsWith(), 'https://192.168.1.50');

console.log('--- Same household, Chrome on http://192.168.1.50/local/index.html receives the https value');
const chromeHttp = device('http://192.168.1.50/local/index.html'); chromeHttp.load('https://192.168.1.50');
eq('http page uses its own origin (no cert needed)', chromeHttp.connectsWith(), 'http://192.168.1.50');
// Saving unrelated settings re-submits whatever the hub field holds, and
// dashboard.html:15326 populates that field from _hubUrlToShare() -- the
// SHARED url, not this device's own origin. Passing connectsWith() here
// modelled a field that shows CONFIG.hub, which is not what ships.
chromeHttp.saveSettings(chromeHttp.shares());
eq('saving other settings does not push http back to everyone', chromeHttp.shares(), 'https://192.168.1.50');

console.log('--- hestari.com devices are never substituted');
const cloud = device('https://hestari.com/'); cloud.load('https://192.168.1.50:8443');
eq('hestari.com uses the shared URL as-is', cloud.connectsWith(), 'https://192.168.1.50:8443');
eq('and shares it unchanged', cloud.shares(), 'https://192.168.1.50:8443');
const cloudBare = device('https://hestari.com/'); cloudBare.load('https://192.168.1.50');
eq('bare https private IP is no longer stripped to http', cloudBare.connectsWith(), 'https://192.168.1.50');

console.log('--- Hub on :8443 page');
const p8443 = device('https://192.168.1.50:8443/local/index.html'); p8443.load('http://192.168.1.50');
eq('8443 page connects on 8443', p8443.connectsWith(), 'https://192.168.1.50:8443');

console.log('--- Page served from a different address than the configured hub');
const other = device('http://192.168.1.99/local/index.html'); other.load('http://192.168.1.50');
eq('different host: leave configured hub alone', other.connectsWith(), 'http://192.168.1.50');

console.log('--- Changing to a new hub IP from a hub-served page');
const moving = device('https://192.168.1.50/local/index.html'); moving.load('http://192.168.1.50');
moving.saveSettings('http://192.168.1.77');
eq('connects to the new hub', moving.connectsWith(), 'http://192.168.1.77');
eq('new hub address is shared', moving.shares(), 'http://192.168.1.77');

console.log(`\n${pass} passed, ${fail} failed`);

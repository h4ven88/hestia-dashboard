// Cloud-config adoption trust + alarm panel ranking, against the real code.
import fs from 'fs';
const src = fs.readFileSync('C:/Users/rbodd/hestia-dashboard/dashboard.html', 'utf8');
function fn(name) {
  const m = new RegExp('(async )?function ' + name + '\\s*\\(').exec(src);
  if (!m) throw new Error('missing ' + name);
  let d = 0;
  for (let j = src.indexOf('{', m.index); j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}' && --d === 0) return src.slice(m.index, j + 1);
  }
}
const cloudCode = ['_cloudHouseholdId', '_cloudLocalHouseholdId', '_cloudConfigTrusted', '_cloudRememberHousehold', 'cloudOfferConfig', 'cloudAdoptConfig', 'cloudDeclineConfig'].map(fn).join('\n');

function world(localCfg, store = {}) {
  const log = [];
  const api = new Function('__log', `
    // Mirrors dashboard.html's module-level _HID_RE and _householdIdLocal(),
    // which _cloudHouseholdId/_cloudLocalHouseholdId now depend on.
    // cloudAdoptConfig() persists through this helper so a discovered config
    // (which never carries the household secret) cannot delete the one this
    // device holds. Mirrors dashboard.html's _persistConfigKeepingSecret.
    function _cloudHasSecret() { return !!CONFIG.cloudSecret; }
    function _persistConfigKeepingSecret(cfg) {
      if (cfg && cfg.config && !cfg.config.cloudSecret && _cloudHasSecret()) {
        cfg = { ...cfg, config: { ...cfg.config, cloudSecret: CONFIG.cloudSecret } };
      }
      _store['dashboard-config'] = JSON.stringify(cfg);
    }
    const CLOUD_HOUSEHOLD_KEY = 'hestia-cloud-household';
    const CLOUD_DECLINED_KEY  = 'hestia-cloud-declined';
    let _cloudPendingConfig = null;
    /* The household id whose record the last discover decrypted with THIS
       device's secret; _cloudConfigTrusted() treats that as proof of
       ownership. Null here on purpose: this harness tests the OTHER two trust
       routes (own hub, previously accepted household), so nothing has vouched.
       Missing it entirely crashed the suite, which runall reported as
       "NO SUMMARY" rather than a pass — the MISSING-suite guard working. */
    let _cloudSecretDecryptedId = null;
    let CONFIG = ${JSON.stringify(localCfg)};
    const _store = ${JSON.stringify(store)};
    const localStorage = { getItem: k => (k in _store ? _store[k] : null), setItem: (k, v) => { _store[k] = String(v); }, removeItem: k => { delete _store[k]; } };
    // The app reaches storage through _LS now (namespaced in the sandbox build).
    const _LS = localStorage;
    const els = { 'cloud-adopt-banner': { classList: { _v: false, add(){ this._v = true; }, remove(){ this._v = false; } } }, 'cloud-adopt-msg': { textContent: '' } };
    const document = { getElementById: id => els[id] || null };
    const console = { log: m => __log(m) };
    const location = { reload: () => __log('RELOAD') };
    ${cloudCode}
    return { trusted: c => _cloudConfigTrusted(c), offer: c => cloudOfferConfig(c), adopt: () => cloudAdoptConfig(), decline: () => cloudDeclineConfig(),
      banner: () => ({ visible: els['cloud-adopt-banner'].classList._v, msg: els['cloud-adopt-msg'].textContent }), store: () => _store };
  `)(m => log.push(String(m)));
  api.log = log;
  return api;
}
const cfg = (hub, appId) => ({ config: { hub, appId, token: 'secret-token' } });
let pass = 0, fail = 0;
const check = (label, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`); };

console.log('--- Trust decisions');
let w = world({ hub: 'https://192.168.50.139:8443', appId: '219' });
check('same hub + same Maker app: trusted (scheme/port differ)', w.trusted(cfg('http://192.168.50.139', '219')) === true);
check('same hub, different Maker app: not trusted', w.trusted(cfg('http://192.168.50.139', '777')) === false);
check('different hub entirely: not trusted', w.trusted(cfg('http://192.168.1.50', '219')) === false);
check('malformed hub in cloud config: not trusted', w.trusted({ config: { hub: 'not a url', appId: '219' } }) === false);
check('cloud config missing hub/appId: not trusted', w.trusted({ config: {} }) === false && w.trusted(null) === false);

w = world({ hub: '', appId: '' });
check('brand-new device (no local config): not trusted', w.trusted(cfg('http://192.168.1.50', '219')) === false);
w = world({ hub: '', appId: '' }, { 'hestia-cloud-household': '192.168.1.50|219' });
check('previously accepted household: trusted', w.trusted(cfg('http://192.168.1.50', '219')) === true);
check('accepted one household does not trust another', w.trusted(cfg('http://192.168.1.77', '219')) === false);

console.log('--- The IP-reassignment case: stranger opens hestari.com');
w = world({ hub: '', appId: '' });
const victim = cfg('http://192.168.50.139', '219');
check('not trusted, so boot must not apply it', w.trusted(victim) === false);
w.offer(victim);
let b = w.banner();
check('asks instead of adopting', b.visible && /Use them on this device\?/.test(b.msg), b.msg);
check('names the hub so the user can tell it is not theirs', /192\.168\.50\.139/.test(b.msg));
check('nothing stored, nothing applied yet', !('hestia-cloud-household' in w.store()) && !w.log.includes('RELOAD'));
w.decline();
check('declining records it', w.store()['hestia-cloud-declined'] === '192.168.50.139|219' && !w.banner().visible);
w.offer(victim);
check('declined household is not offered again', !w.banner().visible);

console.log('--- Genuine new device in the household');
w = world({ hub: '', appId: '' });
w.offer(cfg('http://192.168.50.139', '219'));
check('offered', w.banner().visible);
w.adopt();
check('accepting stores the household and reloads', w.store()['hestia-cloud-household'] === '192.168.50.139|219' && w.log.includes('RELOAD'));
check('accepting saves the config locally for the next boot', !!w.store()['dashboard-config']);
w = world({ hub: '', appId: '' }, { 'hestia-cloud-household': '192.168.50.139|219' });
check('after accepting once, later boots trust it silently', w.trusted(cfg('http://192.168.50.139', '219')) === true);

console.log('--- While a prompt is pending, this device must not overwrite their cloud entry');
{
  const pushed = [];
  const run = pending => new Function('__pushed', `
    let _cloudPendingConfig = ${pending ? '{ config: { hub: "http://192.168.50.139", appId: "219" } }' : 'null'};
    let _lastCloudPushAt = 0, _cloudSyncDebounce = null;
    const HESTIA_VERSION = '1.6.7';
    const CLOUD_SYNC_API = '/api/config';
    function clearTimeout(){} function setTimeout(){}
    function sbxBlocked(){ return false; }   // not the sandbox build
    function _cloudGetIp(){ __pushed('GET IP'); return Promise.resolve('1.2.3.4'); }
    function _cloudEncrypt(){ return Promise.resolve({ iv: 'x', data: 'y' }); }
    // cloudSyncPush now derives its key from the household secret and emits a
    // service half alongside the ciphertext. Mirrors of the real dependencies:
    let _cloudLastPushError = null;
    const CONFIG = { cloudSecret: 'f'.repeat(64) };
    const deepClone = (o) => JSON.parse(JSON.stringify(o));
    function _cloudKey(){ return Promise.resolve('KEY'); }
    function _cloudEncryptWithKey(){ return Promise.resolve({ iv: 'x', data: 'y' }); }
    function _cloudTokenHash(){ return Promise.resolve('hash'); }
    function buildServiceHalf(){ return { tokenHash: 'hash' }; }
    function fetch(){ __pushed('PUT'); return Promise.resolve({ ok: true }); }
    const console = { log(){}, warn(){} };
    ${fn('cloudSyncPush')}
    cloudSyncPush({ config: { token: 'mine' } });
  `)(m => pushed.push(m));
  pushed.length = 0; run(true);
  check('pending prompt: no push at all', pushed.length === 0, pushed.join('|'));
  pushed.length = 0; run(false);
  check('no pending prompt: pushes normally', pushed.includes('GET IP'), pushed.join('|'));
}

console.log('--- Settings toggles must not merge an untrusted household list');
{
  const merged = [];
  const run = async trusted => {
    const api = new Function('__merged', `
      let CONFIG = { hub: 'http://192.168.50.139', appId: '219', pushDevices: [{ id: 'mine' }] };
      let HUB_STORE = null;
      const strangerCfg = { config: { hub: 'http://10.0.0.5', appId: '999', pushDevices: [{ id: 'stranger' }] }, savedAt: 9999 };
      async function loadConfigFromHub(){ return null; }
      async function cloudSyncDiscover(){ return strangerCfg; }
      function _cloudConfigTrusted(){ return ${trusted}; }
      ${fn('mergeDeviceListField')}
      return { go: () => mergeDeviceListField('pushDevices', list => list), get: () => CONFIG.pushDevices };
    `)(m => merged.push(m));
    await api.go();
    return api.get();
  };
  const untrustedResult = await run(false);
  check("untrusted: keeps this device's own list", JSON.stringify(untrustedResult) === '[{"id":"mine"}]', JSON.stringify(untrustedResult));
  const trustedResult = await run(true);
  check('trusted: merges the household list as before', JSON.stringify(trustedResult) === '[{"id":"stranger"}]', JSON.stringify(trustedResult));
}

console.log('--- Alarm panel ranking (the shipped expression)');
const rankLine = /const rank = d => \(d\.delayAware[^;]+;/.exec(src);
const rank = new Function('return ' + rankLine[0].replace('const rank = ', '').replace(/;$/, ''))();
const community = { id: '204', delayAware: true, live: true, official: false };
const officialDead = { id: '240', delayAware: false, live: false, official: true };
const officialLiveNoDelays = { id: '240', delayAware: false, live: true, official: true };
const officialFull = { id: '240', delayAware: true, live: true, official: true };
const best = list => list.slice().sort((x, y) => rank(y) - rank(x))[0].id;
check('today: community hub wins over the dead official base station', best([officialDead, community]) === '204');
check('official reports a mode but no delays: community still wins', best([officialLiveNoDelays, community]) === '204', `(${rank(officialLiveNoDelays)} vs ${rank(community)})`);
check('official matures (reports delays): it takes over', best([officialFull, community]) === '240');
check('nothing live: official still preferred over a silent community panel', best([officialDead, { id: '204', delayAware: false, live: false, official: false }]) === '240');

console.log(`\n${pass} passed, ${fail} failed`);

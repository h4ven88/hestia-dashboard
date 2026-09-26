import fs from 'fs';
const src = fs.readFileSync('C:/Users/rbodd/hestia-dashboard/dashboard.html', 'utf8');
function extractFn(name) {
  const m = new RegExp('(async )?function ' + name + '\\s*\\(').exec(src);
  let depth = 0;
  for (let j = src.indexOf('{', m.index); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(m.index, j + 1);
  }
}
const rStart = src.indexOf('async function diagRelinkCompanion(');
const rEnd = src.indexOf('async function diagCheckGroovy(', rStart);
const code = src.slice(rStart, rEnd) + '\n' + extractFn('isLocalHubUrl');

function world(opts) {
  return new Function('opts', `
    const calls = [];
    const els = { 'diag-relink-input': { value: opts.paste }, 'diag-relink-result': { textContent: '', style: {} }, 'diag-relink-btn': { disabled: false } };
    const document = { getElementById: id => els[id] || null };
    let CONFIG = { hub: opts.hub, hestiaAppId: '111', hestiaAppToken: 'old-token-xyz' };
    let HUB_STORE = { appId: '111', token: 'old-token-xyz', _hubUrl: opts.hub };
    let _companionAppVersion = '1.6.6', _companionAppVersionFor = '111', breakerResets = 0;
    function _breakerReset(){ breakerResets++; }
    async function saveConfig(){ calls.push('saveConfig'); }
    function diagCheckGroovy(){ calls.push('diagCheckGroovy'); }
    async function hubStoreFetch(path, f, o){
      calls.push('probe ' + o.store._hubUrl + ' app ' + o.store.appId + ' isolated=' + !!o.isolated + ' globalStillOld=' + (HUB_STORE.appId === '111'));
      return opts.accept ? { ok: true, res: { json: async () => ({ appVersion: '1.6.7' }) } } : { ok: false, res: null };
    }
    ${code}
    return { run: diagRelinkCompanion, st: () => ({ msg: els['diag-relink-result'].textContent, hubStore: HUB_STORE.appId, cfg: CONFIG.hestiaAppId, ver: _companionAppVersion, verFor: _companionAppVersionFor, calls, breakerResets, btn: els['diag-relink-btn'].disabled }) };
  `)(opts);
}
let pass = 0, fail = 0;
async function t(label, opts, check) {
  const w = world(opts); await w.run(); const s = w.st();
  const ok = check(s); ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ${JSON.stringify(s)}`);
}
const good = JSON.stringify({ appId: '342', token: '3f9e2a10-aaaa-bbbb-cccc-1234567890ab', hubIp: '192.168.50.139', version: '1.6.7' });

await t('valid paste, hub accepts: installs new id, syncs', { hub: 'https://192.168.50.139:8443', paste: good, accept: true },
  s => s.hubStore === '342' && s.cfg === '342' && s.ver === '1.6.7' && s.verFor === '342' && s.calls.includes('saveConfig') && s.calls[0].includes('globalStillOld=true') && s.calls[0].includes('isolated=true') && !s.btn);
await t('valid paste, hub rejects: nothing changes, no save', { hub: 'https://192.168.50.139:8443', paste: good, accept: false },
  s => s.hubStore === '111' && s.cfg === '111' && !s.calls.includes('saveConfig') && s.breakerResets === 0 && !s.btn);
await t('no hub configured: refused before any request', { hub: '', paste: good, accept: true },
  s => s.calls.length === 0 && s.hubStore === '111');
await t('non-local hub: refused before any request', { hub: 'https://example.com', paste: good, accept: true },
  s => s.calls.length === 0);
await t('file from a different hub IP: refused', { hub: 'http://192.168.50.10', paste: good, accept: true },
  s => s.calls.length === 0 && /192\.168\.50\.139/.test(s.msg));
await t('.local hub name: IP check skipped, proceeds', { hub: 'http://hubitat.local', paste: good, accept: true },
  s => s.hubStore === '342');
await t('garbage paste: friendly error', { hub: 'http://192.168.50.139', paste: '<html>login</html>', accept: true },
  s => s.calls.length === 0 && /discovery file/.test(s.msg));
await t('missing token: refused', { hub: 'http://192.168.50.139', paste: JSON.stringify({ appId: '342' }), accept: true },
  s => s.calls.length === 0);
await t('injection attempt in appId: refused', { hub: 'http://192.168.50.139', paste: JSON.stringify({ appId: '342/../../x', token: 'aaaaaaaaaaaa' }), accept: true },
  s => s.calls.length === 0);
console.log(`\n${pass} passed, ${fail} failed`);

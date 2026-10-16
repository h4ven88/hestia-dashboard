/* The disarm PIN: that it is actually checked, and that it cannot be wiped.
 *
 * WHY THIS SUITE EXISTS. A real household typed a WRONG PIN and the house
 * disarmed. Nothing was comparing anything: artemisPin was an empty string on
 * the hub, in the cloud record and on every device, and verifyPin() returns
 * true when nothing is stored. The keypad still said "Enter PIN to disarm" and
 * still accepted any digits, so there was no way to tell from any screen.
 *
 * The PIN was lost at dashboard.html's boot branch for a device with no local
 * config: loadConfigFromHub() returns null for EVERY failure -- breaker open,
 * timeout, non-OK, bad parse -- which boot could not tell from "the hub holds
 * no config", so it saved CONFIG to the hub and the cloud. On such a device
 * CONFIG is DEFAULTS, so one transient read failure republished empty PIN
 * hashes and an empty PIN salt over the household's real record, and every
 * other device then loaded the blank copy. v2.0.2's lesson in a new field: one
 * device starting fresh takes the household with it.
 *
 * Everything below runs the REAL brace-extracted functions with real WebCrypto.
 *
 * Run: node tests/pinguard.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf8');
const GROOVY = fs.readFileSync(path.join(ROOT, 'HestiaDashboard.groovy'), 'utf8');

function fn(name) {
  const m = new RegExp('(async )?function ' + name + '\\s*\\(').exec(SRC);
  if (!m) throw new Error('missing ' + name + ' in dashboard.html');
  let d = 0;
  for (let j = SRC.indexOf('{', m.index); j < SRC.length; j++) {
    if (SRC[j] === '{') d++;
    else if (SRC[j] === '}' && --d === 0) return SRC.slice(m.index, j + 1);
  }
}

/* Comments stripped before any assertion over source text. Three false greens
   in one release series came from a test matching the prose above the code it
   meant to check -- once from a comment that named the very call that had been
   deleted. */
function codeOnly(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, ' ')
          .split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
}

let PASS = 0, FAIL = 0;
const check = (l, c, x = '') => { c ? PASS++ : FAIL++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${x ? `  ${x}` : ''}`); };

/* ── 1. The check itself ─────────────────────────────────────────────── */
console.log('=== 1. verifyPin compares what it claims to compare ===');
{
  const api = new Function('crypto', 'TextEncoder', `
    const _PIN_SALT = 'hestia-static';
    const CONFIG = { pinInstallSalt: '' };
    function saveConfig(){ return Promise.resolve(); }
    ${['getPinInstallSalt', 'hashPin', 'pinIsHashed', 'verifyPin'].map(fn).join('\n\n')}
    return { CONFIG, hashPin, verifyPin, pinIsHashed };
  `)(globalThis.crypto, TextEncoder);

  const stored = await api.hashPin('123456');
  check('the right PIN verifies', (await api.verifyPin('123456', stored)) === true);
  /* The exact report: six-digit PIN set, five digits typed, house disarmed. */
  check('a PREFIX of the right PIN does not', (await api.verifyPin('12345', stored)) === false,
    'the reported bug, stated as an assertion');
  check('a longer string containing it does not', (await api.verifyPin('1234567', stored)) === false);
  check('a different PIN does not', (await api.verifyPin('654321', stored)) === false);
  check('an empty entry does not', (await api.verifyPin('', stored)) === false);

  /* Documented behaviour, kept deliberately: a household running without a PIN
     must not be locked out of its own house. It is only safe because the UI
     below can no longer present it as a PIN challenge. */
  check('with NOTHING stored, anything is accepted', (await api.verifyPin('1', '')) === true,
    'policy, not an accident -- the UI must say so, see section 4');
}

/* ── 2. A blank config cannot take a held PIN with it ────────────────── */
console.log('\n=== 2. applyParsedConfig refuses to be wiped ===');
{
  const makeEnv = (held) => {
    const api = new Function('__held', `
      const ARTEMIS_SENSOR_DEFAULTS = { contacts: [], motions: [], smokes: [], waters: [], glass: [] };
      const CONFIG = Object.assign({}, __held);
      let _sharedHubUrl = null;
      const console = { log(){}, warn(){} };
      function _hubUrlForThisDevice(u){ return u; }
      ${['pinTouched', '_mergePinFields', 'applyParsedConfig'].map(fn).join('\n\n')}
      return { CONFIG, applyParsedConfig, pinTouched };
    `)(held);
    return api;
  };

  const HELD = {
    artemisPin: 'a'.repeat(128), settingsPin: 'b'.repeat(128),
    pinInstallSalt: 'c'.repeat(32), pinChangedAt: 5000,
  };

  /* THE WIPE. A device with no local config sends DEFAULTS: empty PINs, empty
     salt, and pinChangedAt 0 because it has never knowingly set one. */
  const wipe = makeEnv(HELD);
  wipe.applyParsedConfig({ config: { artemisPin: '', settingsPin: '', pinInstallSalt: '', pinChangedAt: 0 } });
  check('a defaults-only config does not clear the disarm PIN',
    wipe.CONFIG.artemisPin === HELD.artemisPin, `got len ${wipe.CONFIG.artemisPin.length}`);
  check('...nor the settings PIN', wipe.CONFIG.settingsPin === HELD.settingsPin);
  check('...nor the PIN salt', wipe.CONFIG.pinInstallSalt === HELD.pinInstallSalt,
    'every stored hash derives from it; clearing it orphans both PINs at once');
  check('...and our own change stamp survives', wipe.CONFIG.pinChangedAt === 5000);

  /* An older client predating the field sends no stamp at all, which must read
     the same as zero rather than as "newer than everything". */
  const old = makeEnv(HELD);
  old.applyParsedConfig({ config: { artemisPin: '', settingsPin: '' } });
  check('a client with no pinChangedAt field at all cannot clear either',
    old.CONFIG.artemisPin === HELD.artemisPin && old.CONFIG.settingsPin === HELD.settingsPin);

  /* Removal still has to work, or the guard has merely broken a feature. */
  const removed = makeEnv(HELD);
  removed.applyParsedConfig({ config: { artemisPin: '', settingsPin: HELD.settingsPin, pinChangedAt: 9000 } });
  check('a deliberate Remove PIN DOES propagate', removed.CONFIG.artemisPin === '',
    'a newer stamp is what a removal carries and a blank device does not');
  check('...without disturbing the other PIN', removed.CONFIG.settingsPin === HELD.settingsPin);
  check('...and adopts the newer stamp', removed.CONFIG.pinChangedAt === 9000);

  /* Setting a PIN from another device must still arrive. Non-empty always wins:
     the guard is about blanks, not about recency in general. */
  const set = makeEnv(HELD);
  set.applyParsedConfig({ config: { artemisPin: 'd'.repeat(128), pinChangedAt: 0 } });
  check('a PIN set elsewhere arrives even with an older stamp',
    set.CONFIG.artemisPin === 'd'.repeat(128));

  /* A device that holds nothing must be able to receive the household's PIN. */
  const fresh = makeEnv({ artemisPin: '', settingsPin: '', pinInstallSalt: '', pinChangedAt: 0 });
  fresh.applyParsedConfig({ config: { artemisPin: HELD.artemisPin, pinInstallSalt: HELD.pinInstallSalt, pinChangedAt: 5000 } });
  check('a blank device still receives the household PIN',
    fresh.CONFIG.artemisPin === HELD.artemisPin && fresh.CONFIG.pinInstallSalt === HELD.pinInstallSalt);

  /* pinTouched is what makes a removal distinguishable. Without it every
     removal looks like an accident and stops propagating. */
  const t = makeEnv(HELD);
  const before = Date.now() - 1;
  t.pinTouched();
  check('pinTouched stamps a current time', t.CONFIG.pinChangedAt >= before);
}

/* ── 3. The stamp has to reach the other devices ─────────────────────── */
console.log('\n=== 3. pinChangedAt is actually published ===');
{
  const payload = codeOnly(fn('buildConfigPayload'));
  check('buildConfigPayload sends pinChangedAt',
    /pinChangedAt:\s*CONFIG\.pinChangedAt/.test(payload),
    'dropped here, the guard cannot tell a removal from an accident');
  check('...and still sends the PIN fields it guards',
    /artemisPin:\s*CONFIG\.artemisPin/.test(payload) &&
    /settingsPin:\s*CONFIG\.settingsPin/.test(payload) &&
    /pinInstallSalt:\s*CONFIG\.pinInstallSalt/.test(payload));
}

/* ── 4. The UI stops presenting a PIN challenge that is not one ──────── */
console.log('\n=== 4. "no PIN set" is impossible to mistake for "PIN set" ===');
{
  const ui = (cfg) => new Function('__cfg', `
    const CONFIG = __cfg;
    ${['artemisNoPinSet', 'artemisNoPinWarningHTML'].map(fn).join('\n\n')}
    return { artemisNoPinSet, artemisNoPinWarningHTML };
  `)(cfg);

  const none = ui({ artemisEnabled: true, artemisPin: '' });
  const set  = ui({ artemisEnabled: true, artemisPin: 'a'.repeat(128) });
  const off  = ui({ artemisEnabled: false, artemisPin: '' });

  check('Artemis on with no PIN is flagged', none.artemisNoPinSet() === true);
  check('...a household WITH a PIN is not', set.artemisNoPinSet() === false);
  check('...and Artemis off is not', off.artemisNoPinSet() === false,
    'nothing to warn about when the module is not armed at all');

  const warn = none.artemisNoPinWarningHTML();
  check('the warning says who can disarm', /anyone can disarm/i.test(warn), warn.slice(0, 90));
  check('...and where to fix it', /Settings/.test(warn) && /Security PIN/.test(warn));
  check('...and is announced, not just coloured', /role="alert"/.test(warn),
    'a colour alone reaches nobody using a screen reader');
  check('a household with a PIN sees no warning at all',
    set.artemisNoPinWarningHTML() === '', 'no new noise for anyone already safe');

  /* The label was the lie: "Enter PIN to disarm" over a keypad accepting
     anything. Pinned to the branch, not to the words appearing somewhere. */
  const kp = codeOnly(fn('artemisKeypadHTML'));
  check('the keypad label branches on whether a PIN exists',
    /artemisNoPinSet\(\)\s*\?/.test(kp), kp.match(/const lbl[^;]*/s)?.[0]?.slice(0, 120));
  check('...and the warning renders inside the keypad',
    /artemisNoPinWarningHTML\(\)/.test(kp));

  /* Mobile is where most disarms happen. The desktop keypad getting this right
     while the sheet did not would fix it for the minority. */
  const sheet = codeOnly(fn('artemisOpenSheet'));
  check('the mobile sheet carries the same warning',
    /artemisNoPinWarningHTML\(\)/.test(sheet) && /artemisNoPinSet\(\)/.test(sheet));

  /* With no PIN the label invites a bare tick, so the tick has to work -- and
     must still be refused when a PIN does exist. */
  for (const [name, src] of [['desktop', fn('artemisKc')], ['mobile', fn('aspKc')]]) {
    const c = codeOnly(src);
    check(`the ${name} confirm allows an empty entry only when no PIN is set`,
      /!\s*\w*[Pp]in\.length\s*&&\s*!artemisNoPinSet\(\)/.test(c), c.replace(/\s+/g, ' ').slice(0, 150));
  }

  const diag = codeOnly(fn('diagCheckPin'));
  check('Diagnostics reports a missing PIN as RED',
    /diagSetStatus\('pin',\s*'red'/.test(diag),
    'amber reads as a hint; anyone being able to disarm the house is not a hint');
  check('...and green only when one is actually set',
    /diagSetStatus\('pin',\s*'green',\s*'PIN required/.test(diag));
}

/* ── 5. The root cause: null means two different things ──────────────── */
console.log('\n=== 5. boot can tell "hub has no config" from "hub did not answer" ===');
{
  const load = codeOnly(fn('loadConfigFromHub'));
  check('every call resets the miss reason first',
    /^\s*_hubConfigMiss = 'unknown';/m.test(load),
    'a stale "absent" from an earlier call would authorise a write');
  check("'absent' is set ONLY where the hub actually answered with no config",
    (load.match(/_hubConfigMiss = 'absent'/g) || []).length === 1 &&
    /text\.trim\(\) === 'null'[^\n]*_hubConfigMiss = 'absent'/.test(load),
    load.replace(/\s+/g, ' ').slice(0, 200));
  check('a non-OK response does NOT claim the hub is empty',
    /if \(!out\.ok\) return null;/.test(load) &&
    !/if \(!out\.ok\)[^\n]*absent/.test(load));
  check('neither does a parse failure', !/catch[\s\S]*_hubConfigMiss = 'absent'/.test(load));

  /* The branch that used to publish DEFAULTS. It must now be unreachable
     unless the hub said so. Pinned to the comparison, since the identifier
     alone appears in the refusal branch too. */
  const boot = codeOnly(SRC.slice(SRC.indexOf('if (needsOnboarding())'), SRC.indexOf('// No HUB_STORE, no full URL params')));
  check('the save-defaults branch is guarded by the refusal arm before it',
    /_hubConfigMiss !== 'absent'[\s\S]{0,900}?\} else if \(hubStoreHasMakerApi\(\)\)/.test(boot),
    'an unguarded hubStoreHasMakerApi() arm is exactly the shipped bug');
  check('...and the refusal writes nothing',
    /_hubConfigMiss !== 'absent'\)\s*\{[\s\S]{0,700}?renderHubUnreadable\(\);\s*return;/.test(boot) &&
    !/_hubConfigMiss !== 'absent'\)\s*\{[\s\S]{0,700}?saveConfig\(/.test(boot),
    'every other option on that screen writes, and writing DEFAULTS is the bug');
  check('the cloud fallback still gets its turn first',
    boot.indexOf('cloudSyncDiscover()') < boot.indexOf("_hubConfigMiss !== 'absent'"),
    'a device off-LAN with the household key must still configure itself');

  const screen = codeOnly(fn('renderHubUnreadable'));
  check('the refusal screen offers a retry and nothing that writes',
    /location\.reload\(\)/.test(screen) && !/saveConfig|renderOnboarding|obFinish/.test(screen));
  check('...and says nothing was changed', /[Nn]othing has been changed/.test(screen));
}

/* ── 6. The hub holds the same line, for clients that never update ───── */
console.log('\n=== 6. the Groovy choke point ===');
{
  const g = GROOVY.replace(/\/\*[\s\S]*?\*\//g, ' ')
                  .split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
  const save = g.slice(g.indexOf('def saveConfig()'), g.indexOf('def getVersion()'));

  check('saveConfig keeps a stored PIN when an empty one arrives',
    /if \(!incoming\[k\] && prevCfg\[k\] && theirs <= ours\)[\s\S]{0,80}incoming\[k\] = prevCfg\[k\]/.test(save),
    'the one place every client passes through, including ones that never update');
  check('...for both PIN fields',
    /\["artemisPin",\s*"settingsPin"\]\.each/.test(save));
  check('...and never lets the salt be emptied, stamp or no stamp',
    /if \(!incoming\.pinInstallSalt && prevCfg\.pinInstallSalt\)/.test(save) &&
    !/pinInstallSalt[^\n]*theirs <= ours/.test(save),
    'there is no "remove salt" operation; clearing it orphans both hashes');
  check('a NEWER stamp is what lets a removal through',
    /def theirs = \(incoming\.pinChangedAt \?: 0\)/.test(save) &&
    /def ours\s*= \(prevCfg\.pinChangedAt \?: 0\)/.test(save));
  check('the stored stamp is carried forward when ours is newer',
    /if \(ours > theirs\) incoming\.pinChangedAt = ours/.test(save));
  check('the save still succeeds either way',
    /render contentType: "application\/json"[\s\S]{0,120}status":"ok/.test(save),
    'refusing the whole save would break a device that is otherwise fine');
  /* Counted, not just located. An indexOf-only version of this passed against
     a mutant that left the original in place and added a SECOND copy outside
     the try -- the first occurrence was still in the right window. Same lesson
     as the duplicate isServedFromHub(): find the definition, then count how
     many there are. */
  const occurrences = (save.match(/\["artemisPin", "settingsPin"\]/g) || []).length;
  check('there is exactly one PIN guard', occurrences === 1, `found ${occurrences}`);
  check('...and it is inside the best-effort try, so it can never reject a save',
    save.indexOf('["artemisPin", "settingsPin"]') > save.indexOf('try {') &&
    save.indexOf('["artemisPin", "settingsPin"]') < save.indexOf('catch(e)'));
}

/* ── 7. Versions move together ───────────────────────────────────────── */
console.log('\n=== 7. the five version strings agree ===');
{
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'packageManifest.json'), 'utf8'));
  const GRADLE = fs.readFileSync(path.join(ROOT, 'android/app/build.gradle.kts'), 'utf8');
  const dash = /const HESTIA_VERSION\s*=\s*'([^']+)'/.exec(SRC)[1];
  const app = /APP_VERSION\s*=\s*"([^"]+)"/.exec(GROOVY)[1];
  const hdr = /Hestia™ Home Dashboard v([0-9.]+)/.exec(GROOVY)[1];
  const apk = /versionName\s*=\s*"([^"]+)"/.exec(GRADLE)[1];
  check('dashboard, manifest, APP_VERSION, the Groovy header and the app all match',
    dash === manifest.version && dash === app && dash === hdr && dash === apk,
    `${dash} / ${manifest.version} / ${app} / ${hdr} / ${apk}`);
  /* The Android string was the fifth place, found already drifted at 2.2.0
     against a 2.2.1 release -- while a comment beside it claimed build.js kept
     it in step. build.js checks it now; this asserts the check exists, since a
     passing build proves nothing about a check that was deleted. */
  const BUILDJS = fs.readFileSync(path.join(ROOT, 'build.js'), 'utf8');
  check('build.js refuses a build when the Android version drifts',
    /checkVersion\('Android versionName', 'android\/app\/build\.gradle\.kts'/.test(BUILDJS));
  check('the manifest release-notes URL points at this tag',
    manifest.releaseNotes.endsWith('/v' + dash), manifest.releaseNotes);
  /* HPM parses this file with JsonSlurper, which does NOT tolerate a BOM.
     One shipped once and every local check passed, because require() strips it. */
  const raw = fs.readFileSync(path.join(ROOT, 'packageManifest.json'));
  check('the manifest has no UTF-8 BOM',
    !(raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf));
}

console.log('\n=== 8. Release signing cannot leak, and cannot block a build ===');
{
  const GRADLE = fs.readFileSync(path.join(ROOT, 'android/app/build.gradle.kts'), 'utf8');

  /* The repository is public. A signing key in it lets anyone publish an
     update Android accepts as genuinely Hestia, which is worse than any bug
     this project has shipped. Asserted on the real .gitignore rather than on
     the intention, because "deliberately kept local but not ignored" is the
     state this project has already been burned by once. */
  const IGNORE = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  check('keystores are ignored', /^\*\.jks$/m.test(IGNORE) && /^\*\.keystore$/m.test(IGNORE));
  check('...and so is the file holding their passwords',
    /^android\/keystore\.properties$/m.test(IGNORE));
  /* NOT "the file does not exist". It asserted that once, which was true only
     because a throwaway key had just been deleted -- and it broke the moment
     the maintainer created a real one, which is the normal end state. A test
     that encodes a transient condition as an invariant fails the person doing
     the thing it was meant to protect.
     The real property: if it exists, git cannot see it. */
  const propsPath = path.join(ROOT, 'android/keystore.properties');
  if (fs.existsSync(propsPath)) {
    const tracked = (() => {
      try {
        execFileSync('git', ['ls-files', '--error-unmatch', 'android/keystore.properties'],
          { cwd: ROOT, stdio: 'pipe' });
        return true;
      } catch { return false; }
    })();
    check('the signing properties file is NOT tracked by git', tracked === false,
      'a signing password in a public repo lets anyone publish as Hestia');
    const staged = execFileSync('git', ['status', '--porcelain', '--', 'android/keystore.properties'],
      { cwd: ROOT, encoding: 'utf8' }).trim();
    check('...and is not staged or showing as untracked', staged === '', staged);
  } else {
    check('no signing properties file present (fresh clone or CI)', true);
  }

  /* Absent a key the release build stays UNSIGNED rather than failing, so a
     fresh clone, a contributor and CI can all still build. Verified by
     building both ways: app-release-unsigned.apk without, app-release.apk
     with. */
  check('a missing keystore leaves the config null instead of throwing',
    /signingConfig = signingConfigs\.findByName\("release"\)/.test(GRADLE) &&
    /if \(keystorePropsFile\.exists\(\)\)/.test(GRADLE));

  /* Play refuses an upload whose versionCode is not strictly greater than the
     last, and a hand-edited number beside one maintained by a different habit
     is the drift this file already documents. */
  check('versionCode is derived from versionName, not hand-maintained',
    /versionCode = versionName!!\.split\("\."\)/.test(GRADLE));
  const [maj, min, pat] = /versionName\s*=\s*"([^"]+)"/.exec(GRADLE)[1].split('.').map(Number);
  check('...and the derivation is monotonic for this version',
    maj * 10000 + min * 100 + pat === 20201,
    'built APK reported versionCode 20201 for 2.2.1');

  /* R8 would rename the @JavascriptInterface methods the page calls by name,
     and that fails SILENTLY -- the exact failure mode the bridge was designed
     to avoid. Off on purpose; this pins the decision so a later "tidy-up"
     has to argue with it. */
  check('minification stays off until the bridge has keep rules',
    /isMinifyEnabled = false/.test(GRADLE));
}

console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL ? 1 : 0);

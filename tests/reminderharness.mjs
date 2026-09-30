/* Reminders: what the list tells you, and editing.
 *
 * Extracts the REAL shipped functions from dashboard.html and runs them
 * against a pinned clock. Reminders are the one feature where being wrong is
 * silent by nature -- nothing happens, and nothing says nothing happened -- so
 * the display text and the edit path both need to be held still.
 *
 * Run: node tests/reminderharness.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
// Section 13 re-runs one calendar check in a child process with TZ set east of
// UTC; the zone has to be in place before node starts for Date to honour it.
import { execFileSync } from 'child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf8');

function fn(name) {
  const m = new RegExp('(async )?function ' + name + '\\s*\\(').exec(SRC);
  if (!m) throw new Error('missing ' + name + ' in dashboard.html');
  let d = 0;
  for (let j = SRC.indexOf('{', m.index); j < SRC.length; j++) {
    if (SRC[j] === '{') d++;
    else if (SRC[j] === '}' && --d === 0) return SRC.slice(m.index, j + 1);
  }
}

let PASS = 0, FAIL = 0;
const check = (l, c, x = '') => { c ? PASS++ : FAIL++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${x ? `  ${x}` : ''}`); };

/* A pinned clock. Patching Date.now() alone is not enough: these functions
   also call bare `new Date()` internally, which is how an earlier DST fix in
   this codebase nearly shipped passing a test it was not really exercising. */
function world(nowMs, reminders = [], hubFires = false) {
  /* The real Date is passed IN rather than read from the enclosing scope:
     `const Date = D` shadows the whole function body, so referring to `Date`
     on the line that defines D hits the temporal dead zone. */
  return new Function('__now', '__saves', '__RealDate', `
    class D extends __RealDate {
      constructor(...a) { if (a.length === 0) super(__now); else super(...a); }
      static now() { return __now; }
    }
    const Date = D;
    const CONFIG = { reminders: ${JSON.stringify(reminders)} };
    let _reminderTimeouts = {};
    function clearTimeout(){}
    // Records that a local timer WOULD have been armed, which is how the
    // capability handover is observed: with the hub firing, none should be.
    function setTimeout(fn, ms){ _scheduled.push(ms); return _scheduled.length; }
    function reminderUpdateBadge(){}
    function saveConfig(){ __saves.push(1); return Promise.resolve(); }
    // Mirrors reminderHubFires() in dashboard.html: true when a capable
    // companion app is present, in which case this device must not also fire.
    function reminderHubFires(){ return ${hubFires}; }
    const _scheduled = [];
    ${fn('_tzOffsetMinutesAt')}
    ${fn('computeNextFire')}
    ${fn('reminderNextFire')}
    ${fn('reminderSchedule')}
    const REMINDER_QUEUE_MAX = 60;
    const REMINDER_MISSED_AFTER_MS = 15 * 60 * 1000;
    const REMINDER_ONCE_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
    ${fn('reminderOccurrences')}
    ${fn('reminderRuntimeState')}
    ${fn('reminderPruneRuntime')}
    ${fn('reminderFormatNext')}
    ${fn('reminderUpdate')}
    return {
      fmt:    (r) => reminderFormatNext(r),
      next:   (r, from) => reminderNextFire(r, from),
      occ:    (r, n, from) => reminderOccurrences(r, n, from),
      update: (id, l, s) => reminderUpdate(id, l, s),
      get:    (id) => CONFIG.reminders.find(r => r.id === id),
      rstate: (e, n) => reminderRuntimeState(e, n),
      prune:  (rt, rems, n) => reminderPruneRuntime(rt, rems, n),
      arm:    (r) => { _scheduled.length = 0; reminderSchedule(r); return _scheduled.length; },
    };
  `)(nowMs, [], Date);
}

// Mirrors REMINDER_MISSED_AFTER_MS in dashboard.html (~7808). Asserted below
// against the real constant so this copy cannot drift unnoticed.
const REMINDER_MISSED_MS = 15 * 60 * 1000;

const TZ = 'America/New_York';
// 2026-06-15 09:46 local in New York (EDT, UTC-4) = 13:46 UTC. Deliberately
// mid-June so no DST transition is anywhere near these cases.
const NOW = Date.UTC(2026, 5, 15, 13, 46, 0);
const daily = (time) => ({ id: 'r1', label: 'Take medicine', enabled: true, timezone: TZ, schedule: { type: 'daily', time } });

console.log('=== 1. Today vs Tomorrow is a calendar question, not a stopwatch one ===');
{
  const w = world(NOW);

  /* The bug this pins down: the old code asked "is it less than 86400000ms
     away?" to decide "Today". A daily reminder for 09:44, read at 09:46, next
     fires TOMORROW at 09:44 -- 23h58m out, under 24h -- and was labelled
     "Today at 9:44 AM". It said today and meant tomorrow, on every daily
     reminder whose time had just gone by. */
  const justMissed = w.fmt(daily('09:44'));
  check('a daily whose time passed 2 minutes ago says Tomorrow',
    /^Tomorrow at/.test(justMissed), justMissed);

  const comingUp = w.fmt(daily('09:48'));
  check('a daily due in 2 minutes says Today', /^Today at/.test(comingUp), comingUp);

  /* Exactly the current instant counts as gone, not imminent: computeNextFire
     tests `> nowMs`, so a daily whose moment is right now has already fired and
     correctly points at tomorrow. Pinned because it is the exact-24h boundary
     the old elapsed-time label got wrong, and because `>=` here would re-fire
     a reminder that just went off. */
  const sameMinute = w.fmt(daily('09:46'));
  check('a daily due at this exact instant has passed, so it points at tomorrow',
    /^Tomorrow at 9:46/.test(sameMinute), sameMinute);

  const far = w.fmt({ id: 'r2', label: 'x', enabled: true, timezone: TZ,
                      schedule: { type: 'once', date: '2026-06-20', time: '09:00' } });
  check('something days out shows a real date, not Today/Tomorrow',
    !/^(Today|Tomorrow)/.test(far), far);
}

console.log('\n=== 2. A schedule that can never fire says so ===');
{
  const w = world(NOW);

  /* The form defaults to today's date and 08:00, which is a past-time pair for
     most of the day. It saved happily, scheduled nothing, and displayed the
     same "No upcoming fire" as a legitimately exhausted recurrence. */
  const past = { id: 'r3', label: 'x', enabled: true, timezone: TZ,
                 schedule: { type: 'once', date: '2026-06-15', time: '08:00' } };
  check('a one-time reminder set for the past has no fire time', w.next(past) === null);
  check('...and says the time has passed, not "no upcoming fire"',
    /passed/i.test(w.fmt(past)), w.fmt(past));

  const spent = { ...past, fired: true, firedAt: NOW - 1000 };
  check('one that genuinely fired says so instead', /already fired/i.test(w.fmt(spent)), w.fmt(spent));

  const off = { ...daily('09:00'), enabled: false };
  check('a disabled reminder reads Disabled', w.fmt(off) === 'Disabled', w.fmt(off));
}

console.log('\n=== 3. Editing, which was impossible until now ===');
{
  const start = [{ id: 'r1', label: 'Old label', enabled: true, timezone: TZ,
                   schedule: { type: 'daily', time: '08:00' } }];
  const w = world(NOW, start);

  w.update('r1', 'New label', { type: 'daily', time: '21:30' });
  const r = w.get('r1');
  check('the label is updated', r.label === 'New label', r.label);
  check('the schedule is updated', r.schedule.time === '21:30', JSON.stringify(r.schedule));
  check('the timezone is re-stamped to the editing device', !!r.timezone);

  const unknown = w.update('nope', 'x', { type: 'daily', time: '09:00' });
  check('editing a reminder that does not exist is a no-op, not a crash', unknown === null);
}

console.log('\n=== 4. Editing a spent one-time reminder re-arms it. A switched-off one stays off. ===');
{
  /* A 'once' reminder disables ITSELF after firing. Editing that to a new time
     plainly means "do it again", so the spent marker clears. But a reminder the
     USER switched off must survive an edit still switched off -- silently
     re-enabling something someone deliberately turned off is its own bug. */
  const start = [
    { id: 'sys', label: 'fired once', enabled: false, fired: true, firedAt: 1, timezone: TZ,
      schedule: { type: 'once', date: '2026-06-01', time: '08:00' } },
    { id: 'usr', label: 'user turned off', enabled: false, timezone: TZ,
      schedule: { type: 'daily', time: '08:00' } },
  ];
  const w = world(NOW, start);

  w.update('sys', 'fired once', { type: 'once', date: '2026-06-20', time: '08:00' });
  const sys = w.get('sys');
  check('a system-disabled (fired) reminder is re-armed by an edit', sys.enabled === true);
  check('...and its spent marker is cleared', !sys.fired && !sys.firedAt);

  w.update('usr', 'user turned off', { type: 'daily', time: '09:00' });
  const usr = w.get('usr');
  check('a user-disabled reminder stays disabled through an edit', usr.enabled === false,
    'editing must not undo a deliberate switch-off');
}

console.log('\n=== 5. A reminder keeps its wall-clock time across a DST change ===');
{
  /* This is the guarantee users actually care about: a 9am reminder stays at
     9am in March and in November. It has had NO regression test until now --
     the DST work was verified in Tier 2 against a synthetic suite that lived
     in a scratchpad and is long gone, which means the hard part of this file
     has been unprotected ever since. An early version of that fix was correct
     for negative-offset zones and silently wrong for positive-offset ones, so
     both hemispheres are tested deliberately, not for symmetry. */
  const w = world(Date.UTC(2026, 0, 1), []);
  const localTime = (ms, tz) =>
    new Date(ms).toLocaleTimeString('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });

  const spans = [
    ['America/New_York  spring forward', 'America/New_York', Date.UTC(2026, 2, 5), '09:00'],
    ['America/New_York  fall back',      'America/New_York', Date.UTC(2026, 9, 29), '09:00'],
    ['Australia/Sydney  DST ends',       'Australia/Sydney', Date.UTC(2026, 3, 2),  '09:00'],
    ['Australia/Sydney  DST starts',     'Australia/Sydney', Date.UTC(2026, 9, 1),  '09:00'],
    ['Asia/Tokyo        no DST at all',  'Asia/Tokyo',       Date.UTC(2026, 2, 5),  '09:00'],
  ];

  for (const [label, tz, fromMs, time] of spans) {
    const rem = { id: 'd', label: 'x', enabled: true, timezone: tz, schedule: { type: 'daily', time } };
    const days = w.occ(rem, 8, fromMs);
    const times = days.map(ms => localTime(ms, tz));
    const allSame = times.every(t => t === time);
    check(`${label}: 8 days all land at ${time} local`, allSame, times.join(' '));
    const ascending = days.every((ms, i) => i === 0 || ms > days[i - 1]);
    check(`${label}: instants stay strictly ascending`, ascending);
    // A transition really did happen in that window, otherwise the test above
    // proves nothing -- the UTC gap between consecutive fires shifts by an hour.
    const gaps = new Set(days.slice(1).map((ms, i) => ms - days[i]));
    const shifted = tz === 'Asia/Tokyo' ? gaps.size === 1 : gaps.size > 1;
    check(`${label}: ${tz === 'Asia/Tokyo' ? 'no shift, as expected' : 'a real transition was crossed'}`,
      shifted, [...gaps].map(g => g / 3600000 + 'h').join(','));
  }
}

console.log('\n=== 6. The precomputed queue the hub fires from ===');
{
  const w = world(Date.UTC(2026, 5, 15, 13, 46), []);
  const FROM = Date.UTC(2026, 5, 15, 13, 46);
  const daily = { id: 'd', label: 'x', enabled: true, timezone: TZ, schedule: { type: 'daily', time: '09:00' } };

  const ten = w.occ(daily, 10, FROM);
  check('asks for 10, gets 10', ten.length === 10, String(ten.length));
  check('every instant is in the future', ten.every(ms => ms > FROM));
  check('strictly ascending, so walking forward always terminates',
    ten.every((ms, i) => i === 0 || ms > ten[i - 1]));

  check('the queue is capped even when more are requested',
    w.occ(daily, 5000, FROM).length <= 60, 'unbounded growth rides into CONFIG and the hub state');
  check('asking for none gives none', w.occ(daily, 0, FROM).length === 0);

  const once = { id: 'o', label: 'x', enabled: true, timezone: TZ,
                 schedule: { type: 'once', date: '2026-06-20', time: '09:00' } };
  check('a one-time reminder yields exactly one instant and stops',
    w.occ(once, 10, FROM).length === 1);

  const ending = { id: 'e', label: 'x', enabled: true, timezone: TZ,
                   schedule: { type: 'daily', time: '09:00', endDate: '2026-06-18' } };
  const bounded = w.occ(ending, 10, FROM);
  check('an end date stops the queue rather than being ignored',
    bounded.length === 3, `${bounded.length} occurrences: ${bounded.map(m => new Date(m).toISOString().slice(0,10)).join(' ')}`);

  const off = { ...daily, enabled: false };
  check('a disabled reminder produces nothing to fire', w.occ(off, 10, FROM).length === 0);
}

console.log('\n=== 7. Runtime state is derived from time, not stored ===');
{
  /* A stub that drifts from the code it mirrors tests fiction. This harness
     hardcodes the threshold, so read the real one out of the source and fail
     loudly if someone changes it here without changing it there. */
  const declared = /REMINDER_MISSED_AFTER_MS\s*=\s*([0-9*\s]+);/.exec(SRC);
  const realMs = declared ? Function('return ' + declared[1])() : null;
  check('the harness threshold still matches dashboard.html', realMs === REMINDER_MISSED_MS,
    `source says ${realMs}, harness says ${REMINDER_MISSED_MS}`);

  const w = world(NOW, []);
  const MIN = 60000;
  const occ = NOW - 5 * MIN;   // fired five minutes ago

  check('nothing fired yet reads as no state', w.rstate(null, NOW) === null);
  check('a malformed entry does not throw', w.rstate({ ackedAt: 1 }, NOW) === null);

  check('fired, unacknowledged, still inside the window: unread',
    w.rstate({ occAt: occ }, NOW) === 'unread');

  check('acknowledged inside the window: read',
    w.rstate({ occAt: occ, ackedAt: occ + 2 * MIN }, NOW) === 'read');

  check('unacknowledged past 15 minutes: missed',
    w.rstate({ occAt: NOW - 16 * MIN }, NOW) === 'missed');

  /* The rule the user asked for in as many words: reading it later does not
     undo having missed the moment. Judged on how late the ACK was, not on
     whether one eventually arrived. */
  check('acknowledged AFTER the window stays missed, it does not flip to read',
    w.rstate({ occAt: NOW - 60 * MIN, ackedAt: NOW - 1 * MIN }, NOW) === 'missed',
    'missed stays missed');

  /* Lateness is measured from the SCHEDULED instant, so a hub that delivers
     two minutes late does not quietly move the deadline. */
  check('lateness is measured from the scheduled instant, not from delivery',
    w.rstate({ occAt: NOW - 16 * MIN, firedAt: NOW - 1 * MIN }, NOW) === 'missed');

  const edge = w.rstate({ occAt: NOW - REMINDER_MISSED_MS }, NOW);
  check('exactly at the threshold is not yet missed', edge === 'unread', String(edge));
}

console.log('\n=== 8. The daily refresh keeps the board clear and the map bounded ===');
{
  const w = world(NOW, []);
  const DAY = 86400000;
  const rems = [
    { id: 'daily', schedule: { type: 'daily', time: '09:00' } },
    { id: 'once',  schedule: { type: 'once', date: '2026-06-01', time: '09:00' } },
  ];
  const todayStart = (() => { const d = new Date(NOW); d.setHours(0,0,0,0); return d.getTime(); })();

  const kept = w.prune({ daily: { occAt: todayStart + 3600000, ackedAt: null } }, rems, NOW);
  check("today's recurring entry survives", !!kept.daily);

  const swept = w.prune({ daily: { occAt: todayStart - 2 * 3600000 } }, rems, NOW);
  check("yesterday's recurring entry is swept", !swept.daily,
    'this is what keeps "no history" true in storage, not just in the UI');

  const onceRecent = w.prune({ once: { occAt: NOW - 2 * DAY } }, rems, NOW);
  check('a one-time reminder missed 2 days ago is still there', !!onceRecent.once,
    'it does not come round again, so the morning after is when it matters most');

  const onceOld = w.prune({ once: { occAt: NOW - 8 * DAY } }, rems, NOW);
  check('a one-time reminder missed 8 days ago has aged out', !onceOld.once);

  const orphan = w.prune({ ghost: { occAt: NOW } }, rems, NOW);
  check('runtime for a deleted reminder is dropped', !orphan.ghost);

  const input = { daily: { occAt: todayStart - 5 * DAY } };
  w.prune(input, rems, NOW);
  check('pruning never mutates the map it was given', !!input.daily);
}

console.log('\n=== 9. One firer, chosen by capability ===');
{
  /* With a capable companion app the hub owns firing and this device must
     stay silent, or every open dashboard double-notifies. The alternative was
     coordinating two firers through a shared record, which neither Groovy
     state nor KV can do safely -- no compare-and-swap in either. Avoiding the
     race beats managing it. */
  const rem = { id: 'r', label: 'x', enabled: true, timezone: TZ,
                schedule: { type: 'daily', time: '23:59' } };

  const alone = world(NOW, [], false);
  check('with no companion app, this device arms its own timer',
    alone.arm(rem) === 1, 'otherwise Maker-API-only households get nothing at all');

  const withHub = world(NOW, [], true);
  check('with the hub firing, this device arms nothing',
    withHub.arm(rem) === 0, 'two firers means every open dashboard double-notifies');

  const off = { ...rem, enabled: false };
  check('a disabled reminder arms nothing either way', alone.arm(off) === 0);
}

console.log('\n=== 10. A hub-fired reminder actually says something ===');
{
  /* Review found the feature was silent on-device: the sync updated a badge
     and, only if Settings happened to be open on Reminders, re-rendered a
     list. A wall panel on the home screen -- the exact case this exists for --
     showed nothing. Push reaches closed devices; this reaches open ones. */
  const build = (reminders) => {
    const spoke = [], toasted = [];
    const api = new Function('__spoke', '__toast', '__now', `
      const CONFIG = { reminders: ${JSON.stringify(reminders)} };
      const REMINDER_MISSED_AFTER_MS = ${REMINDER_MISSED_MS};
      const Date = { now: () => __now };
      const document = { getElementById: () => null };
      function setTimeout(){}
      function athenaSpeak(m){ __spoke.push(m); }
      function reminderShowToast(m){ __toast.push(m); }
      const console = { warn(){} };
      ${fn('reminderAnnounceNewlyFired')}
      return (p, n) => reminderAnnounceNewlyFired(p, n);
    `)(spoke, toasted, NOW);
    return { api, spoke, toasted };
  };
  const rems = [{ id: 'r1', label: 'Walk the dog' }];

  const fresh = build(rems);
  fresh.api({}, { r1: { occAt: NOW - 60000 } });
  check('a newly fired reminder is spoken and shown',
    fresh.spoke.length === 1 && fresh.toasted[0] === 'Walk the dog',
    'without this the whole feature is a silent badge change');

  const repeat = build(rems);
  repeat.api({ r1: { occAt: NOW - 60000 } }, { r1: { occAt: NOW - 60000 } });
  check('the same occurrence is never announced twice',
    repeat.spoke.length === 0, 'the poll runs every few seconds');

  const acked = build(rems);
  acked.api({}, { r1: { occAt: NOW - 60000, ackedAt: NOW - 30000 } });
  check('one already acknowledged elsewhere stays quiet', acked.spoke.length === 0);

  const stale = build(rems);
  stale.api({}, { r1: { occAt: NOW - 60 * 60000 } });
  check('one too old to matter is not announced',
    stale.spoke.length === 0,
    'a hub back after three days must not shout everything it missed');

  const ghost = build(rems);
  ghost.api({}, { deleted: { occAt: NOW - 60000 } });
  check('runtime for a reminder that no longer exists is ignored', ghost.spoke.length === 0);

  const many = build([{ id: 'a', label: 'Dog' }, { id: 'b', label: 'Bins' }]);
  many.api({}, { a: { occAt: NOW - 60000 }, b: { occAt: NOW - 30000 } });
  check('two reminders firing together are announced separately',
    many.toasted.length === 2, many.toasted.join(' / '));
}

console.log('\n=== 11. One bad reminder must not take the others down ===');
{
  /* A malformed schedule drives Intl an invalid Date and throws RangeError.
     With one try/catch around the whole loop that aborted the pass, so every
     reminder AFTER the broken one silently stopped having its hub queue
     topped up -- for as long as the bad one stayed in the list. */
  const rems = [
    { id: 'a', label: 'good', enabled: true, timezone: TZ, schedule: { type: 'daily', time: '09:00' } },
    { id: 'bad', label: 'broken', enabled: true, timezone: TZ, schedule: { type: 'daily', time: 'nonsense' } },
    { id: 'c', label: 'also good', enabled: true, timezone: TZ, schedule: { type: 'daily', time: '10:00' } },
  ];
  const api = new Function('__RealDate', '__now', `
    const Date = class extends __RealDate {
      constructor(...a){ if (a.length === 0) super(__now); else super(...a); }
      static now(){ return __now; }
    };
    const CONFIG = { reminders: ${JSON.stringify(rems)} };
    const REMINDER_QUEUE_MAX = 60;
    const console = { warn(){}, log(){} };
    ${fn('_tzOffsetMinutesAt')}
    ${fn('computeNextFire')}
    ${fn('reminderNextFire')}
    ${fn('reminderOccurrences')}
    ${fn('reminderRefreshQueues')}
    reminderRefreshQueues();
    return CONFIG.reminders.map(r => (r.fireQueue || []).length);
  `)(Date, NOW);

  check('the reminder before the broken one still got a queue', api[0] > 0, String(api[0]));
  check('the broken one gets an empty queue rather than throwing', api[1] === 0, String(api[1]));
  check('the reminder AFTER the broken one still got a queue', api[2] > 0,
    `${api[2]} — this is the one that silently stopped working`);
}

console.log('\n=== 12. Learning that the hub fires must re-arm, both directions ===');
{
  /* reminderInit() runs during boot, seconds before the companion version
     check resolves, so reminderHubFires() is necessarily false then and every
     reminder gets a local timer. Nothing revisited them, so in a household
     where the hub DOES fire, anything due while that tab stayed open fired
     twice. The reverse matters as much: an app dropping below 2.1.0 must get
     its local timers back or that device goes silent for six hours. */
  const start = SRC.indexOf('const _hubFiredBefore = reminderHubFires();');
  if (start < 0) throw new Error('capability re-arm block not found in dashboard.html');
  const BLOCK = SRC.slice(start, SRC.indexOf('}', SRC.indexOf('reminderInit();', start)) + 1);

  const run = (before, after) => {
    const calls = [];
    new Function('__calls', '__before', '__after', `
      let _phase = 0;
      let _companionAppVersion = null, _companionAppVersionFor = null, _companionCheckTimer = null;
      let HUB_STORE = { appId: '219' };
      const data = { appVersion: '2.1.0' };
      const console = { log(){} };
      function clearTimeout(){} function setTimeout(){ return 1; }
      function checkCompanionVersion(){}   // the block reschedules it by name
      // False before the version lands, whatever the caller asked for after.
      function reminderHubFires(){ return _phase++ === 0 ? __before : __after; }
      function reminderInit(){ __calls.push('reArm'); }
      ${BLOCK}
    `)(calls, before, after);
    return calls;
  };

  check('boot armed locally, then the hub turns out to be capable: re-arm',
    run(false, true).includes('reArm'), 'otherwise every reminder fires twice');
  check('the hub stops being capable: re-arm so this device takes over',
    run(true, false).includes('reArm'), 'otherwise nothing fires at all');
  check('capability unchanged: leave the armed timers alone',
    run(false, false).length === 0, 're-arming on every version check would be churn');
}

console.log('\n=== 13. "Today" must mean the local day, not the UTC one ===');
{
  /* Reported from the field on v2.1.0, at 20:35 in New York. Every producer of
     a date string used `new Date().toISOString().slice(0, 10)`, which is the
     UTC date. West of UTC that is tomorrow for the whole evening, east of UTC
     it is yesterday for the whole early morning.

     Two visible failures, and they pointed in opposite directions, which is
     why it read as one confusing bug rather than two:
       - A reminder saved as "Once (today)" at 20:35 stored 2026-09-30 and the
         list then correctly displayed it as "Tomorrow at 8:35 PM". Display was
         right; the stored date was wrong.
       - A daily created at 20:42 disappeared from TODAY's calendar row,
         because createdAt was reduced to a UTC day and re-parsed as UTC
         midnight, which is 20:00 local the previous evening. */

  // 2026-09-29 20:35 in New York (EDT, UTC-4) = 2026-09-30 00:35 UTC.
  const EVENING = Date.UTC(2026, 8, 30, 0, 35, 0);
  const LOCAL_DAY = '2026-09-29';
  const UTC_DAY   = '2026-09-30';

  // Guard the fixture itself: if these ever stop differing the tests below
  // pass without proving anything.
  check('the fixture really straddles the date line',
    new Date(EVENING).toISOString().slice(0, 10) === UTC_DAY && UTC_DAY !== LOCAL_DAY);

  const dateWorld = new Function('__now', '__RealDate', `
    class D extends __RealDate {
      constructor(...a) { if (a.length === 0) super(__now); else super(...a); }
      static now() { return __now; }
    }
    const Date = D;
    ${fn('_localDateStr')}
    return { local: (d, tz) => _localDateStr(d, tz) };
  `)(EVENING, Date);

  check('_localDateStr gives the local day, not the UTC one',
    dateWorld.local(new Date(EVENING), TZ) === LOCAL_DAY,
    dateWorld.local(new Date(EVENING), TZ));

  check('...and is not merely returning a hardcoded offset: Tokyo is a day ahead',
    dateWorld.local(new Date(EVENING), 'Asia/Tokyo') === UTC_DAY,
    dateWorld.local(new Date(EVENING), 'Asia/Tokyo'));

  check('a nonsense zone falls back to a real local date, never to UTC-by-accident',
    /^\d{4}-\d{2}-\d{2}$/.test(dateWorld.local(new Date(EVENING), 'Not/AZone') || ''),
    String(dateWorld.local(new Date(EVENING), 'Not/AZone')));

  /* The producer the user actually used: the calendar's inline Add Reminder
     form, whose dropdown literally says "Once (today)". */
  const saveWorld = (timeStr, nowMs) => new Function('__now', '__RealDate', '__created', `
    class D extends __RealDate {
      constructor(...a) { if (a.length === 0) super(__now); else super(...a); }
      static now() { return __now; }
    }
    const Date = D;
    const fields = {
      'cal-add-label': { value: 'Bins out', focus(){} },
      'cal-add-time':  { value: ${JSON.stringify(timeStr)} },
      'cal-add-type':  { value: 'once' },
    };
    const document = { getElementById: (id) => fields[id] || null };
    let toast = null;
    function showDeviceToast(m){ toast = m; }
    function reminderCreate(label, schedule){ __created.push({ label, schedule }); }
    function reminderInit(){}
    function _calRefresh(){}
    function renderHome(){}
    ${fn('_tzOffsetMinutesAt')}
    ${fn('_localDateStr')}
    ${fn('computeNextFire')}
    ${fn('reminderNextFire')}
    ${fn('_calSaveReminder')}
    _calSaveReminder(false);
    return toast;
  `)(nowMs, Date, []);

  const created = [];
  const toast = new Function('__now', '__RealDate', '__created', `
    class D extends __RealDate {
      constructor(...a) { if (a.length === 0) super(__now); else super(...a); }
      static now() { return __now; }
    }
    const Date = D;
    const fields = {
      'cal-add-label': { value: 'Bins out', focus(){} },
      'cal-add-time':  { value: '20:55' },
      'cal-add-type':  { value: 'once' },
    };
    const document = { getElementById: (id) => fields[id] || null };
    let toast = null;
    function showDeviceToast(m){ toast = m; }
    function reminderCreate(label, schedule){ __created.push({ label, schedule }); }
    function reminderInit(){}
    function _calRefresh(){}
    function renderHome(){}
    ${fn('_tzOffsetMinutesAt')}
    ${fn('_localDateStr')}
    ${fn('computeNextFire')}
    ${fn('reminderNextFire')}
    ${fn('_calSaveReminder')}
    _calSaveReminder(false);
    return toast;
  `)(EVENING, Date, created);

  check('"Once (today)" at 20:35 stores TODAY, not the UTC tomorrow',
    created.length === 1 && created[0].schedule.date === LOCAL_DAY,
    created.length ? created[0].schedule.date : '(nothing saved)');
  check('...and saving it succeeded rather than being refused',
    toast === null, String(toast));

  /* The refusal that only the Settings form had. Until the date above was
     fixed this was unreachable from the calendar form -- "today" was always
     the UTC tomorrow, so the schedule was always in the future. */
  check('a "Once (today)" time that has already passed is refused here too',
    /already passed/i.test(String(saveWorld('20:00', EVENING))),
    String(saveWorld('20:00', EVENING)));

  /* The second failure: a reminder created this evening vanishing from today's
     own calendar row. */
  const calWorld = (reminders) => new Function('__now', '__RealDate', `
    class D extends __RealDate {
      constructor(...a) { if (a.length === 0) super(__now); else super(...a); }
      static now() { return __now; }
    }
    const Date = D;
    const CONFIG = { reminders: ${JSON.stringify(reminders)}, routines: [] };
    function _calSchedLabel(){ return ''; }
    ${fn('_localDateStr')}
    ${fn('_calEventsForDate')}
    return (y, m, d) => _calEventsForDate(new __RealDate(y, m, d));
  `)(EVENING, Date);

  // Created at 20:42 local on Sep 29 = 00:42 UTC Sep 30.
  const createdEvening = Date.UTC(2026, 8, 30, 0, 42, 0);
  const evts = calWorld([{
    id: 'r9', label: 'Bins', enabled: true, timezone: TZ,
    createdAt: createdEvening, schedule: { type: 'daily', time: '20:42' },
  }]);

  check('a daily created at 20:42 still appears on TODAY\'s calendar row',
    evts(2026, 8, 29).length === 1,
    `${evts(2026, 8, 29).length} event(s) on Sep 29`);
  check('...and on tomorrow\'s as well, since it repeats',
    evts(2026, 8, 30).length === 1);
  check('...but not on a day before it existed',
    evts(2026, 8, 28).length === 0,
    'a reminder cannot have occurrences predating its own creation');

  /* A "once" reminder must land on its own square. This is the latent half of
     the same bug: local midnight converted to a UTC date is a day early for
     every zone east of UTC, so this was wrong there even though New York
     happened to be right. */
  const once = calWorld([{
    id: 'r10', label: 'Dentist', enabled: true, timezone: TZ,
    createdAt: Date.UTC(2026, 8, 20, 12, 0, 0),
    schedule: { type: 'once', date: '2026-09-29', time: '14:00' },
  }]);
  check('a one-time reminder lands on its own calendar day',
    once(2026, 8, 29).length === 1 && once(2026, 8, 30).length === 0);

  /* Run the same check with the PROCESS in a positive-offset zone.
     _calEventsForDate is handed a local midnight, and east of UTC that instant
     belongs to the PREVIOUS UTC day -- so the old toISOString() key put every
     one-time reminder on the square before its own. New York cannot show this
     (its local midnight is 04:00 UTC, the same date), which is exactly why the
     check above passed against the broken line. TZ has to be set before node
     starts for Date to honour it, hence a child process. */
  const probe = `
    const fs = require('fs');
    const SRC = fs.readFileSync(${JSON.stringify(path.join(ROOT, 'dashboard.html'))}, 'utf8');
    ${fn.toString()}
    const CONFIG = { reminders: [{
      id: 'z', label: 'Dentist', enabled: true, timezone: 'Asia/Tokyo',
      createdAt: Date.UTC(2026, 8, 20, 3, 0, 0),
      schedule: { type: 'once', date: '2026-09-29', time: '14:00' },
    }], routines: [] };
    function _calSchedLabel(){ return ''; }
    eval(fn('_localDateStr'));
    eval(fn('_calEventsForDate'));
    const on29 = _calEventsForDate(new Date(2026, 8, 29)).length;
    const on28 = _calEventsForDate(new Date(2026, 8, 28)).length;
    console.log(JSON.stringify({ tz: Intl.DateTimeFormat().resolvedOptions().timeZone, on29, on28 }));
  `;
  let tokyo = null;
  try {
    tokyo = JSON.parse(execFileSync(process.execPath, ['-e', probe], {
      env: { ...process.env, TZ: 'Asia/Tokyo' }, encoding: 'utf8',
    }).trim());
  } catch (e) { tokyo = { error: String(e.message).slice(0, 120) }; }

  check('the child really ran east of UTC, or this proves nothing',
    tokyo && tokyo.tz === 'Asia/Tokyo', JSON.stringify(tokyo));
  check('east of UTC, a one-time reminder is still on its own day',
    tokyo && tokyo.on29 === 1 && tokyo.on28 === 0,
    JSON.stringify(tokyo) + ' — a UTC day key puts it on the square before');
}

console.log('\n=== 14. A reminder with no dates left is finished, not active ===');
{
  /* The user's two oldest reminders sat under "Active Reminders" reading "No
     upcoming fire" -- a state with no name and nothing to do about it. */
  const finishWorld = (rems) => new Function('__now', '__RealDate', `
    class D extends __RealDate {
      constructor(...a) { if (a.length === 0) super(__now); else super(...a); }
      static now() { return __now; }
    }
    const Date = D;
    const CONFIG = { reminders: ${JSON.stringify(rems)} };
    ${fn('_tzOffsetMinutesAt')}
    ${fn('computeNextFire')}
    ${fn('reminderNextFire')}
    ${fn('reminderIsFinished')}
    return CONFIG.reminders.map(r => reminderIsFinished(r));
  `)(NOW, Date);

  const base = { enabled: true, timezone: TZ };
  const flags = finishWorld([
    { ...base, id: 'a', label: 'ended', schedule: { type: 'daily', time: '09:00', endDate: '2026-06-01' } },
    { ...base, id: 'b', label: 'running', schedule: { type: 'daily', time: '09:00' } },
    { ...base, id: 'c', label: 'spent once', schedule: { type: 'once', date: '2026-06-01', time: '09:00' } },
    { ...base, id: 'd', label: 'future once', schedule: { type: 'once', date: '2026-06-20', time: '09:00' } },
    { ...base, enabled: false, id: 'e', label: 'paused', schedule: { type: 'daily', time: '09:00' } },
  ]);

  check('a repeat whose end date has passed is finished', flags[0] === true);
  check('a repeat still running is not', flags[1] === false);
  check('a one-time that has been and gone is finished', flags[2] === true);
  check('a one-time still ahead is not', flags[3] === false);
  /* The distinction that matters: OFF is a choice the user made and can undo
     from the active list. Sorting it into "Finished" would tell them their own
     paused reminder had expired. */
  check('a reminder the user switched off is paused, not finished',
    flags[4] === false);

  const list = fn('spReminderListHtml');
  check('the list actually splits them', /reminderIsFinished/.test(list) && /Finished/.test(list));
  check('...and nothing is deleted automatically',
    !/reminderDelete\(|splice\(/.test(list),
    'a finished reminder is still the user\'s to keep or remove');
}

console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL ? 1 : 0);

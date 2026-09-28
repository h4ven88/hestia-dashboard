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
function world(nowMs, reminders = []) {
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
    function clearTimeout(){} function setTimeout(){ return 1; }
    function reminderUpdateBadge(){}
    function saveConfig(){ __saves.push(1); return Promise.resolve(); }
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

console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL ? 1 : 0);

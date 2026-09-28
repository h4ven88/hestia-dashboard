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
    ${fn('reminderFormatNext')}
    ${fn('reminderUpdate')}
    return {
      fmt:    (r) => reminderFormatNext(r),
      next:   (r) => reminderNextFire(r),
      update: (id, l, s) => reminderUpdate(id, l, s),
      get:    (id) => CONFIG.reminders.find(r => r.id === id),
    };
  `)(nowMs, [], Date);
}

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

console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL ? 1 : 0);

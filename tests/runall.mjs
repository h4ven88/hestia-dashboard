// Runs every harness in one `node` call, so it matches the Bash(node *) allow
// rule instead of a shell loop that prompts for permission every time.
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Resolved from this file, not hardcoded: these suites previously lived in the
// OS temp scratchpad and were deleted by a temp cleanup, taking 23 tests with
// them. They belong next to the code they test.
const DIR = path.dirname(fileURLToPath(import.meta.url)) + path.sep;
const SUITES = ['ringharness', 'hubharness', 'relinkharness', 'healthharness', 'cloudharness',
                'garageharness', 'projection-equivalence', 'writeauth', 'cloudsecret',
                'reminderharness'];

let total = 0, failed = 0, missing = 0, unreadable = 0;

for (const s of SUITES) {
  const file = DIR + s + '.mjs';

  // A suite that is GONE is not a suite that passed. This exact case once
  // printed "all green" while 23 tests had been deleted by a temp cleanup, and
  // it did it again on 2026-09-25 with a suite removed by hand. Missing is a
  // hard failure, not a skip.
  if (!fs.existsSync(file)) { console.log(`${s.padEnd(22)} MISSING`); missing++; continue; }

  let out = '', threw = false;
  try {
    out = execFileSync(process.execPath, [file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
    threw = true;
  }

  const line = out.trim().split('\n').filter(l => /passed,.*failed/.test(l)).pop();

  // No summary line at all means the suite crashed before finishing, or its
  // output shape changed. Either way its result is unknown, and unknown must
  // never read as pass.
  if (!line) {
    console.log(`${s.padEnd(22)} NO SUMMARY (crashed or output changed)`);
    unreadable++;
    continue;
  }

  const passed = Number((line.match(/(\d+) passed/) || [0, 0])[1]);
  // Never trust the exit code alone: a suite that prints failures and still
  // exits 0 would otherwise be reported as green.
  const f = Number((line.match(/(\d+) failed/) || [0, 0])[1]);
  if (f > 0 || threw) failed++;
  total += passed;
  console.log(`${s.padEnd(22)} ${line}`);
}

const bad = failed + missing + unreadable;
const parts = [];
if (failed) parts.push(`${failed} failing`);
if (missing) parts.push(`${missing} MISSING`);
if (unreadable) parts.push(`${unreadable} unreadable`);

console.log(`\n${total} tests across ${SUITES.length} suites · ${bad ? parts.join(', ') : 'all green'}`);

// The runner previously always exited 0, so nothing calling it -- a hook, CI,
// a shell chain, or me reading a transcript -- could tell pass from fail.
process.exit(bad ? 1 : 0);

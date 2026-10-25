/* The site's nav is duplicated per page, and the copies drifted.
 *
 * hestari-landing.html and install.html each carry their own nav markup AND
 * their own mobile CSS. Nothing kept them in step, so by 2026-10-26 they had:
 *   - different item counts (8 vs 7; install was missing About)
 *   - different order (Get the App third on one, sixth on the other)
 *   - different wording for the same link ("Get the app" / "Get the App")
 *   - install linking to /#modules, which is the DASHBOARD, not the landing
 *     page: those sections live on /hestari-landing
 *   - anchors left at display:inline on both, so a row's tap target was only
 *     as wide as its text
 *   - the landing panel pinned at top:52px under a 56px bar
 *
 * There is no build step for these two files, so the only thing that can hold
 * them together is a test that fails when they diverge.
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log('PASS  ' + label + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('FAIL  ' + label + (detail ? '  ' + detail : '')); }
};

const PAGES = ['hestari-landing.html', 'install.html'];
const src = Object.fromEntries(PAGES.map(p => [p, read(p)]));

/* The visible labels, in order. Compared as a sequence rather than a set: the
   order is what a user actually experiences moving between pages. */
const labels = (s) => {
  const ul = /<ul class="nav-links">([\s\S]*?)<\/ul>/.exec(s);
  if (!ul) return null;
  return [...ul[1].matchAll(/<a\s[^>]*>([^<]+)<\/a>/g)].map(m => m[1].trim());
};

console.log('=== 1. the two navs are the same menu ===');
const a = labels(src['hestari-landing.html']);
const b = labels(src['install.html']);
check('both pages expose a nav-links list', !!a && !!b);
check('same number of items', a.length === b.length, a.length + ' vs ' + b.length);
check('same labels in the same order', JSON.stringify(a) === JSON.stringify(b),
  '\n        landing: ' + a.join(' | ') + '\n        install: ' + b.join(' | '));

console.log('\n=== 2. every row is block, so the whole row is tappable ===');
/* An anchor left inline ignores vertical padding for layout and is only as
   wide as its text, which makes the row look right and tap wrong. */
for (const p of PAGES) {
  check(p + ': mobile .nav-links a sets display:block',
    /\.nav-links a\{display:block/.test(src[p].replace(/\s+/g, ' ')));
}

console.log('\n=== 3. the panel hangs off the bottom of the bar ===');
for (const p of PAGES) {
  const h = /\.nav-inner\{[^}]*height:(\d+)px/.exec(src[p])?.[1];
  /* (?:^|[;{\s]) so this cannot match the "top:1px" inside border-top:1px,
     which it did on the first run and reported as a real failure. */
  const top = /\.nav-links\{[^}]*?(?:^|[;{\s])top:(\d+)px/.exec(src[p].replace(/\/\*[\s\S]*?\*\//g, ''))?.[1];
  check(p + ': panel top matches nav height', h && top && h === top, 'nav ' + h + 'px, panel top ' + top + 'px');
}

console.log('\n=== 4. install does not link site sections at the dashboard ===');
/* "/" serves the DASHBOARD. The landing sections live at /hestari-landing, so
   href="/#roadmap" silently lands on the dashboard with a dead hash. */
check('no href="/#..." anywhere in install.html',
  !/href="\/#/.test(src['install.html']),
  (src['install.html'].match(/href="\/#[^"]*"/g) || []).join(' '));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

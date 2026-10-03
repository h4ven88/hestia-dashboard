#!/usr/bin/env node
/**
 * Hestia Dashboard build script
 * Minifies CSS (inline), JS (inline), strips HTML comments/whitespace.
 * 
 * Usage: node build.js
 * 
 * Requires: npm install clean-css terser
 *   (run once: npm install --save-dev clean-css terser)
 */

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const SRC = 'dashboard.html';
const DIST = 'index.html';
const BUILD_INFO = 'build-info.json';

/* FOURTH OUTPUT: the Android app's bundled assets.
 *
 * One source, one build, now four consumers: the web host, the hub, the
 * sandbox, and the app. The app's copy is the same minified build with three
 * absolute URLs rewritten to local paths, plus the files those paths point at.
 *
 * WHY THE APP AND NOT THE WEB BUILD. The dashboard reaches the network for
 * three things before it can hear a wake word: ONNX Runtime and its WASM from
 * cdnjs, and the models from hestari.com. That makes a wall panel with no
 * internet a dashboard with no wake word, and it makes every hub-served
 * household depend on hestari.com being up for a feature their own hub serves.
 *
 * It is also a hard prerequisite for the native bridge. Android's own
 * documentation conditions addJavascriptInterface on it: "don't use
 * addJavascriptInterface() unless you wrote all of the HTML and JavaScript
 * that appears in your WebView." A page pulling a runtime off a CDN does not
 * meet that bar.
 *
 * The web build is deliberately NOT changed. index.html is delivered to hubs
 * as a SINGLE file by the Groovy app's downloadDashboard(). Bundling there
 * would turn one fetch into a dozen, with no transaction, and a partial
 * failure leaves a hub serving a dashboard whose runtime is missing. That is
 * the update-delivery class that caused the v1.6.5 outage.
 *
 * ORT is not committed. It comes from node_modules at build time and lands in
 * a gitignored folder, so the repository stays at its current size and the
 * build stays reproducible from package-lock.
 */
function buildAppAssets(html) {
  const ASSETS = path.join('android', 'app', 'src', 'main', 'assets');
  const ORT_DIST = path.join('node_modules', 'onnxruntime-web', 'dist');
  const CDN = 'https://cdnjs.cloudflare.com/ajax/libs/onnxruntime-web/1.18.0/';
  const MODELS = 'https://hestari.com/models/';

  if (!fs.existsSync(ORT_DIST)) {
    console.log('  app assets: skipped (onnxruntime-web not installed; run npm install)');
    return null;
  }

  /* Every rewrite is counted and asserted. A rewrite that silently matches
     nothing -- because terser changed its quoting, or the CDN version moved --
     would produce an app that still reaches for the network and fails offline,
     with nothing in the build output saying so. Refuse instead. */
  const rewrite = (s, find, repl, what) => {
    const n = s.split(find).length - 1;
    if (n === 0) throw new Error(`app assets: found no "${what}" to rewrite. ` +
      `The build output changed shape; fix the rewrite rather than shipping an app that needs the network.`);
    return { out: s.split(find).join(repl), n };
  };

  let appHtml = html;
  let r = rewrite(appHtml, CDN, 'ort/', 'ONNX Runtime CDN URL');
  appHtml = r.out;
  const ortRefs = r.n;

  r = rewrite(appHtml, MODELS, 'models/', 'wake word model URL');
  appHtml = r.out;
  const modelRefs = r.n;

  /* Threads need SharedArrayBuffer, which needs cross-origin isolation the
     WebView does not have by default. Pinning to one thread makes the variant
     ORT selects deterministic instead of leaving it to feature detection, and
     wake word inference is far too small for threading to matter. */
  r = rewrite(appHtml, 'ort.env.wasm.wasmPaths="ort/"',
              'ort.env.wasm.wasmPaths="ort/",ort.env.wasm.numThreads=1',
              'wasmPaths assignment');
  appHtml = r.out;

  /* Fonts. A stylesheet cannot reach the JS bridge, so unlike the runtime
     these are not a security prerequisite -- but an app that needs the network
     to render its own typeface is not an offline app. Swapped for local
     @font-face over the exact weights the dashboard asks Google for. */
  const FONTS = [
    { family: 'Outfit', pkg: '@fontsource/outfit', slug: 'outfit', weights: [100, 200, 300] },
    { family: 'Inter',  pkg: '@fontsource/inter',  slug: 'inter',  weights: [200, 300, 400, 500, 600, 700] },
  ];
  let fontCss = '', fontBytes = 0, fontCount = 0;
  const fontsAvailable = FONTS.every(f => fs.existsSync(path.join('node_modules', f.pkg, 'files')));
  if (fontsAvailable) {
    fs.mkdirSync(path.join(ASSETS, 'fonts'), { recursive: true });
    for (const f of FONTS) {
      for (const w of f.weights) {
        const name = `${f.slug}-latin-${w}-normal.woff2`;
        const from = path.join('node_modules', f.pkg, 'files', name);
        if (!fs.existsSync(from)) throw new Error(`app assets: missing font ${name}`);
        fs.copyFileSync(from, path.join(ASSETS, 'fonts', name));
        fontBytes += fs.statSync(from).size;
        fontCount++;
        fontCss += `@font-face{font-family:'${f.family}';font-style:normal;font-weight:${w};` +
                   `font-display:swap;src:url('fonts/${name}') format('woff2')}`;
      }
    }
    /* Drop every Google Fonts <link> (stylesheet AND the preconnects) and put
       the local faces in their place. Matched on the tag rather than the URL
       so a preconnect without a stylesheet cannot be left behind. */
    const before = appHtml;
    appHtml = appHtml.replace(/<link\b[^>]*(?:fonts\.googleapis\.com|fonts\.gstatic\.com)[^>]*>/g, '');
    if (appHtml === before) throw new Error('app assets: found no Google Fonts link tags to replace');
    appHtml = appHtml.replace('</head>', `<style>${fontCss}</style></head>`);
  } else {
    console.log('  app assets: fonts skipped (@fontsource not installed)');
  }

  for (const host of ['cdnjs.cloudflare.com', 'hestari.com/models/',
                      ...(fontsAvailable ? ['fonts.googleapis.com', 'fonts.gstatic.com'] : [])]) {
    if (appHtml.includes(host)) {
      throw new Error(`app assets: a reference to ${host} survived the rewrite`);
    }
  }

  fs.mkdirSync(path.join(ASSETS, 'ort'), { recursive: true });
  fs.mkdirSync(path.join(ASSETS, 'models'), { recursive: true });
  fs.writeFileSync(path.join(ASSETS, 'index.html'), appHtml, 'utf-8');

  /* Only the variants a single-threaded WebView can select. The threaded and
     jsep (WebGPU/WebNN) builds are another 60 MB and cannot be reached from
     this configuration. */
  const ORT_FILES = ['ort.min.js', 'ort-wasm-simd.wasm', 'ort-wasm.wasm'];
  let ortBytes = 0;
  for (const f of ORT_FILES) {
    const from = path.join(ORT_DIST, f);
    if (!fs.existsSync(from)) throw new Error(`app assets: onnxruntime-web is missing ${f}`);
    fs.copyFileSync(from, path.join(ASSETS, 'ort', f));
    ortBytes += fs.statSync(from).size;
  }

  // The eleven shipped models. The experimental and rejected ones are ignored
  // in git for a reason and have no business in an APK.
  const SKIP = new Set(['athena_backup.onnx', 'artemis_online_test.onnx']);
  let modelBytes = 0, modelCount = 0;
  for (const f of fs.readdirSync('models')) {
    if (!f.endsWith('.onnx') || SKIP.has(f)) continue;
    fs.copyFileSync(path.join('models', f), path.join(ASSETS, 'models', f));
    modelBytes += fs.statSync(path.join('models', f)).size;
    modelCount++;
  }

  /* The bridge shim travels as an asset rather than a <script> tag in the
     page, because native has to evaluate it BEFORE the dashboard's own scripts
     run. It is source, not generated, so it lives in android/bridge/ and is
     copied here. dashboard.html never references it. */
  const SHIM = path.join('android', 'bridge', 'hestia-bridge.js');
  if (!fs.existsSync(SHIM)) throw new Error('app assets: the bridge shim is missing from ' + SHIM);
  fs.copyFileSync(SHIM, path.join(ASSETS, 'hestia-bridge.js'));

  const mb = (b) => (b / 1048576).toFixed(1) + ' MB';
  console.log(`  app assets: ${ortRefs} ORT + ${modelRefs} model refs localised, ` +
              `${modelCount} models (${mb(modelBytes)}), runtime ${mb(ortBytes)}, ` +
              `${fontCount} fonts (${mb(fontBytes)}) — total ${mb(ortBytes + modelBytes + fontBytes)}`);
  return { ortBytes, modelBytes, modelCount, fontBytes, fontCount };
}

async function build() {
  // Lazy-load dependencies with helpful error if missing
  let CleanCSS, terser;
  try {
    CleanCSS = require('clean-css');
  } catch {
    console.error('Missing dependency: run "npm install --save-dev clean-css"');
    process.exit(1);
  }
  try {
    terser = require('terser');
  } catch {
    console.error('Missing dependency: run "npm install --save-dev terser"');
    process.exit(1);
  }

  let src = fs.readFileSync(SRC, 'utf-8');

  // Auto-stamp build date in source before building
  const today = new Date().toISOString().slice(0, 10);
  const datePatched = src.replace(
    /const HESTIA_BUILD_DATE\s*=\s*'[^']*'/,
    `const HESTIA_BUILD_DATE = '${today}'`
  );
  if (datePatched !== src) {
    fs.writeFileSync(SRC, datePatched, 'utf-8');
    src = datePatched;
    console.log(`  Build date stamped: ${today}`);
  }

  let html = src;
  const srcSize = Buffer.byteLength(html, 'utf-8');

  // Minify inline <style> blocks
  const cleanCSS = new CleanCSS({ level: 2 });
  html = html.replace(/<style>([\s\S]*?)<\/style>/gi, (match, css) => {
    try {
      const result = cleanCSS.minify(css);
      if (result.errors && result.errors.length) {
        console.warn('  CSS minify warning:', result.errors);
        return match;
      }
      return '<style>' + result.styles + '</style>';
    } catch (e) {
      console.warn('  CSS minify warning:', e.message);
      return match;
    }
  });

  // Minify inline <script> blocks
  const scriptRegex = /<script>([\s\S]*?)<\/script>/gi;
  const scriptMatches = [...html.matchAll(scriptRegex)];
  
  for (const m of scriptMatches) {
    try {
      const result = await terser.minify(m[1], {
        compress: {
          dead_code: true,
          drop_console: false,  // keep console.log/warn
          passes: 2
        },
        mangle: false,  // keep function/variable names readable for debugging
        format: {
          comments: false
        }
      });
      if (result.code) {
        html = html.replace(m[0], '<script>' + result.code + '</script>');
      }
    } catch (e) {
      console.warn('  JS minify warning:', e.message);
    }
  }

  // Strip HTML comments (but not conditional comments like <!--[if ...)
  html = html.replace(/<!--(?!\[)[\s\S]*?-->/g, '');

  // Collapse whitespace between tags
  html = html.replace(/>\s+</g, '><');

  // Collapse runs of blank lines
  html = html.replace(/\n\s*\n/g, '\n');

  fs.writeFileSync(DIST, html, 'utf-8');
  fs.copyFileSync(DIST, 'app.html');
  // Same build, different filename. The runtime detects "sandbox" in the path
  // and isolates config, cloud sync, push and device commands. Emitting it
  // here rather than maintaining a second source file is what stops the
  // sandbox drifting from the dashboard it is supposed to be testing.
  fs.copyFileSync(DIST, 'sandbox.html');

  const appAssets = buildAppAssets(html);

  const distSize = Buffer.byteLength(html, 'utf-8');
  const ratio = ((1 - distSize / srcSize) * 100).toFixed(1);

  // Extract version from source
  const verMatch = src.match(/const HESTIA_VERSION\s*=\s*'([^']*)'/);
  const version = verMatch ? verMatch[1] : 'unknown';

  /* The version string lives in four places that nothing used to compare.
     They drift, and the drift is expensive: packageManifest.json was missed
     when v1.6.5 shipped, so HPM reported "up to date" to every user for three
     days and no hub-served install received anything. The Groovy's own header
     comment then sat at v1.6.7 through two further releases -- the first thing
     a user sees when pasting the app, and the release instructions tell them
     to watch it change.

     A human checklist did not catch either. So the build refuses instead. */
  const mismatches = [];
  const checkVersion = (label, file, re) => {
    let text;
    try { text = fs.readFileSync(file, 'utf-8'); } catch { return; }  // optional file
    const m = text.match(re);
    if (!m) { mismatches.push(`${label}: no version found in ${file}`); return; }
    if (m[1] !== version) mismatches.push(`${label}: ${m[1]} (expected ${version})`);
  };

  checkVersion('packageManifest.json', 'packageManifest.json', /"version"\s*:\s*"([^"]+)"/);
  checkVersion('Groovy APP_VERSION', 'HestiaDashboard.groovy', /APP_VERSION\s*=\s*"([^"]+)"/);
  checkVersion('Groovy header comment', 'HestiaDashboard.groovy', /Hestia™ Home Dashboard v([0-9][^\s*]*)/);

  if (mismatches.length) {
    throw new Error(
      `version mismatch against dashboard.html's HESTIA_VERSION (${version}):\n` +
      mismatches.map(m => `    ${m}`).join('\n') +
      `\n  Fix these, or the release ships claiming a version it is not.`
    );
  }

  // Compute SHA-256 of dist output
  const sha256 = crypto.createHash('sha256')
    .update(fs.readFileSync(DIST))
    .digest('hex')
    .toUpperCase();

  // Write build-info.json
  const buildInfo = {
    name: 'Hestia Dashboard',
    version,
    buildDate: today,
    sourceSize: srcSize,
    distSize,
    reduction: `${ratio}%`,
    sha256,
    licence: 'CC BY-NC 4.0',
    copyright: `© ${new Date().getFullYear()} Haven`
  };
  fs.writeFileSync(BUILD_INFO, JSON.stringify(buildInfo, null, 2) + '\n', 'utf-8');

  console.log(`  ${SRC}: ${srcSize.toLocaleString()} bytes`);
  console.log(`  ${DIST}: ${distSize.toLocaleString()} bytes (${ratio}% reduction)`);
  console.log(`  ${BUILD_INFO}: v${version}, ${today}, SHA-256: ${sha256.slice(0, 12)}...`);
}

build().catch(e => {
  console.error('Build failed:', e);
  process.exit(1);
});

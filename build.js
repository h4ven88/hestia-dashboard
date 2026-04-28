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
const path = require('path');

const SRC = 'dashboard.html';
const DIST = 'index.html';

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

  let html = fs.readFileSync(SRC, 'utf-8');
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

  const distSize = Buffer.byteLength(html, 'utf-8');
  const ratio = ((1 - distSize / srcSize) * 100).toFixed(1);
  console.log(`  ${SRC}: ${srcSize.toLocaleString()} bytes`);
  console.log(`  ${DIST}: ${distSize.toLocaleString()} bytes (${ratio}% reduction)`);
}

build().catch(e => {
  console.error('Build failed:', e);
  process.exit(1);
});

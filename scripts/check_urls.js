#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const https = require('https');

const WORDS = ['apollo', 'achilles', 'andromeda', 'hermes', 'odin', 'osiris', 'anubis'];
const DELAY_MS = 300;

function fetchStatus(url) {
  return new Promise((resolve) => {
    const oembed = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    https.get(oembed, { timeout: 10000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200 ? 'OK' : 'DEAD');
    }).on('error', () => resolve('ERROR')).on('timeout', function() { this.destroy(); resolve('TIMEOUT'); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function checkFile(word) {
  const filePath = path.join(__dirname, `urls_${word}.txt`);
  if (!fs.existsSync(filePath)) { console.log(`  SKIP: urls_${word}.txt not found`); return { word, total: 0, ok: 0, dead: [] }; }
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
  const urls = lines.filter(l => l.trim().startsWith('https://'));
  const dead = [];
  let ok = 0;
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i].trim();
    const status = await fetchStatus(url);
    if (status === 'OK') { ok++; }
    else { dead.push({ url, status }); }
    if (i < urls.length - 1) await sleep(DELAY_MS);
  }
  return { word, total: urls.length, ok, dead };
}

async function main() {
  console.log('YouTube URL Checker — 7 wake words\n');
  const results = [];
  for (const word of WORDS) {
    process.stdout.write(`Checking ${word}...`);
    const r = await checkFile(word);
    console.log(` ${r.ok}/${r.total} OK` + (r.dead.length ? ` — ${r.dead.length} DEAD` : ''));
    results.push(r);
  }

  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log(`${'Word'.padEnd(14)} ${'Total'.padStart(5)} ${'OK'.padStart(5)} ${'Dead'.padStart(5)}`);
  console.log('-'.repeat(34));
  let totalAll = 0, okAll = 0, deadAll = 0;
  for (const r of results) {
    console.log(`${r.word.padEnd(14)} ${String(r.total).padStart(5)} ${String(r.ok).padStart(5)} ${String(r.dead.length).padStart(5)}`);
    totalAll += r.total; okAll += r.ok; deadAll += r.dead.length;
  }
  console.log('-'.repeat(34));
  console.log(`${'TOTAL'.padEnd(14)} ${String(totalAll).padStart(5)} ${String(okAll).padStart(5)} ${String(deadAll).padStart(5)}`);

  const allDead = results.flatMap(r => r.dead.map(d => ({ word: r.word, ...d })));
  if (allDead.length > 0) {
    console.log('\n' + '='.repeat(60));
    console.log('DEAD URLs');
    console.log('='.repeat(60));
    for (const d of allDead) {
      console.log(`  [${d.word}] ${d.status}: ${d.url}`);
    }
  } else {
    console.log('\nAll URLs are live!');
  }
}

main();

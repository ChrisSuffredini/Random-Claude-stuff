#!/usr/bin/env node
// One command, any OS (Windows / macOS / Linux), no git needed:
//
//   node scraper/run.js
//
// 1. installs dependencies the first time
// 2. opens Chrome/Edge/Chromium on a throwaway profile at hltv.org
// 3. waits while you clear the Cloudflare check, then press Enter
// 4. runs a quick probe, then (after Enter) the full scrape
// 5. packs everything into ONE file, hltv-data.tar.gz, to upload on GitHub
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const readline = require('readline');

const ROOT = path.join(__dirname, '..');
// e.g. node scraper/run.js --only maps,players  (second laptop)
const onlyIdx = process.argv.indexOf('--only');
const ONLY = onlyIdx > 0 ? process.argv[onlyIdx + 1] : null;
const PASS = ONLY ? ['--only', ONLY] : [];
const OUT_NAME = ONLY ? `hltv-data-${ONLY.replace(/[^a-z,]/gi, '').split(',').join('-')}` : 'hltv-data';
const PORT = Number(process.env.PORT || 9222);
const CDP = `http://127.0.0.1:${PORT}`;
const UPLOAD_URL =
  'https://github.com/ChrisSuffredini/Random-Claude-stuff/tree/claude/gifted-brahmagupta-tcmged/cs2-major-predictor';

// One shared reader: separate interfaces can swallow each other's input.
const lines = [];
const waiters = [];
let stdinClosed = false;
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (l) => (waiters.length ? waiters.shift()(l) : lines.push(l)));
rl.on('close', () => { stdinClosed = true; while (waiters.length) waiters.shift()(''); });
function ask(q) {
  process.stdout.write(q);
  if (lines.length) return Promise.resolve(lines.shift());
  if (stdinClosed) return Promise.resolve('');
  return new Promise((r) => waiters.push(r));
}

function ensureDeps() {
  if (fs.existsSync(path.join(ROOT, 'node_modules', 'puppeteer-core')) &&
      fs.existsSync(path.join(ROOT, 'node_modules', 'cheerio'))) return;
  console.log('Installing dependencies (first run only)...');
  const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund'], {
    cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32',
  });
  if (r.status !== 0) {
    console.error('\n"npm install" failed. Is Node.js installed? Get it from https://nodejs.org (LTS).');
    process.exit(1);
  }
}

function portUp() {
  return new Promise((res) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/json/version', timeout: 1500 }, (r) => {
      r.resume();
      res(r.statusCode === 200);
    });
    req.on('error', () => res(false));
    req.on('timeout', () => { req.destroy(); res(false); });
  });
}

function onPath(cmd) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
}

function findBrowser() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const local = process.env.LOCALAPPDATA || '';
  const pf = process.env.PROGRAMFILES || 'C:\\Program Files';
  const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
  const files = {
    win32: [
      `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pf86}\\Google\\Chrome\\Application\\chrome.exe`,
      `${local}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pf}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
      `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
    ],
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ],
  }[process.platform] || [];
  for (const f of files) if (f && fs.existsSync(f)) return f;
  for (const c of ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser', 'brave-browser', 'brave', 'microsoft-edge']) {
    const p = onPath(c);
    if (p) return p;
  }
  return null;
}

function runScrape(extra) {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'scrape.js'), ...extra], {
    cwd: ROOT, stdio: 'inherit', env: { ...process.env, HLTV_CDP_URL: CDP, HLTV_NO_GIT_HINT: '1' },
  });
  return r.status === 0;
}

function pack() {
  const out = path.join(ROOT, `${OUT_NAME}.tar.gz`);
  const r = spawnSync('tar', ['-czf', out, '-C', path.join(ROOT, 'data'), 'raw'], { stdio: 'inherit' });
  if (r.status === 0 && fs.existsSync(out)) return out;
  // No tar available: bundle every file into one gzipped JSON instead.
  const zlib = require('zlib');
  const bundle = {};
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else bundle[path.relative(path.join(ROOT, 'data'), p).split(path.sep).join('/')] = fs.readFileSync(p).toString('base64');
    }
  };
  walk(path.join(ROOT, 'data', 'raw'));
  const alt = path.join(ROOT, `${OUT_NAME}.json.gz`);
  fs.writeFileSync(alt, zlib.gzipSync(JSON.stringify(bundle)));
  return alt;
}

async function main() {
  console.log('== CS2 Major predictor: HLTV data pull\n');
  ensureDeps();

  if (!(await portUp())) {
    const exe = findBrowser();
    if (!exe) {
      console.error('Could not find Chrome, Edge, Brave or Chromium. Install Google Chrome, or set CHROME_PATH to its .exe/app binary.');
      process.exit(1);
    }
    const profile = path.join(os.tmpdir(), 'hltv-profile');
    console.log(`Opening ${path.basename(exe)} (separate throwaway profile, your normal browser is untouched)...`);
    const child = spawn(exe, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', 'https://www.hltv.org'], { detached: true, stdio: 'ignore' });
    child.unref();
    for (let i = 0; i < 40 && !(await portUp()); i++) await new Promise((r) => setTimeout(r, 500));
    if (!(await portUp())) {
      console.error('The browser opened but is not accepting the connection. Close ALL windows of that browser and run this again.');
      process.exit(1);
    }
  } else {
    console.log(`Using the browser already listening on port ${PORT}.`);
  }

  console.log('\nA browser window is open on hltv.org.');
  console.log('If it shows "Verify you are human", click the checkbox. Wait until the normal HLTV front page shows.');
  await ask('Then come back here and press Enter... ');

  console.log('\n== Step 1/2: quick test (about 30 pages)');
  if (!runScrape(['--probe', ...PASS])) {
    console.error('\nThe quick test failed. Copy the text above and send it to Claude.');
    process.exit(1);
  }
  await ask('\nIf the numbers above look non-zero, press Enter for the full download (20-30 min; leave the browser open)... ');

  console.log('\n== Step 2/2: full download');
  if (!runScrape(PASS)) {
    console.error('\nThe download stopped early. Just run this same command again: it resumes where it left off.');
    process.exit(1);
  }

  const file = pack();
  const mb = (fs.statSync(file).size / 1e6).toFixed(1);
  console.log(`\n== All done. Your data is in ONE file (${mb} MB):\n\n   ${file}\n`);
  console.log('Upload it so Claude can use it:');
  console.log(`  1. Open ${UPLOAD_URL}`);
  console.log('  2. Click "Add file" (top right) -> "Upload files"');
  console.log(`  3. Drag ${path.basename(file)} into the page`);
  console.log('  4. Click the green "Commit changes" button');
  console.log('  5. Tell Claude it is uploaded. You can close the browser window now.');
  rl.close();
}

main().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});

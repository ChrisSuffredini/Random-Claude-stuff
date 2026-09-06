// Was apEX/karrigan's low career time-alive a fixed personal trait, or
// mostly a symptom of when they played? CS:GO's meta is documented to
// have shifted around 2018 (Astralis popularized slow, utility-heavy,
// structured play over the earlier era's faster, aim-duel-heavy style).
// This fetches each test player's stats windowed by calendar year
// (HLTV's stats pages accept startDate/endDate) to see whether their
// time-alive was already low pre-2018 or specifically cratered in the
// faster early era.
//
//   HLTV_CDP_URL=http://127.0.0.1:9222 node eras.js
const fs = require('fs');
const path = require('path');
const { generateRandomSuffix } = require('hltv/lib/utils');
const { parsePlayerPage } = require('./parse');
const { loadPageWithBrowser, closeBrowser } = require('./browser');

const CACHE_DIR = path.join(__dirname, 'cache');
const OUT = path.join(__dirname, 'eras.json');
const DELAY_MS = 800;
const MIN_REAL_CONTENT = 50000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Test subjects (the low-outlier entry/IGL players) plus controls spanning
// similar tenure but different reputations: NiKo/ZywOo (star riflers, not
// sacrificial), FalleN (mixed role, moderate residual in the earlier
// era-vs-role analysis).
const PLAYERS = [
  { id: 429, name: 'karrigan' },
  { id: 7322, name: 'apEX' },
  { id: 3741, name: 'NiKo' },
  { id: 11893, name: 'ZywOo' },
  { id: 2023, name: 'FalleN' },
];

// Windows chosen around the documented ~2018 shift to structured play.
const WINDOWS = [
  { label: '2013-2015', startDate: '2013-01-01', endDate: '2015-12-31' },
  { label: '2016-2017', startDate: '2016-01-01', endDate: '2017-12-31' },
  { label: '2018-2020', startDate: '2018-01-01', endDate: '2020-12-31' },
  { label: '2021-2022', startDate: '2021-01-01', endDate: '2022-12-31' },
];

function cacheFile(id, startDate, endDate) {
  return path.join(CACHE_DIR, `era-${id}-${startDate}-${endDate}.html`);
}

async function fetchWindow(player, win) {
  const file = cacheFile(player.id, win.startDate, win.endDate);
  if (fs.existsSync(file)) {
    const html = fs.readFileSync(file, 'utf8');
    if (html.length >= MIN_REAL_CONTENT) return { html, cached: true };
  }
  const url = `https://www.hltv.org/stats/players/${player.id}/${generateRandomSuffix()}` +
    `?startDate=${win.startDate}&endDate=${win.endDate}`;
  const html = await loadPageWithBrowser(url);
  if (html.length < MIN_REAL_CONTENT) throw new Error(`page too small (${html.length})`);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(file, html);
  return { html, cached: false };
}

async function main() {
  const out = { generatedAt: new Date().toISOString(), windows: WINDOWS.map((w) => w.label), players: {} };

  try {
    for (const player of PLAYERS) {
      out.players[player.id] = { name: player.name, byWindow: {} };
      console.log(`\n${player.name}`);
      for (const win of WINDOWS) {
        try {
          const { html, cached } = await fetchWindow(player, win);
          const stats = parsePlayerPage(html);
          out.players[player.id].byWindow[win.label] = {
            timeAliveRaw: stats.timeAliveRaw,
            timeAliveSec: stats.timeAliveSec,
            dpr: stats.dpr,
            mapsPlayed: stats.mapsPlayed,
            roundsPlayed: stats.roundsPlayed,
          };
          const maps = stats.mapsPlayed ?? 0;
          console.log(
            `  ${win.label}: ${(stats.timeAliveRaw || 'N/A').padStart(7)}  dpr=${stats.dpr ?? 'N/A'}  ` +
            `maps=${maps}${cached ? '  (cached)' : ''}${maps === 0 ? '   [no maps in this window]' : ''}`
          );
        } catch (err) {
          console.log(`  ${win.label}: FAILED — ${err.message}`);
        }
        await sleep(DELAY_MS);
      }
    }
  } finally {
    await closeBrowser();
  }

  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${OUT}`);
  console.log('  git add eras.json && git commit -m "add era breakdown" && git push');
}

main().catch((e) => {
  console.error('Fatal:', e.message);
  process.exit(1);
});

// Single-player check: fetches one player's stats-overview page and prints
// everything the parser extracts. Use this to sanity-check before the full
// 50-player run.
//
//   HLTV_CDP_URL=http://127.0.0.1:9222 node probe.js [playerId]
const { generateRandomSuffix } = require('hltv/lib/utils');
const { parsePlayerPage } = require('./parse');
const { loadPageWithBrowser, closeBrowser } = require('./browser');

async function main() {
  const id = process.argv[2] ? Number(process.argv[2]) : 11893; // ZywOo
  const url = `https://www.hltv.org/stats/players/${id}/${generateRandomSuffix()}`;
  console.log('Fetching', url);

  try {
    const html = await loadPageWithBrowser(url);
    console.log('HTML length:', html.length);

    const stats = parsePlayerPage(html);
    console.log('\nign            :', stats.ign);
    console.log('time alive raw :', stats.timeAliveRaw);
    console.log('time alive sec :', stats.timeAliveSec);
    console.log('deaths / round :', stats.dpr);
    console.log('damage / round :', stats.dmgPerRound);
    console.log('maps played    :', stats.mapsPlayed);
    console.log('attributes     :', stats.attributes);

    console.log('\nAll role-stat rows (both sides):');
    Object.entries(stats.roleStats).forEach(([k, v]) => console.log(`  ${k}: ${v}`));

    if (stats.timeAliveSec === undefined) {
      console.log('\nWARNING: no "time alive per round" row parsed — selectors in parse.js need updating.');
    }
  } finally {
    await closeBrowser();
  }
}

main().catch((e) => {
  console.error('ERROR', e.message);
  process.exit(1);
});

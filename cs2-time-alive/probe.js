// Diagnostic: dumps every stat-row label on one player's HLTV clutching
// page, so you can confirm the real "time alive per round" wording
// before trusting index.js's automatic parsing. Uses the same
// browser-backed loader as index.js since HLTV's Cloudflare protection
// rejects plain HTTP requests.
const { HLTVScraper } = require('hltv/lib/scraper');
const { fetchPage, generateRandomSuffix } = require('hltv/lib/utils');
const { loadPageWithBrowser, closeBrowser } = require('./browser');

async function main() {
  const id = process.argv[2] ? Number(process.argv[2]) : 11893; // default: ZywOo
  const url = `https://www.hltv.org/stats/players/clutching/${id}/${generateRandomSuffix()}`;
  console.log('Fetching', url);
  try {
    const root = await fetchPage(url, loadPageWithBrowser);
    console.log('HTML length:', root.html().length);
    const $ = HLTVScraper(root);
    const rows = $('.stats-row').toArray();
    console.log(`Found ${rows.length} stats-row elements on clutching page for id=${id}`);
    rows.forEach((row) => {
      console.log(row.text().replace(/\s+/g, ' ').trim());
    });
  } finally {
    await closeBrowser();
  }
}

main().catch((e) => {
  console.error('ERROR', e.message);
  process.exit(1);
});

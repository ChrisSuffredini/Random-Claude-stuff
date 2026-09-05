const { defaultConfig } = require('hltv/lib/config');
const { HLTVScraper } = require('hltv/lib/scraper');
const { fetchPage, generateRandomSuffix } = require('hltv/lib/utils');

async function main() {
  const id = 11893; // ZywOo
  const url = `https://www.hltv.org/stats/players/clutching/${id}/${generateRandomSuffix()}`;
  console.log('Fetching', url);
  const root = await fetchPage(url, defaultConfig.loadPage);
  console.log('HTML length:', root.html().length);
  console.log('RAW:', root.html());
  const $ = HLTVScraper(root);
  const rows = $('.stats-row').toArray();
  console.log(`Found ${rows.length} stats-row elements on clutching page for id=${id}`);
  rows.forEach((row) => {
    console.log(row.text().replace(/\s+/g, ' ').trim());
  });
}

main().catch((e) => {
  console.error('ERROR', e.message);
  process.exit(1);
});

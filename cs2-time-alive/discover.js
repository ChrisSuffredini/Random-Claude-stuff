// Discovery tool: finds where "time alive per round" (and the entrying
// score) actually live on HLTV, using an attached browser session.
//
// The guessed /stats/players/clutching/{id} URL 404s, and HLTV describes
// both stats as part of its "attributes" feature rather than plain stat
// rows, so this checks a spread of candidate pages and reports, for each:
// whether it loaded, its stat-row labels, this player's category nav
// links, and any occurrence of "time alive" / "clutch" / "entry" text.
//
// Run with an attached browser (see README):
//   HLTV_CDP_URL=http://127.0.0.1:9222 node discover.js [playerId]
const cheerio = require('cheerio');
const { generateRandomSuffix } = require('hltv/lib/utils');
const { loadPageWithBrowser, closeBrowser } = require('./browser');

const ID = process.argv[2] ? Number(process.argv[2]) : 11893; // default ZywOo
const SLUG = generateRandomSuffix();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CANDIDATES = [
  ['stats: overview', `https://www.hltv.org/stats/players/${ID}/${SLUG}`],
  ['stats: individual', `https://www.hltv.org/stats/players/individual/${ID}/${SLUG}`],
  ['stats: clutches', `https://www.hltv.org/stats/players/clutches/${ID}/${SLUG}`],
  ['stats: career', `https://www.hltv.org/stats/players/career/${ID}/${SLUG}`],
  ['player profile', `https://www.hltv.org/player/${ID}/${SLUG}`],
];

const TERMS = ['time alive', 'clutching', 'entrying'];

function report(label, url, html) {
  const $ = cheerio.load(html);
  const title = $('title').text().replace(/\s+/g, ' ').trim();
  console.log(`  length: ${html.length}   title: ${title || '(none)'}`);

  if (html.length < 1000) {
    console.log('  --> looks like a 404 / empty page, skipping');
    return;
  }

  const bodyText = $('body').text();
  for (const term of TERMS) {
    const idx = bodyText.toLowerCase().indexOf(term);
    if (idx === -1) {
      console.log(`  "${term}": not found`);
    } else {
      const context = bodyText.slice(Math.max(0, idx - 150), idx + 150).replace(/\s+/g, ' ').trim();
      console.log(`  "${term}": FOUND --> ...${context}...`);
    }
  }

  // Category nav for THIS player only (filters out links to other players).
  const links = new Set();
  $(`a[href*="/${ID}/"]`).each((_, el) => {
    const href = $(el).attr('href');
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (href && text && href.includes('/stats/')) links.add(`${text}  ->  ${href}`);
  });
  if (links.size) {
    console.log('  category links for this player:');
    [...links].slice(0, 30).forEach((l) => console.log(`    ${l}`));
  }

  const rows = $('.stats-row')
    .toArray()
    .map((el) => $(el).text().replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (rows.length) {
    console.log(`  .stats-row labels (${rows.length}):`);
    rows.forEach((r) => console.log(`    ${r}`));
  } else {
    console.log('  .stats-row labels: none on this page');
  }
}

async function main() {
  try {
    for (const [label, url] of CANDIDATES) {
      console.log(`\n=== ${label} ===\n  ${url}`);
      try {
        const html = await loadPageWithBrowser(url);
        report(label, url, html);
      } catch (err) {
        console.log(`  ERROR: ${err.message}`);
      }
      await sleep(1000);
    }
  } finally {
    await closeBrowser();
  }
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});

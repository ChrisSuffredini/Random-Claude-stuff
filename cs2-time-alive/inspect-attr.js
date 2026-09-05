// Second-stage discovery: discover.js proved "time alive per round" is on
// the stats OVERVIEW page, inside HLTV's attributes section (Clutching,
// Entrying, ...) rather than in a .stats-row. But indexOf only reported
// the first match — the attribute's tooltip prose — not the numbered rows.
//
// This dumps the real DOM around every occurrence of the terms we need, so
// we can write exact selectors for the value cells.
//
//   HLTV_CDP_URL=http://127.0.0.1:9222 node inspect-attr.js [playerId]
const cheerio = require('cheerio');
const { generateRandomSuffix } = require('hltv/lib/utils');
const { loadPageWithBrowser, closeBrowser } = require('./browser');

const ID = process.argv[2] ? Number(process.argv[2]) : 11893;
const SLUG = generateRandomSuffix();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PAGES = [
  ['stats overview', `https://www.hltv.org/stats/players/${ID}/${SLUG}`],
  ['clutches (correct URL)', `https://www.hltv.org/stats/players/clutches/${ID}/all/${SLUG}`],
];

// Terms whose surrounding markup we need to understand.
const TERMS = ['time alive', 'entrying', 'clutching'];

function truncate(str, n) {
  const s = str.replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function dumpMatches($, term) {
  const seen = [];
  $('*').each((_, el) => {
    const $el = $(el);
    if ($el.children().length > 0) return; // leaf nodes only
    const text = $el.text().replace(/\s+/g, ' ').trim();
    if (!text || !text.toLowerCase().includes(term)) return;
    seen.push({ $el, text });
  });

  console.log(`\n  --- "${term}": ${seen.length} leaf match(es) ---`);
  seen.slice(0, 6).forEach(({ $el, text }, i) => {
    const $parent = $el.parent();
    const $grand = $parent.parent();
    console.log(`\n  [${i + 1}] leaf text: ${truncate(text, 120)}`);
    console.log(`      leaf   : <${$el.get(0).tagName} class="${$el.attr('class') || ''}">`);
    console.log(`      parent : <${$parent.get(0)?.tagName} class="${$parent.attr('class') || ''}">`);
    console.log(`      grandp : <${$grand.get(0)?.tagName} class="${$grand.attr('class') || ''}">`);
    console.log(`      parent text : ${truncate($parent.text(), 200)}`);
    console.log(`      parent html : ${truncate($.html($parent), 500)}`);
    console.log(`      grandp text : ${truncate($grand.text(), 250)}`);
  });
  if (seen.length > 6) console.log(`\n  (${seen.length - 6} more matches not shown)`);
}

async function main() {
  try {
    for (const [label, url] of PAGES) {
      console.log(`\n\n========== ${label} ==========\n${url}`);
      try {
        const html = await loadPageWithBrowser(url);
        const $ = cheerio.load(html);
        console.log(`length: ${html.length}  title: ${$('title').text().trim()}`);
        for (const term of TERMS) dumpMatches($, term);
      } catch (err) {
        console.log(`ERROR: ${err.message}`);
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

// Offline: finds the attribute-score markup in an ALREADY CACHED page, so
// the broken Entrying parser can be fixed without re-scraping anything.
//
// parse.js looks for a leaf element whose text is exactly "NN/100"; every
// player came back with no attributes, so HLTV renders it some other way.
// This shows how.
//
//   node inspect-cache.js [playerId]        (default: first cached file)
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const CACHE_DIR = path.join(__dirname, 'cache');

function pickFile() {
  const id = process.argv[2];
  if (id) {
    for (const name of [`${id}.html`, `${id}-cs2.html`]) {
      const p = path.join(CACHE_DIR, name);
      if (fs.existsSync(p)) return p;
    }
    console.log(`No cached page for id ${id}.`);
    process.exit(1);
  }
  if (!fs.existsSync(CACHE_DIR)) {
    console.log('No cache/ directory — run index.js first.');
    process.exit(1);
  }
  const files = fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith('.html'));
  if (!files.length) {
    console.log('cache/ is empty — run index.js first.');
    process.exit(1);
  }
  return path.join(CACHE_DIR, files[0]);
}

const file = pickFile();
const html = fs.readFileSync(file, 'utf8');
const $ = cheerio.load(html);
console.log(`Inspecting ${path.basename(file)} (${html.length} chars)\n`);

const truncate = (s, n) => {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

// 1. Every element whose text mentions "/100" — however it's structured.
console.log('=== elements containing "/100" ===');
let hits = 0;
$('*').each((_, el) => {
  const $el = $(el);
  const own = $el.clone().children().remove().end().text();
  if (!own.includes('/100')) return;
  hits++;
  if (hits > 12) return;
  console.log(`\n[${hits}] <${el.tagName} class="${$el.attr('class') || ''}">`);
  console.log(`    own text    : ${truncate(own, 80)}`);
  console.log(`    parent      : <${$el.parent().get(0)?.tagName} class="${$el.parent().attr('class') || ''}">`);
  console.log(`    parent text : ${truncate($el.parent().text(), 160)}`);
  console.log(`    parent html : ${truncate($.html($el.parent()), 400)}`);
});
console.log(hits ? `\n(${hits} total)` : '\n  none found — the score may be split across elements or drawn as a graphic');

// 2. Where the attribute NAMES live, and what sits next to them.
console.log('\n\n=== attribute names (visible labels, not tooltips) ===');
for (const term of ['Clutching', 'Entrying', 'Firepower', 'Sniping']) {
  const found = [];
  $('*').each((_, el) => {
    const $el = $(el);
    if ($el.children().length > 0) return;
    const t = $el.text().replace(/\s+/g, ' ').trim();
    // skip the tooltip prose ("Entrying: How likely a player is…")
    if (t !== term) return;
    found.push($el);
  });
  console.log(`\n"${term}": ${found.length} exact-text leaf match(es)`);
  found.slice(0, 2).forEach(($el, i) => {
    const $p = $el.parent();
    const $gp = $p.parent();
    console.log(`  [${i + 1}] leaf   <${$el.get(0).tagName} class="${$el.attr('class') || ''}">`);
    console.log(`      parent <${$p.get(0)?.tagName} class="${$p.attr('class') || ''}"> text: ${truncate($p.text(), 120)}`);
    console.log(`      grandp <${$gp.get(0)?.tagName} class="${$gp.attr('class') || ''}"> text: ${truncate($gp.text(), 160)}`);
    console.log(`      grandp html: ${truncate($.html($gp), 600)}`);
  });
}

// 3. Any class that looks attribute-related, as a fallback lead.
console.log('\n\n=== classes containing "role" / "attribute" / "score" ===');
const classes = new Map();
$('[class]').each((_, el) => {
  const cls = $(el).attr('class') || '';
  if (!/role|attribut|score|rating-breakdown/i.test(cls)) return;
  classes.set(cls, (classes.get(cls) || 0) + 1);
});
[...classes.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 25)
  .forEach(([cls, n]) => console.log(`  ${String(n).padStart(3)}x  ${cls}`));

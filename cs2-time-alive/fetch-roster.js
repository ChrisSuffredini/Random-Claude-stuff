// Builds roster.json from HLTV's live world ranking — team order AND each
// team's current five, in a single request. Replaces the hardcoded
// 2026-08-10 snapshot in roster.js and lets the sample go past the top 10.
//
//   HLTV_CDP_URL=http://127.0.0.1:9222 node fetch-roster.js [topN]
//
// Everything downstream (index.js, compare.js, analyze.js) picks up
// roster.json automatically once it exists.
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { loadPageWithBrowser, closeBrowser } = require('./browser');

const TOP_N = Number(process.argv[2] || 30);
const OUT = path.join(__dirname, 'roster.json');

function parseRanking(html) {
  const $ = cheerio.load(html);
  const teams = [];

  $('.ranked-team').each((_, el) => {
    const $t = $(el);
    const name =
      $t.find('.name').first().text().trim() ||
      $t.find('.teamLine .name').first().text().trim();
    const rank = Number($t.find('.position').first().text().replace('#', '').trim()) || teams.length + 1;

    const players = [];
    const seen = new Set();
    $t.find('a[href*="/player/"]').each((_, a) => {
      const href = $(a).attr('href') || '';
      const m = href.match(/\/player\/(\d+)\/([^/?#]+)/);
      if (!m) return;
      const id = Number(m[1]);
      if (seen.has(id)) return;
      seen.add(id);
      const $a = $(a);
      const nick =
        $a.find('img').attr('title') ||
        $a.find('.nick').text().trim() ||
        $a.text().trim() ||
        decodeURIComponent(m[2]);
      players.push({ name: nick, id });
    });

    if (name && players.length) teams.push({ team: name, rank, players });
  });

  return teams;
}

// If the selectors miss, say what the page actually contains rather than
// silently writing an empty roster.
function diagnose(html) {
  const $ = cheerio.load(html);
  console.log(`\nCould not parse any teams. Page length ${html.length}, title: ${$('title').text().trim()}`);
  const classes = new Map();
  $('[class]').each((_, el) => {
    const cls = $(el).attr('class') || '';
    if (!/team|rank|player/i.test(cls)) return;
    classes.set(cls, (classes.get(cls) || 0) + 1);
  });
  console.log('\nCandidate classes (team/rank/player):');
  [...classes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
    .forEach(([cls, n]) => console.log(`  ${String(n).padStart(3)}x  ${cls}`));
  const links = new Set();
  $('a[href*="/player/"]').slice(0, 10).each((_, a) => links.add($(a).attr('href')));
  console.log(`\nSample /player/ links (${links.size}):`);
  [...links].forEach((l) => console.log(`  ${l}`));
}

async function main() {
  try {
    const url = 'https://www.hltv.org/ranking/teams';
    console.log('Fetching', url);
    const html = await loadPageWithBrowser(url);

    const all = parseRanking(html);
    if (!all.length) {
      diagnose(html);
      process.exitCode = 1;
      return;
    }

    const teams = all.slice(0, TOP_N);
    const incomplete = teams.filter((t) => t.players.length !== 5);
    fs.writeFileSync(OUT, JSON.stringify({ fetchedAt: new Date().toISOString(), teams }, null, 2));

    console.log(`\nParsed ${all.length} ranked teams, keeping top ${teams.length}:\n`);
    teams.forEach((t) =>
      console.log(`  #${String(t.rank).padStart(2)} ${t.team.padEnd(18)} ${t.players.map((p) => p.name).join(', ')}`)
    );
    console.log(`\n${teams.reduce((n, t) => n + t.players.length, 0)} players written to roster.json`);
    if (incomplete.length) {
      console.log(`\nNote: ${incomplete.length} team(s) not showing exactly 5 players ` +
        `(${incomplete.map((t) => `${t.team}:${t.players.length}`).join(', ')}) — stand-ins or a layout change.`);
    }
    console.log('\nindex.js will now use this instead of the hardcoded roster. Next:');
    console.log('  HLTV_CDP_URL=http://127.0.0.1:9222 node index.js --cs2');
  } finally {
    await closeBrowser();
  }
}

main().catch((e) => {
  console.error('Fatal:', e.message);
  process.exit(1);
});

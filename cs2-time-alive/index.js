// Compares "time alive per round" across the 50 players on HLTV's top-10
// teams. Everything needed (time alive, DPR, attribute scores) lives on
// each player's stats-overview page, so this makes ONE request per player.
//
// Pages are cached to cache/<id>.html, so a re-run costs nothing and
// parsing can be revised without re-scraping.
//
//   HLTV_CDP_URL=http://127.0.0.1:9222 node index.js [--cs2] [--refresh]
const fs = require('fs');
const path = require('path');
const { generateRandomSuffix } = require('hltv/lib/utils');
const { flattenRoster } = require('./roster');
const { parsePlayerPage } = require('./parse');
const { loadPageWithBrowser, closeBrowser } = require('./browser');

const CACHE_DIR = path.join(__dirname, 'cache');
// Overridable so the retry flow can be exercised quickly in a test.
const DELAY_MS = Number(process.env.HLTV_DELAY_MS || 800);
const RETRY_ROUNDS = Number(process.env.HLTV_RETRY_ROUNDS || 3);
const RETRY_BASE_DELAY_MS = Number(process.env.HLTV_RETRY_DELAY_MS || 3000); // grows: 3s, 6s, 9s
const MIN_REAL_CONTENT = 50000; // a real stats page is ~650KB
const CS2_ONLY = process.argv.includes('--cs2');
const REFRESH = process.argv.includes('--refresh');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fmt(n, digits = 2) {
  return typeof n === 'number' && Number.isFinite(n) ? n.toFixed(digits) : 'N/A';
}

function cacheFile(id) {
  return path.join(CACHE_DIR, `${id}${CS2_ONLY ? '-cs2' : ''}.html`);
}

async function getPlayerHtml(player, { forceFetch = false } = {}) {
  const file = cacheFile(player.id);
  if (!REFRESH && !forceFetch && fs.existsSync(file)) {
    const html = fs.readFileSync(file, 'utf8');
    if (html.length >= MIN_REAL_CONTENT) return { html, cached: true };
  }

  const query = CS2_ONLY ? '?csVersion=CS2' : '';
  const url = `https://www.hltv.org/stats/players/${player.id}/${generateRandomSuffix()}${query}`;
  const html = await loadPageWithBrowser(url);
  if (html.length < MIN_REAL_CONTENT) {
    throw new Error(`page too small (${html.length} chars) — blocked or 404`);
  }
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(file, html);
  return { html, cached: false };
}

// Fetches and parses one player. Throws on anything retryable: a failed
// fetch, or a page that came back without even the basic stats table
// (which means we got a Cloudflare interstitial or the wrong page, not a
// player who genuinely has no attribute rows).
async function fetchPlayer(player, { forceFetch = false } = {}) {
  const { html, cached } = await getPlayerHtml(player, { forceFetch });
  const stats = parsePlayerPage(html);

  if (Object.keys(stats.statsRows).length === 0) {
    throw new Error('no stats rows on page — wrong page or interstitial');
  }
  return { row: { ...player, ...stats }, cached, stats };
}

async function run() {
  const roster = flattenRoster();
  const results = [];
  let pending = [];
  let debugged = false;

  console.log(
    `Scope: ${CS2_ONLY ? 'CS2 only' : 'career, all maps, both sides, no filters (includes CS:GO history)'}\n`
  );

  for (const player of roster) {
    try {
      const { row, cached, stats } = await fetchPlayer(player);

      if (!debugged) {
        // One-time sanity dump on the first player, so a parsing
        // regression is obvious before the other 49 are trusted.
        console.log(`[debug] ${player.name}: time alive raw=${JSON.stringify(stats.timeAliveRaw)} ` +
          `-> ${stats.timeAliveSec}s | dpr=${stats.dpr} | attributes=${JSON.stringify(stats.attributes)}`);
        if (stats.timeAliveSec === undefined) {
          console.log('[debug] WARNING: no "time alive per round" row found — check parse.js selectors');
          console.log(`[debug] role stat rows seen: ${JSON.stringify(Object.keys(stats.roleStats))}`);
        }
        console.log('');
        debugged = true;
      }

      results.push(row);
      console.log(
        `OK   ${player.team.padEnd(15)} ${player.name.padEnd(11)} ` +
        `${(stats.timeAliveRaw || 'N/A').padStart(7)}${cached ? '  (cached)' : ''}`
      );
    } catch (err) {
      pending.push({ player, error: err.message });
      console.log(`FAIL ${player.team.padEnd(15)} ${player.name.padEnd(11)} — ${err.message}`);
    }
    await sleep(DELAY_MS);
  }

  // Retry anything that failed, a few times, with a growing pause — these
  // failures are usually transient blocking rather than a missing player.
  // Always re-fetch (never trust a cached page for a retry).
  for (let round = 1; round <= RETRY_ROUNDS && pending.length > 0; round++) {
    const waitMs = RETRY_BASE_DELAY_MS * round;
    console.log(
      `\nRetry ${round}/${RETRY_ROUNDS} for ${pending.length} player(s): ` +
      `${pending.map((f) => f.player.name).join(', ')} (waiting ${waitMs / 1000}s first)`
    );
    await sleep(waitMs);

    const stillFailing = [];
    for (const { player } of pending) {
      try {
        const { row, stats } = await fetchPlayer(player, { forceFetch: true });
        results.push(row);
        console.log(
          `OK   ${player.team.padEnd(15)} ${player.name.padEnd(11)} ` +
          `${(stats.timeAliveRaw || 'N/A').padStart(7)}  (retry ${round})`
        );
      } catch (err) {
        stillFailing.push({ player, error: err.message });
        console.log(`FAIL ${player.team.padEnd(15)} ${player.name.padEnd(11)} — ${err.message}`);
      }
      await sleep(waitMs);
    }
    pending = stillFailing;
  }

  const failures = pending;

  const ranked = results.filter((r) => typeof r.timeAliveSec === 'number');
  const unranked = results.filter((r) => typeof r.timeAliveSec !== 'number');
  ranked.sort((a, b) => b.timeAliveSec - a.timeAliveSec);

  console.log('\n\n=== TIME ALIVE PER ROUND — CS2 TOP-10 TEAMS ===\n');
  const head = ['#', 'player', 'team', 'time_alive', 'seconds', 'dpr', 'entrying'];
  const widths = [3, 11, 15, 10, 8, 6, 8];
  const row = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join(' ');
  console.log(row(head));
  console.log(widths.map((w) => '-'.repeat(w)).join(' '));
  ranked.forEach((r, i) => {
    console.log(row([i + 1, r.name, r.team, r.timeAliveRaw, fmt(r.timeAliveSec, 1), fmt(r.dpr), fmt(r.entrying, 0)]));
  });

  if (unranked.length) {
    console.log('\n(no time-alive value parsed — excluded from ranking)');
    unranked.forEach((r) => console.log(row(['-', r.name, r.team, 'N/A', 'N/A', fmt(r.dpr), fmt(r.entrying, 0)])));
  }

  if (ranked.length) {
    const max = ranked[0];
    const min = ranked[ranked.length - 1];
    console.log(`\nMAX: ${max.name} (${max.team}) — ${max.timeAliveRaw} = ${fmt(max.timeAliveSec, 1)}s`);
    console.log(`MIN: ${min.name} (${min.team}) — ${min.timeAliveRaw} = ${fmt(min.timeAliveSec, 1)}s`);
    console.log(`Spread: ${fmt(max.timeAliveSec - min.timeAliveSec, 1)}s`);
  } else {
    console.log('\nNo time-alive values parsed — nothing to rank.');
  }

  console.log(`\n${results.length}/${roster.length} players fetched (${failures.length} failed).`);
  failures.forEach((f) => console.log(`  - ${f.player.team} ${f.player.name} (${f.player.id}): ${f.error}`));
}

async function main() {
  try {
    await run();
  } finally {
    await closeBrowser();
  }
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});

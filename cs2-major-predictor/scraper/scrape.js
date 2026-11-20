// Pulls everything the Major model needs from HLTV, as compact gzipped
// HTML under data/raw/ (committed, so the model can be rebuilt anywhere
// without touching HLTV again). Parsing happens in model/parse.py.
//
//   HLTV_CDP_URL=http://127.0.0.1:9222 node scraper/scrape.js            # full run (resumable)
//   HLTV_CDP_URL=http://127.0.0.1:9222 node scraper/scrape.js --probe    # 1 page of each kind
//
// Flags:
//   --probe              fetch one page of each kind, print what was found, stop
//   --only a,b           subset of: events,results,lan,rankings,maps,players
//                        (default: events,results,lan,rankings; maps/players are opt-in)
//   --from YYYY-MM       first month of results and rankings (default 2023-01)
//   --to YYYY-MM         last month of results and rankings (default: this month)
//   --refresh            refetch everything, ignoring what is already saved
//   --event ID           HLTV event id of the Major to predict (default 8302, PGL Singapore 2026)
//
// What it fetches (~600 requests in total; a full run takes 15-30 minutes):
//   events    the Major's event page, its stage sub-events, their match lists
//   results   /results month by month, 100 matches a page (all matches)
//   lan       the same with matchType=Lan, used to tag which matches were LAN
//   rankings  HLTV world ranking every other Monday (points, lineups)
//   maps      /stats/matches month by month: every map vs top-50 teams, with
//             map name, round score and team ids (~400-600 requests)
//   players   /stats/players month by month: every player's rating, maps,
//             K/D, overall and vs top-50 teams (~80 requests)
//
// Re-running skips what is saved, except the current and previous month,
// the event pages and the latest ranking, which are always refreshed.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const cheerio = require('cheerio');
const { HltvBrowser } = require('./hltv-browser');

const ROOT = process.env.HLTV_OUT || path.join(__dirname, '..', 'data', 'raw');
const MANIFEST = path.join(ROOT, 'manifest.json');
const BASE = process.env.HLTV_BASE || 'https://www.hltv.org'; // override only for testing
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december'];

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const PROBE = flag('probe');
const REFRESH = flag('refresh');
const ONLY = opt('only', 'events,results,lan,rankings').split(',');
const FROM = opt('from', '2023-01');
const TO = opt('to', null); // e.g. 2022-12 to pull an older era only
const toDate = () => {
  if (!TO) return new Date();
  const [y, m] = TO.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0));
};
const STATS_FROM = opt('stats-from', '2023-10'); // CS2 era only for map/player stats
const EVENT_ID = Number(opt('event', 8302));

const manifest = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : {};
const saveManifest = () => fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1));

// Keep only the part of the page we parse, drop scripts/styles, gzip.
function trim(html, selectors) {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg, iframe, link, meta').remove();
  for (const sel of selectors) {
    const el = $(sel).first();
    if (el.length) return { html: $.html(el), container: sel, $ };
  }
  return { html: $('body').html() || html, container: 'body', $ };
}

function write(rel, html) {
  const file = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const gz = zlib.gzipSync(Buffer.from(html, 'utf8'), { level: 9 });
  fs.writeFileSync(file, gz);
  return gz.length;
}

const have = (rel) => !REFRESH && fs.existsSync(path.join(ROOT, rel)) && manifest[rel];

function countResults($) {
  return $('.result-con').length - $('.big-results .result-con').length;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function monthList(from, to) {
  const [fy, fm] = from.split('-').map(Number);
  const out = [];
  let y = fy;
  let m = fm;
  while (y < to.getUTCFullYear() || (y === to.getUTCFullYear() && m <= to.getUTCMonth() + 1)) {
    out.push({ y, m });
    m++;
    if (m === 13) {
      m = 1;
      y++;
    }
  }
  return out;
}

const isoDate = (d) => d.toISOString().slice(0, 10);

let browser;
const stats = { requests: 0, bytes: 0, warnings: [] };

async function fetchAndSave(rel, url, selectors, extra = {}) {
  const res = await browser.get(url);
  stats.requests++;
  const t = trim(res.html, selectors);
  const bytes = write(rel, t.html);
  stats.bytes += bytes;
  manifest[rel] = {
    url,
    finalUrl: res.finalUrl,
    status: res.status,
    container: t.container,
    fetchedAt: new Date().toISOString(),
    bytes,
    via: res.via,
    ...extra,
  };
  if (res.status !== 200) stats.warnings.push(`${rel}: HTTP ${res.status}`);
  if (t.container === 'body') stats.warnings.push(`${rel}: expected container not found (saved whole body)`);
  return { ...res, $: t.$, container: t.container };
}

// ---------------------------------------------------------------- results
async function scrapeResults(kind) {
  const now = toDate();
  const months = monthList(FROM, now).reverse(); // newest first
  const extraQuery = kind === 'lan' ? '&matchType=Lan' : '';
  const dir = kind === 'lan' ? 'results-lan' : 'results';
  let pageSize = 100;
  const list = PROBE ? months.slice(1, 2) : months;

  for (const { y, m } of list) {
    const start = `${y}-${pad(m)}-01`;
    const last = new Date(Date.UTC(y, m, 0));
    const end = isoDate(last);
    // A month is final once it ended a few days before we last fetched it.
    const firstKey = `${dir}/${y}-${pad(m)}_p00.html.gz`;
    const prev = manifest[firstKey];
    const isFinal = prev && new Date(prev.fetchedAt) > new Date(last.getTime() + 3 * 864e5);
    if (have(firstKey) && isFinal) continue;

    let total = 0;
    for (let p = 0; p < 60; p++) {
      const rel = `${dir}/${y}-${pad(m)}_p${pad(p)}.html.gz`;
      const url = `${BASE}/results?startDate=${start}&endDate=${end}${extraQuery}&offset=${p * 100}`;
      const res = await fetchAndSave(rel, url, ['.results-holder', '.results', '.contentCol'], {
        kind: dir,
        month: `${y}-${pad(m)}`,
        page: p,
      });
      const n = countResults(res.$);
      manifest[rel].count = n;
      total += n;
      if (p === 0 && n > 0 && n !== 100) {
        if (n === 50) pageSize = 50;
      }
      if (n === 0 && p === 0) stats.warnings.push(`${rel}: no results parsed on first page`);
      if (n < pageSize) {
        // Remove stale later pages from an earlier, longer fetch.
        for (let q = p + 1; q < 60; q++) {
          const stale = `${dir}/${y}-${pad(m)}_p${pad(q)}.html.gz`;
          if (!manifest[stale]) break;
          fs.rmSync(path.join(ROOT, stale), { force: true });
          delete manifest[stale];
        }
        break;
      }
    }
    saveManifest();
    console.log(`  ${dir} ${y}-${pad(m)}: ${total} matches   (${stats.requests} requests so far)`);
  }
}

// --------------------------------------------------------------- rankings
function rankingDates() {
  // Every other Monday from the first Monday of --from, plus the latest Monday.
  const out = [];
  const [fy, fm] = FROM.split('-').map(Number);
  const d = new Date(Date.UTC(fy, fm - 1, 1));
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  const today = toDate();
  while (d <= today) {
    out.push(new Date(d));
    d.setUTCDate(d.getUTCDate() + 14);
  }
  const latest = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  while (latest.getUTCDay() !== 1) latest.setUTCDate(latest.getUTCDate() - 1);
  if (isoDate(out[out.length - 1]) !== isoDate(latest)) out.push(latest);
  return out;
}

async function scrapeRankings() {
  const dates = rankingDates().reverse();
  const list = PROBE ? dates.slice(0, 1) : dates;
  let done = 0;
  for (const d of list) {
    const rel = `rankings/${isoDate(d)}.html.gz`;
    const isLatest = d === dates[0];
    if (have(rel) && !isLatest) continue;
    const url = `${BASE}/ranking/teams/${d.getUTCFullYear()}/${MONTHS[d.getUTCMonth()]}/${d.getUTCDate()}`;
    const res = await fetchAndSave(rel, url, ['.contentCol', '.ranking'], { kind: 'ranking', date: isoDate(d) });
    const n = res.$('.ranked-team').length;
    manifest[rel].count = n;
    if (n === 0) stats.warnings.push(`${rel}: no ranked teams found`);
    done++;
    if (done % 10 === 0 || PROBE) {
      saveManifest();
      console.log(`  rankings: ${done} pages (latest ${isoDate(d)}: ${n} teams)`);
    }
  }
  saveManifest();
}

// ----------------------------------------------------------------- events
async function scrapeEvents() {
  const seen = new Set();
  const queue = [EVENT_ID];
  while (queue.length && seen.size < 10) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const res = await fetchAndSave(`events/${id}.html.gz`, `${BASE}/events/${id}/x`, ['.contentCol'], {
      kind: 'event',
      eventId: id,
    });
    const title = res.$('.event-hub-title').first().text().trim() || res.$('h1').first().text().trim();
    const teams = res.$('.team-box').length;
    console.log(`  event ${id}: "${title}" (${teams} team boxes)`);

    // Stage sub-events of the same Major (Stage 1/2/3, playoffs): their
    // slugs extend the parent's, e.g. pgl-major-singapore-2026-stage-1.
    if (id === EVENT_ID) {
      const parentSlug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      res.$('a[href^="/events/"]').each((_, a) => {
        const href = res.$(a).attr('href') || '';
        const m = href.match(/^\/events\/(\d+)\/([^?#/]+)/);
        if (!m) return;
        const slug = m[2].toLowerCase();
        if (parentSlug && slug.startsWith(parentSlug) && slug !== parentSlug) queue.push(Number(m[1]));
      });
      if (queue.length === 0) stats.warnings.push(`no stage sub-events found on event ${id} (title "${title}")`);
    }
    // Upcoming matches (round-1 pairings) and any results already played.
    await fetchAndSave(`events/${id}-matches.html.gz`, `${BASE}/matches?event=${id}`, ['.contentCol'], {
      kind: 'event-matches',
      eventId: id,
    });
    const r = await fetchAndSave(`events/${id}-results.html.gz`, `${BASE}/results?event=${id}`, ['.results-holder', '.contentCol'], {
      kind: 'event-results',
      eventId: id,
    });
    manifest[`events/${id}-results.html.gz`].count = countResults(r.$);
    saveManifest();
  }
}

// ------------------------------------------------- map stats (per map)
async function scrapeMapStats() {
  const now = new Date();
  const months = monthList(STATS_FROM, now).reverse();
  const list = PROBE ? months.slice(1, 2) : months;
  for (const { y, m } of list) {
    const start = `${y}-${pad(m)}-01`;
    const last = new Date(Date.UTC(y, m, 0));
    const firstKey = `maps/${y}-${pad(m)}_p00.html.gz`;
    const prev = manifest[firstKey];
    const isFinal = prev && new Date(prev.fetchedAt) > new Date(last.getTime() + 3 * 864e5);
    if (have(firstKey) && isFinal) continue;
    let total = 0;
    let pageSize = 50;
    for (let p = 0; p < 200; p++) {
      const rel = `maps/${y}-${pad(m)}_p${pad(p)}.html.gz`;
      const url = `${BASE}/stats/matches?csVersion=CS2&startDate=${start}&endDate=${isoDate(last)}` +
        `&rankingFilter=Top50&offset=${p * pageSize}`;
      const res = await fetchAndSave(rel, url, ['.matches-table', '.contentCol'], { kind: 'maps', month: `${y}-${pad(m)}`, page: p });
      const n = res.$('.matches-table tbody tr').length;
      manifest[rel].count = n;
      total += n;
      if (p === 0 && n === 100) pageSize = 100;
      if (p === 0 && n === 0) stats.warnings.push(`${rel}: no map rows on first page`);
      if (n < pageSize) {
        for (let q = p + 1; q < 200; q++) {
          const stale = `maps/${y}-${pad(m)}_p${pad(q)}.html.gz`;
          if (!manifest[stale]) break;
          fs.rmSync(path.join(ROOT, stale), { force: true });
          delete manifest[stale];
        }
        break;
      }
    }
    saveManifest();
    console.log(`  maps ${y}-${pad(m)}: ${total} maps   (${stats.requests} requests so far)`);
  }
}

// ---------------------------------------------- player stats (monthly)
async function scrapePlayerStats() {
  const now = new Date();
  const months = monthList(STATS_FROM, now).reverse();
  const list = PROBE ? months.slice(1, 2) : months;
  for (const { y, m } of list) {
    const start = `${y}-${pad(m)}-01`;
    const last = new Date(Date.UTC(y, m, 0));
    for (const [tag, extra] of [['all', ''], ['top50', '&rankingFilter=Top50']]) {
      const rel = `players/${y}-${pad(m)}_${tag}.html.gz`;
      const prev = manifest[rel];
      const isFinal = prev && new Date(prev.fetchedAt) > new Date(last.getTime() + 3 * 864e5);
      if (have(rel) && isFinal) continue;
      const url = `${BASE}/stats/players?csVersion=CS2&startDate=${start}&endDate=${isoDate(last)}&minMapCount=3${extra}`;
      const res = await fetchAndSave(rel, url, ['.player-ratings-table', '.contentCol'], { kind: 'players', month: `${y}-${pad(m)}`, filter: tag });
      const n = res.$('.player-ratings-table tbody tr').length;
      manifest[rel].count = n;
      if (n === 0) stats.warnings.push(`${rel}: no player rows`);
      console.log(`  players ${y}-${pad(m)} (${tag}): ${n} players`);
    }
    saveManifest();
  }
}

async function main() {
  fs.mkdirSync(ROOT, { recursive: true });
  browser = new HltvBrowser({
    cdpUrl: process.env.HLTV_CDP_URL,
    base: BASE,
    ...(process.env.HLTV_FAST_TEST ? { minDelayMs: 0, maxDelayMs: 5 } : {}),
  });
  await browser.init();
  const t0 = Date.now();
  try {
    if (ONLY.includes('events')) {
      console.log('\n== Major event pages');
      await scrapeEvents();
    }
    if (ONLY.includes('results')) {
      console.log('\n== Results (all matches), newest month first');
      await scrapeResults('all');
    }
    if (ONLY.includes('lan')) {
      console.log('\n== Results (LAN only)');
      await scrapeResults('lan');
    }
    if (ONLY.includes('rankings')) {
      console.log('\n== HLTV world rankings');
      await scrapeRankings();
    }
    if (ONLY.includes('players')) {
      console.log('\n== Player ratings (monthly, all opponents and vs top 50)');
      await scrapePlayerStats();
    }
    if (ONLY.includes('maps')) {
      console.log('\n== Map-level results vs top-50 teams (monthly)');
      await scrapeMapStats();
    }
  } finally {
    saveManifest();
    await browser.close();
  }

  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  console.log(`\nDone: ${stats.requests} requests, ${(stats.bytes / 1e6).toFixed(1)} MB saved, ${mins} min.`);
  if (stats.warnings.length) {
    console.log(`\n${stats.warnings.length} warning(s):`);
    stats.warnings.slice(0, 30).forEach((w) => console.log(`  - ${w}`));
  }
  if (PROBE) {
    console.log('\nProbe finished. If the counts above look sane (results ~100, rankings 30+), run without --probe.');
  } else if (!process.env.HLTV_NO_GIT_HINT) {
    console.log('\nNext: git add data/raw && git commit -m "HLTV data" && git push');
  }
}

main().catch((e) => {
  console.error('Fatal:', e.stack || e.message);
  saveManifest();
  process.exit(1);
});

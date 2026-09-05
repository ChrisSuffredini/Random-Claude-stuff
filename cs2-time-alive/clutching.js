// getPlayerStats() in the `hltv` package only scrapes the Overview,
// Individual, and Matches pages for a player — it never requests
// /stats/players/clutching/{id}, which is where "time alive per round"
// actually lives on HLTV's site. The package has no dedicated endpoint
// for it either, so we scrape that page ourselves, reusing the same
// internal helpers (fetchPage/HLTVScraper/defaultConfig) the package
// uses for its own endpoints, so requests look identical to the rest of
// the library's traffic (same headers/UA via got-scraping).
const { defaultConfig } = require('hltv/lib/config');
const { HLTVScraper } = require('hltv/lib/scraper');
const { fetchPage, generateRandomSuffix, parseNumber } = require('hltv/lib/utils');

// Labels this stat has been seen/expected under. HLTV wording drifts
// between redesigns, so match loosely (case-insensitive substring).
const TIME_ALIVE_LABEL_PATTERNS = [
  /time\s*alive\s*per\s*round/i,
  /time\s*alive\s*\/\s*round/i,
  /avg\.?\s*time\s*alive/i,
];

function parseTimeAliveValue(text) {
  const trimmed = text.trim();
  // mm:ss format, e.g. "0:47"
  const clockMatch = trimmed.match(/^(\d+):(\d{2})$/);
  if (clockMatch) {
    return Number(clockMatch[1]) * 60 + Number(clockMatch[2]);
  }
  // plain seconds, possibly with a trailing "s", e.g. "47.3" or "47.3s"
  const numeric = parseNumber(trimmed.replace(/s$/i, ''));
  return numeric;
}

/**
 * Scrapes https://www.hltv.org/stats/players/clutching/{id} for
 * "time alive per round" (seconds). Returns { timeAlivePerRound, rawLabels }.
 * rawLabels is included so callers/tools can inspect actual page wording
 * if the label patterns above ever stop matching.
 */
async function getClutchingStats(id) {
  const url = `https://www.hltv.org/stats/players/clutching/${id}/${generateRandomSuffix()}`;
  const root = await fetchPage(url, defaultConfig.loadPage);
  const $ = HLTVScraper(root);

  const rows = $('.stats-row').toArray();
  const rawLabels = rows.map((row) => row.text().replace(/\s+/g, ' ').trim());

  let timeAlivePerRound;
  for (const row of rows) {
    const text = row.text();
    if (TIME_ALIVE_LABEL_PATTERNS.some((re) => re.test(text))) {
      const valueText = row.find('span').eq(1).text();
      timeAlivePerRound = parseTimeAliveValue(valueText);
      if (timeAlivePerRound !== undefined) break;
    }
  }

  return { timeAlivePerRound, rawLabels };
}

module.exports = { getClutchingStats, parseTimeAliveValue, TIME_ALIVE_LABEL_PATTERNS };

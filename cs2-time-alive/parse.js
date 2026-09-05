// All parsing of an HLTV player stats-overview page lives here, separate
// from fetching, so cached HTML can be re-parsed without re-scraping.
//
// Verified structure (from inspect-attr.js against ZywOo's page):
//
//   <div class="role-stats-row   stats-side-combined">
//     <div class="role-stats-top">
//       <div class="role-stats-title">Time alive per round</div>
//       <div class="role-stats-data">1m 10s</div>
//     </div>
//   </div>
//
// The same row repeats as stats-side-ct / stats-side-t (hidden); we take
// stats-side-combined for both-sides numbers.
const cheerio = require('cheerio');

const ATTRIBUTE_NAMES = ['Firepower', 'Entrying', 'Trading', 'Opening', 'Clutching', 'Sniping', 'Utility'];

// HLTV renders durations as "1m 10s" (also seen: "58s", "1m"). Falls back
// to mm:ss and bare numbers so a format change doesn't silently zero out.
function parseDuration(text) {
  if (!text) return undefined;
  const t = String(text).replace(/\s+/g, ' ').trim();

  const mAndS = t.match(/^(?:(\d+)\s*m)?\s*(?:(\d+(?:\.\d+)?)\s*s)?$/i);
  if (mAndS && (mAndS[1] || mAndS[2])) {
    return Number(mAndS[1] || 0) * 60 + Number(mAndS[2] || 0);
  }

  const clock = t.match(/^(\d+):(\d{2})$/);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]);

  const bare = Number(t.replace(/[^\d.]/g, ''));
  return Number.isFinite(bare) && t.length > 0 ? bare : undefined;
}

function toNumber(text) {
  if (text === undefined || text === null) return undefined;
  const n = Number(String(text).replace('%', '').trim());
  return Number.isFinite(n) ? n : undefined;
}

// The classic overview table: <div class="stats-row"><span>label</span><span>value</span></div>
function parseStatsRows($) {
  const out = {};
  $('.stats-row').each((_, el) => {
    const spans = $(el).find('span');
    const label = spans.eq(0).text().replace(/\s+/g, ' ').trim().toLowerCase();
    const value = spans.eq(1).text().replace(/\s+/g, ' ').trim();
    if (label) out[label] = value;
  });
  return out;
}

// The attributes ("role") breakdown rows, both-sides variant.
function parseRoleStats($) {
  const out = {};
  $('.role-stats-row.stats-side-combined .role-stats-top').each((_, el) => {
    const title = $(el).find('.role-stats-title').text().replace(/\s+/g, ' ').trim().toLowerCase();
    const data = $(el).find('.role-stats-data').text().replace(/\s+/g, ' ').trim();
    if (title) out[title] = data;
  });
  return out;
}

// Attribute scores (Entrying, Clutching, ...), verified structure:
//
//   <div class="role-stats-section-title">Entrying<div class="hidden">…tooltip…</div></div>
//   <div class="row-stats-section-score">77<span class="row-stats-section-score-100">/100</span></div>
//
// Two traps: the score's number is a bare text node on the div with "/100"
// in a child span (so the div's text is "77/100" but it is not a leaf), and
// the title holds the tooltip as a child, so its text is not just the name.
// Each attribute also repeats per side — combined, plus hidden ct and t.
function ownText($el) {
  return $el.clone().children().remove().end().text().replace(/\s+/g, ' ').trim();
}

function parseAttributes($) {
  const out = {};

  $('.row-stats-section-score').each((_, el) => {
    const $score = $(el);
    const m = $score.text().replace(/\s+/g, '').match(/^(\d{1,3})\/100$/);
    if (!m) return;
    // Skip the per-side duplicates; keep both-sides numbers.
    if ($score.closest('.hidden, .stats-side-ct, .stats-side-t').length) return;

    // Walk up to the section this score belongs to. Stop at the first
    // ancestor holding exactly one title — more than one means we have
    // climbed into a container of several sections and can no longer say
    // which name this score goes with, so report nothing rather than guess.
    let $anc = $score.parent();
    for (let depth = 0; depth < 5 && $anc.length; depth++) {
      const $titles = $anc.find('.role-stats-section-title');
      if ($titles.length === 1) {
        const name = ownText($titles.first());
        if (name && out[name.toLowerCase()] === undefined) out[name.toLowerCase()] = Number(m[1]);
        return;
      }
      if ($titles.length > 1) return;
      $anc = $anc.parent();
    }
  });

  return out;
}

function parsePlayerPage(html) {
  const $ = cheerio.load(html);
  const statsRows = parseStatsRows($);
  const roleStats = parseRoleStats($);
  const attributes = parseAttributes($);

  const timeAliveRaw = roleStats['time alive per round'];

  return {
    ign: $('.context-item-name').text().trim() || undefined,
    timeAliveRaw,
    timeAliveSec: parseDuration(timeAliveRaw),
    dpr: toNumber(statsRows['deaths / round']),
    kdRatio: toNumber(statsRows['k/d ratio']),
    dmgPerRound: toNumber(statsRows['damage / round']),
    mapsPlayed: toNumber(statsRows['maps played']),
    roundsPlayed: toNumber(statsRows['rounds played']),
    entrying: attributes.entrying,
    clutching: attributes.clutching,
    attributes,
    statsRows,
    roleStats,
  };
}

module.exports = { parsePlayerPage, parseDuration, parseAttributes, parseRoleStats, toNumber };

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

// Attribute scores render as "80/100" next to the attribute's name.
// Matched structurally rather than by a guessed class name.
function parseAttributes($) {
  const out = {};
  $('*').each((_, el) => {
    const $el = $(el);
    if ($el.children().length > 0) return;
    const text = $el.text().replace(/\s+/g, ' ').trim();
    const score = text.match(/^(\d{1,3})\s*\/\s*100$/);
    if (!score) return;

    // The attribute's name sits alongside the score; widen the search up
    // to the grandparent if the immediate parent doesn't carry it.
    // Plain substring match, not \b...\b — adjacent elements concatenate
    // into "49/100Entrying", where there's no word boundary after "100".
    for (const $scope of [$el.parent(), $el.parent().parent()]) {
      const context = $scope.text().replace(/\s+/g, ' ').toLowerCase();
      const name = ATTRIBUTE_NAMES.find((n) => context.includes(n.toLowerCase()));
      if (name) {
        const key = name.toLowerCase();
        if (out[key] === undefined) out[key] = Number(score[1]);
        return;
      }
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

// Side-by-side of career (all-time, includes CS:GO) vs CS2-only time
// alive per round. Purely offline — reads the HTML already cached by
// `node index.js` and `node index.js --cs2`, so it costs no requests.
//
//   node compare.js
const fs = require('fs');
const path = require('path');
const { flattenRoster } = require('./roster');
const { parsePlayerPage } = require('./parse');

const CACHE_DIR = path.join(__dirname, 'cache');

function readCached(id, cs2) {
  const file = path.join(CACHE_DIR, `${id}${cs2 ? '-cs2' : ''}.html`);
  if (!fs.existsSync(file)) return undefined;
  try {
    return parsePlayerPage(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function fmt(n, digits = 1) {
  return typeof n === 'number' && Number.isFinite(n) ? n.toFixed(digits) : 'N/A';
}

function signed(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 'N/A';
  return `${n > 0 ? '+' : ''}${n.toFixed(1)}`;
}

const rows = [];
let missingCareer = 0;
let missingCs2 = 0;

for (const player of flattenRoster()) {
  const career = readCached(player.id, false);
  const cs2 = readCached(player.id, true);
  if (!career) missingCareer++;
  if (!cs2) missingCs2++;
  if (!career && !cs2) continue;

  const careerSec = career?.timeAliveSec;
  const cs2Sec = cs2?.timeAliveSec;
  rows.push({
    ...player,
    careerSec,
    careerRaw: career?.timeAliveRaw,
    cs2Sec,
    cs2Raw: cs2?.timeAliveRaw,
    delta:
      typeof careerSec === 'number' && typeof cs2Sec === 'number' ? cs2Sec - careerSec : undefined,
    dpr: cs2?.dpr ?? career?.dpr,
    entrying: cs2?.entrying ?? career?.entrying,
  });
}

if (missingCareer) console.log(`note: ${missingCareer} players have no career cache — run: node index.js`);
if (missingCs2) console.log(`note: ${missingCs2} players have no CS2 cache — run: node index.js --cs2`);
if (!rows.length) {
  console.log('\nNothing cached yet. Run index.js (and index.js --cs2) first.');
  process.exit(0);
}

// Rank by CS2 where available, else career.
const sortKey = (r) => (typeof r.cs2Sec === 'number' ? r.cs2Sec : r.careerSec ?? -Infinity);
rows.sort((a, b) => sortKey(b) - sortKey(a));

const widths = [3, 11, 15, 10, 10, 7, 6, 8];
const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join(' ');

console.log('\n=== TIME ALIVE PER ROUND: CS2 vs CAREER ===\n');
console.log(line(['#', 'player', 'team', 'cs2', 'career', 'delta', 'dpr', 'entrying']));
console.log(widths.map((w) => '-'.repeat(w)).join(' '));
rows.forEach((r, i) => {
  console.log(
    line([
      i + 1,
      r.name,
      r.team,
      r.cs2Raw || 'N/A',
      r.careerRaw || 'N/A',
      signed(r.delta),
      fmt(r.dpr, 2),
      typeof r.entrying === 'number' ? r.entrying : 'N/A',
    ])
  );
});

for (const [label, key, raw] of [
  ['CS2', 'cs2Sec', 'cs2Raw'],
  ['Career', 'careerSec', 'careerRaw'],
]) {
  const ranked = rows.filter((r) => typeof r[key] === 'number').sort((a, b) => b[key] - a[key]);
  if (!ranked.length) continue;
  const max = ranked[0];
  const min = ranked[ranked.length - 1];
  console.log(
    `\n${label}  MAX: ${max.name} (${max.team}) ${max[raw]} = ${fmt(max[key])}s` +
      `   MIN: ${min.name} (${min.team}) ${min[raw]} = ${fmt(min[key])}s` +
      `   spread ${fmt(max[key] - min[key])}s`
  );
}

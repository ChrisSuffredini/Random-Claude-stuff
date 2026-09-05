// CT vs T breakdown of time alive per round. Entirely offline: every
// cached page already carries all three side variants (combined, plus
// hidden ct and t), so this costs no requests.
//
//   node sides.js            CS2 scope if cached, else career
//   node sides.js --career   force the career scope
const fs = require('fs');
const path = require('path');
const { flattenRoster } = require('./roster');
const { parsePlayerPage } = require('./parse');

const CACHE_DIR = path.join(__dirname, 'cache');
const FORCE_CAREER = process.argv.includes('--career');

function readCached(id, cs2) {
  const file = path.join(CACHE_DIR, `${id}${cs2 ? '-cs2' : ''}.html`);
  if (!fs.existsSync(file)) return undefined;
  try {
    return parsePlayerPage(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
function stdev(xs) {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}
function correlate(pairs) {
  const u = pairs.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
  if (u.length < 3) return NaN;
  const xs = u.map((p) => p[0]);
  const ys = u.map((p) => p[1]);
  const mx = mean(xs);
  const my = mean(ys);
  let n = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < u.length; i++) {
    n += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  return dx === 0 || dy === 0 ? NaN : n / Math.sqrt(dx * dy);
}
const signed = (n) => (Number.isFinite(n) ? `${n > 0 ? '+' : ''}${n.toFixed(1)}` : 'N/A');

const roster = flattenRoster();
const useCs2 = !FORCE_CAREER && roster.some((p) => readCached(p.id, true));
const scope = useCs2 ? 'CS2 ONLY' : 'CAREER (incl. CS:GO)';

const rows = roster
  .map((p) => ({ ...p, ...(readCached(p.id, useCs2) || {}) }))
  .filter((r) => Number.isFinite(r.timeAliveCtSec) && Number.isFinite(r.timeAliveTSec))
  // T minus CT: positive means they survive longer on T than on CT.
  .map((r) => ({ ...r, sideDelta: r.timeAliveTSec - r.timeAliveCtSec }));

if (!rows.length) {
  console.log('No cached pages with per-side rows found. Run index.js first.');
  process.exit(0);
}

const ct = rows.map((r) => r.timeAliveCtSec);
const t = rows.map((r) => r.timeAliveTSec);

console.log(`\n=== TIME ALIVE BY SIDE — ${scope} (n=${rows.length}) ===\n`);
console.log(`  CT : mean ${mean(ct).toFixed(1)}s  sd ${stdev(ct).toFixed(2)}s  range ${Math.min(...ct)}–${Math.max(...ct)}s  spread ${Math.max(...ct) - Math.min(...ct)}s`);
console.log(`  T  : mean ${mean(t).toFixed(1)}s  sd ${stdev(t).toFixed(2)}s  range ${Math.min(...t)}–${Math.max(...t)}s  spread ${Math.max(...t) - Math.min(...t)}s`);
console.log(`  overall T-CT gap: ${signed(mean(t) - mean(ct))}s`);
// If this is high, the sides rank players the same way and the split adds
// little; if low, who survives depends on which side they are playing.
console.log(`  CT vs T across players: r=${correlate(rows.map((r) => [r.timeAliveCtSec, r.timeAliveTSec])).toFixed(2)}`);

const widths = [3, 11, 15, 8, 8, 8];
const line = (c) => c.map((x, i) => String(x).padEnd(widths[i])).join(' ');
const sorted = [...rows].sort((a, b) => b.sideDelta - a.sideDelta);

console.log('\n  sorted by T-minus-CT (most T-sided first):\n');
console.log('  ' + line(['#', 'player', 'team', 'ct', 't', 'T-CT']));
console.log('  ' + widths.map((w) => '-'.repeat(w)).join(' '));
sorted.forEach((r, i) =>
  console.log('  ' + line([i + 1, r.name, r.team, r.timeAliveCtRaw, r.timeAliveTRaw, signed(r.sideDelta)]))
);

const most = sorted[0];
const least = sorted[sorted.length - 1];
console.log(`\n  most T-sided : ${most.name} (${most.team}) ${signed(most.sideDelta)}s`);
console.log(`  most CT-sided: ${least.name} (${least.team}) ${signed(least.sideDelta)}s`);

const byTeam = new Map();
rows.forEach((r) => {
  const cur = byTeam.get(r.team) || { ct: [], t: [] };
  cur.ct.push(r.timeAliveCtSec);
  cur.t.push(r.timeAliveTSec);
  byTeam.set(r.team, cur);
});
console.log('\n  team averages (sorted by T-CT gap):');
[...byTeam.entries()]
  .map(([team, v]) => ({ team, ct: mean(v.ct), t: mean(v.t), gap: mean(v.t) - mean(v.ct) }))
  .sort((a, b) => b.gap - a.gap)
  .forEach((x) =>
    console.log(`    ${x.team.padEnd(14)} CT ${x.ct.toFixed(1)}s   T ${x.t.toFixed(1)}s   gap ${signed(x.gap)}s`)
  );

// Attribute scores are published per side too, so the role read can be
// checked separately for each.
for (const attr of ['entrying', 'clutching']) {
  const pairs = rows
    .map((r) => ({
      ctScore: r.attributesBySide?.ct?.[attr],
      tScore: r.attributesBySide?.t?.[attr],
      ctSec: r.timeAliveCtSec,
      tSec: r.timeAliveTSec,
    }))
    .filter((p) => Number.isFinite(p.ctScore) || Number.isFinite(p.tScore));
  if (!pairs.length) continue;
  const rCt = correlate(pairs.map((p) => [p.ctScore, p.ctSec]));
  const rT = correlate(pairs.map((p) => [p.tScore, p.tSec]));
  console.log(`\n  ${attr}: CT r=${Number.isFinite(rCt) ? rCt.toFixed(2) : 'n/a'}  |  T r=${Number.isFinite(rT) ? rT.toFixed(2) : 'n/a'}`);
}

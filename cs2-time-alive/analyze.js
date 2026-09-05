// Offline analysis of the cached pages: distribution stats per scope, and
// whether time alive per round tracks the Entrying attribute (the "is this
// role or era?" question). Reads cache/ only — no requests.
//
//   node analyze.js
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

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

function stdev(xs) {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Pearson correlation, with the pairs where either side is missing dropped.
function correlate(pairs) {
  const usable = pairs.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
  if (usable.length < 3) return { r: NaN, n: usable.length };
  const xs = usable.map((p) => p[0]);
  const ys = usable.map((p) => p[1]);
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < usable.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  return { r: num / Math.sqrt(dx * dy), n: usable.length };
}

function describeR(r) {
  if (!Number.isFinite(r)) return 'not enough data';
  const a = Math.abs(r);
  const strength = a >= 0.7 ? 'strong' : a >= 0.4 ? 'moderate' : a >= 0.2 ? 'weak' : 'negligible';
  return `${strength} ${r < 0 ? 'negative' : 'positive'}`;
}

const roster = flattenRoster();
const scopes = [
  ['CAREER (incl. CS:GO)', false],
  ['CS2 ONLY', true],
];

for (const [label, cs2] of scopes) {
  const rows = roster
    .map((p) => ({ ...p, ...(readCached(p.id, cs2) || {}) }))
    .filter((r) => Number.isFinite(r.timeAliveSec));

  console.log(`\n=== ${label} ===`);
  if (rows.length < 2) {
    console.log(`  only ${rows.length} cached player(s) — run: node index.js${cs2 ? ' --cs2' : ''}`);
    continue;
  }

  const secs = rows.map((r) => r.timeAliveSec);
  console.log(
    `  n=${rows.length}  mean=${mean(secs).toFixed(1)}s  median=${median(secs).toFixed(1)}s  ` +
    `sd=${stdev(secs).toFixed(2)}s  range=${Math.min(...secs).toFixed(1)}–${Math.max(...secs).toFixed(1)}s  ` +
    `spread=${(Math.max(...secs) - Math.min(...secs)).toFixed(1)}s`
  );

  // The role hypothesis: entry players die early, so more Entrying should
  // mean less time alive.
  const vsEntrying = correlate(rows.map((r) => [r.entrying, r.timeAliveSec]));
  const vsDpr = correlate(rows.map((r) => [r.dpr, r.timeAliveSec]));
  console.log(`  time alive vs entrying : r=${vsEntrying.r.toFixed(2)} (n=${vsEntrying.n}) — ${describeR(vsEntrying.r)}`);
  console.log(`  time alive vs dpr      : r=${vsDpr.r.toFixed(2)} (n=${vsDpr.n}) — ${describeR(vsDpr.r)}`);

  const sorted = [...rows].sort((a, b) => a.timeAliveSec - b.timeAliveSec);
  const line = (r) =>
    `${r.name.padEnd(11)} ${r.team.padEnd(14)} ${String(r.timeAliveRaw).padStart(7)}  ` +
    `entrying=${r.entrying ?? 'N/A'}`.padEnd(14) + `dpr=${r.dpr ?? 'N/A'}`;
  console.log('  shortest-lived:');
  sorted.slice(0, 5).forEach((r) => console.log(`    ${line(r)}`));
  console.log('  longest-lived:');
  sorted.slice(-5).reverse().forEach((r) => console.log(`    ${line(r)}`));

  const byTeam = new Map();
  rows.forEach((r) => byTeam.set(r.team, [...(byTeam.get(r.team) || []), r.timeAliveSec]));
  const teams = [...byTeam.entries()]
    .map(([team, v]) => ({ team, avg: mean(v), n: v.length }))
    .sort((a, b) => b.avg - a.avg);
  console.log('  team averages:');
  teams.forEach((t) => console.log(`    ${t.team.padEnd(14)} ${t.avg.toFixed(1)}s  (${t.n} players)`));
}

// Era vs role. Time alive is largely death rate restated in seconds, so a
// player only tells us something extra by sitting off that trend. Fit the
// trend on players with little CS:GO history (career ≈ CS2), then measure
// how far everyone else falls below it — and whether that gap tracks how
// much CS:GO history they carry (era) or is specific to them (role).
const paired = roster
  .map((p) => ({ p, career: readCached(p.id, false), cs2: readCached(p.id, true) }))
  .filter((r) => Number.isFinite(r.career?.timeAliveSec) && Number.isFinite(r.cs2?.timeAliveSec) && Number.isFinite(r.career?.dpr))
  .map((r) => ({
    name: r.p.name,
    team: r.p.team,
    careerSec: r.career.timeAliveSec,
    careerDpr: r.career.dpr,
    delta: r.cs2.timeAliveSec - r.career.timeAliveSec,
  }));

if (paired.length >= 10) {
  const natives = paired.filter((r) => r.delta <= 1);
  if (natives.length >= 5) {
    // least squares of careerSec on careerDpr, fitted on CS2-native players
    const xs = natives.map((r) => r.careerDpr);
    const ys = natives.map((r) => r.careerSec);
    const mx = mean(xs);
    const my = mean(ys);
    let num = 0;
    let den = 0;
    for (let i = 0; i < natives.length; i++) {
      num += (xs[i] - mx) * (ys[i] - my);
      den += (xs[i] - mx) ** 2;
    }
    const slope = num / den;
    const intercept = my - slope * mx;

    const withResid = paired.map((r) => ({ ...r, resid: r.careerSec - (intercept + slope * r.careerDpr) }));
    const vets = withResid.filter((r) => r.delta >= 5).sort((a, b) => a.resid - b.resid);
    const rest = withResid.filter((r) => r.delta < 5);

    console.log('\n=== era vs role (career residual against the death-rate trend) ===');
    console.log(`  trend fitted on ${natives.length} CS2-native players: seconds = ${intercept.toFixed(1)} ${slope.toFixed(1)}*dpr`);
    const dr = correlate(withResid.map((r) => [r.delta, r.resid]));
    console.log(`  CS:GO history (delta) vs residual: r=${dr.r.toFixed(2)} (n=${dr.n}) — ${describeR(dr.r)}`);
    console.log(`  mean residual — veterans (delta>=5): ${vets.length ? mean(vets.map((v) => v.resid)).toFixed(1) : 'n/a'}s` +
      `  |  everyone else: ${rest.length ? mean(rest.map((v) => v.resid)).toFixed(1) : 'n/a'}s`);
    if (vets.length) {
      console.log('  furthest below trend (role signature beyond the era effect):');
      vets.slice(0, 8).forEach((v) =>
        console.log(`    ${v.name.padEnd(11)} ${v.team.padEnd(14)} delta=+${String(v.delta).padStart(2)}s  residual=${v.resid.toFixed(1)}s`)
      );
    }
  }
}

// Integrity check: if HLTV's attribute rows ignored the csVersion filter,
// both scopes would return identical values and the comparison would be
// meaningless. Worth knowing before drawing conclusions from the delta.
const both = roster
  .map((p) => ({ career: readCached(p.id, false), cs2: readCached(p.id, true) }))
  .filter((r) => Number.isFinite(r.career?.timeAliveSec) && Number.isFinite(r.cs2?.timeAliveSec));

if (both.length) {
  const identical = both.filter((r) => r.career.timeAliveSec === r.cs2.timeAliveSec).length;
  console.log(`\n=== scope check ===`);
  console.log(`  ${identical}/${both.length} players have identical career and CS2 values`);
  if (identical === both.length) {
    console.log('  WARNING: every value matches — the csVersion filter is NOT affecting this stat,');
    console.log('  so the two runs are measuring the same thing and the delta means nothing.');
  } else if (identical > both.length / 2) {
    console.log('  NOTE: most values match — treat the career/CS2 delta with suspicion.');
  } else {
    console.log('  OK: the filter is clearly changing the numbers.');
  }
}

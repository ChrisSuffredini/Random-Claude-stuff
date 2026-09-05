// Packages everything parsed from cache/ into one small results.json,
// so it can be committed and pushed instead of pasting terminal output.
// Offline — reads cache/, writes nothing to the network.
//
//   node export.js
//   git add results.json && git commit -m "update results" && git push
//
// analyze.js / sides.js / compare.js (via data.js) read results.json
// automatically when present, so whoever pulls it can rerun the same
// analysis without needing cache/ or a browser at all.
const fs = require('fs');
const path = require('path');
const { flattenRoster } = require('./roster');
const { parsePlayerPage } = require('./parse');
const { RESULTS_FILE } = require('./data');

const CACHE_DIR = path.join(__dirname, 'cache');

function readCacheFile(id, cs2) {
  const file = path.join(CACHE_DIR, `${id}${cs2 ? '-cs2' : ''}.html`);
  if (!fs.existsSync(file)) return undefined;
  try {
    const parsed = parsePlayerPage(fs.readFileSync(file, 'utf8'));
    // Drop fields that just duplicate roleStatsBySide.combined /
    // attributesBySide.combined, to keep the committed file lean.
    const { roleStats, attributes, bySide, ...slim } = parsed;
    return slim;
  } catch (err) {
    console.log(`  warn: cache/${id}${cs2 ? '-cs2' : ''}.html failed to parse: ${err.message}`);
    return undefined;
  }
}

const roster = flattenRoster();
const players = {};
let careerCount = 0;
let cs2Count = 0;

for (const p of roster) {
  const career = readCacheFile(p.id, false);
  const cs2 = readCacheFile(p.id, true);
  if (!career && !cs2) continue;
  if (career) careerCount++;
  if (cs2) cs2Count++;
  players[p.id] = { name: p.name, team: p.team, teamRank: p.teamRank, career, cs2 };
}

const out = {
  generatedAt: new Date().toISOString(),
  rosterSize: roster.length,
  players,
};

fs.writeFileSync(RESULTS_FILE, JSON.stringify(out, null, 2));
const bytes = fs.statSync(RESULTS_FILE).size;

console.log(`Wrote ${RESULTS_FILE}`);
console.log(`  ${Object.keys(players).length}/${roster.length} players (${careerCount} career, ${cs2Count} cs2) — ${(bytes / 1024).toFixed(1)} KB`);
console.log('\nCommit and push it, and it can be pulled and analyzed without cache/ or a browser:');
console.log('  git add results.json');
console.log('  git commit -m "update HLTV results"');
console.log('  git push');

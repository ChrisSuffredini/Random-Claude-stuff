const { HLTV } = require('hltv');
const { sleep } = require('hltv/lib/utils');
const { flattenRoster } = require('./roster');
const { getClutchingStats } = require('./clutching');

const DELAY_MS = 750;

function fmtNum(n, digits = 2) {
  return typeof n === 'number' && !Number.isNaN(n) ? n.toFixed(digits) : 'N/A';
}

async function fetchOne(player) {
  // getPlayerStats() alone makes 3 requests (overview/individual/matches);
  // the clutching page is a 4th. Run them one after another (not in
  // parallel) and pace every player with a delay to stay polite to HLTV.
  const overview = await HLTV.getPlayerStats({ id: player.id });
  await sleep(DELAY_MS);
  const clutching = await getClutchingStats(player.id);

  return {
    name: player.name,
    team: player.team,
    id: player.id,
    timeAliveSec: clutching.timeAlivePerRound,
    dpr: overview.overviewStatistics?.deathsPerRound,
    entryRating: overview.individualStatistics?.openingKillRating,
    rawLabels: clutching.rawLabels,
  };
}

async function main() {
  const roster = flattenRoster();
  const results = [];
  const failures = [];
  let firstSuccessLogged = false;

  for (const player of roster) {
    try {
      const row = await fetchOne(player);

      if (!firstSuccessLogged) {
        // One-time sanity dump so a human can confirm the "time alive per
        // round" label/selector actually matched something sane before
        // trusting the rest of the run.
        console.log(`\n[debug] Clutching-page stat rows for ${player.name} (id ${player.id}):`);
        row.rawLabels.forEach((l) => console.log(`  - ${l}`));
        console.log(
          row.timeAliveSec !== undefined
            ? `[debug] Parsed time_alive_per_round = ${row.timeAliveSec}s\n`
            : `[debug] WARNING: could not find/parse "time alive per round" on this page — check labels above and update clutching.js\n`
        );
        firstSuccessLogged = true;
      }

      results.push(row);
      console.log(`OK   ${player.team.padEnd(16)} ${player.name}`);
    } catch (err) {
      failures.push({ player, error: err.message });
      console.log(`FAIL ${player.team.padEnd(16)} ${player.name} — ${err.message}`);
    }
    await sleep(DELAY_MS);
  }

  const withTimeAlive = results.filter((r) => typeof r.timeAliveSec === 'number');
  const withoutTimeAlive = results.filter((r) => typeof r.timeAliveSec !== 'number');
  withTimeAlive.sort((a, b) => b.timeAliveSec - a.timeAliveSec);

  console.log('\n=== Time Alive Per Round — CS2 Top-10 Teams ===\n');
  const header = ['player', 'team', 'time_alive_per_round_s', 'dpr', 'entry_rating'];
  console.log(header.join('\t'));
  for (const r of withTimeAlive) {
    console.log([r.name, r.team, fmtNum(r.timeAliveSec, 1), fmtNum(r.dpr), fmtNum(r.entryRating)].join('\t'));
  }
  if (withoutTimeAlive.length) {
    console.log('\n(no time_alive_per_round parsed — shown with N/A, excluded from ranking/max/min)');
    for (const r of withoutTimeAlive) {
      console.log([r.name, r.team, 'N/A', fmtNum(r.dpr), fmtNum(r.entryRating)].join('\t'));
    }
  }

  if (withTimeAlive.length) {
    const max = withTimeAlive[0];
    const min = withTimeAlive[withTimeAlive.length - 1];
    console.log(`\nMax time alive per round: ${max.name} (${max.team}) — ${fmtNum(max.timeAliveSec, 1)}s`);
    console.log(`Min time alive per round: ${min.name} (${min.team}) — ${fmtNum(min.timeAliveSec, 1)}s`);
  } else {
    console.log('\nNo player yielded a parsable time_alive_per_round value — nothing to rank.');
  }

  console.log(`\nFetched ${results.length}/${roster.length} players successfully (${failures.length} failed).`);
  if (failures.length) {
    console.log('Failures:');
    failures.forEach((f) => console.log(`  - ${f.player.team} ${f.player.name} (id ${f.player.id}): ${f.error}`));
  }
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});

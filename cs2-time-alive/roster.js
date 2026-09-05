// Top-10 HLTV team ranking snapshot (source: HLTV world ranking, 2026-08-10).
// NOTE: could not be re-verified against the live ranking page in this
// environment — see README.md "Network limitation" section.
const ROSTER = [
  { team: 'Falcons', rank: 1, players: [
    { name: 'karrigan', id: 429 },
    { name: 'NiKo', id: 3741 },
    { name: 'TeSeS', id: 12018 },
    { name: 'm0NESY', id: 19230 },
    { name: 'kyousuke', id: 24177 },
  ] },
  { team: 'Spirit', rank: 2, players: [
    { name: 'sh1ro', id: 16920 },
    { name: 'magixx', id: 18317 },
    { name: 'tN1R', id: 19808 },
    { name: 'zont1x', id: 20423 },
    { name: 'donk', id: 21167 },
  ] },
  { team: 'FURIA', rank: 3, players: [
    { name: 'FalleN', id: 2023 },
    { name: 'yuurih', id: 12553 },
    { name: 'YEKINDAR', id: 13915 },
    { name: 'KSCERATO', id: 15631 },
    { name: 'molodoy', id: 24144 },
  ] },
  { team: 'Vitality', rank: 4, players: [
    { name: 'apEX', id: 7322 },
    { name: 'ropz', id: 11816 },
    { name: 'ZywOo', id: 11893 },
    { name: 'flameZ', id: 16693 },
    { name: 'mezii', id: 18462 },
  ] },
  { team: 'MOUZ', rank: 5, players: [
    { name: 'torzsi', id: 18072 },
    { name: 'Spinx', id: 18221 },
    { name: 'xertioN', id: 20312 },
    { name: 'PR', id: 22279 },
    { name: 'xelex', id: 24457 },
  ] },
  { team: 'Natus Vincere', rank: 6, players: [
    { name: 'Aleksib', id: 9816 },
    { name: 'iM', id: 14759 },
    { name: 'b1t', id: 18987 },
    { name: 'w0nderful', id: 20127 },
    { name: 'makazze', id: 22673 },
  ] },
  { team: '9z', rank: 7, players: [
    { name: 'max', id: 12092 },
    { name: 'dgt', id: 14736 },
    { name: 'meyern', id: 14737 },
    { name: 'luchov', id: 20394 },
    { name: 'HUASOPEEK', id: 22613 },
  ] },
  { team: 'Aurora', rank: 8, players: [
    { name: 'XANTARES', id: 7938 },
    { name: 'woxic', id: 8574 },
    { name: 'Jimpphat', id: 18850 },
    { name: 'kyxsan', id: 19677 },
    { name: 'Wicadia', id: 21243 },
  ] },
  { team: 'FaZe', rank: 9, players: [
    { name: 'frozen', id: 9960 },
    { name: 'Twistzz', id: 10394 },
    { name: 'Neityu', id: 21972 },
    { name: 'jcobbb', id: 22383 },
    { name: 'JBOEN', id: 22866 },
  ] },
  { team: 'G2', rank: 10, players: [
    { name: 'huNter-', id: 3972 },
    { name: 'NertZ', id: 9436 },
    { name: 'r1nkle', id: 20425 },
    { name: 'HeavyGod', id: 20447 },
    { name: 'MATYS', id: 21062 },
  ] },
];

function flattenRoster() {
  const rows = [];
  for (const { team, rank, players } of ROSTER) {
    for (const p of players) {
      rows.push({ team, teamRank: rank, name: p.name, id: p.id });
    }
  }
  return rows;
}

module.exports = { ROSTER, flattenRoster };

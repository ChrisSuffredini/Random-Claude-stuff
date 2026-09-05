// Parsing tests against markup copied verbatim from ZywOo's live HLTV
// stats page (captured via inspect-attr.js). Run: node test-parse.js
const assert = require('assert');
const { parsePlayerPage, parseDuration } = require('./parse');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

console.log('parseDuration:');
check('"1m 10s" -> 70', () => assert.strictEqual(parseDuration('1m 10s'), 70));
check('"1m 9s" -> 69', () => assert.strictEqual(parseDuration('1m 9s'), 69));
check('"1m 11s" -> 71', () => assert.strictEqual(parseDuration('1m 11s'), 71));
check('"58s" -> 58', () => assert.strictEqual(parseDuration('58s'), 58));
check('"2m" -> 120', () => assert.strictEqual(parseDuration('2m'), 120));
check('"1:10" -> 70', () => assert.strictEqual(parseDuration('1:10'), 70));
check('"70" -> 70', () => assert.strictEqual(parseDuration('70'), 70));
check('undefined -> undefined', () => assert.strictEqual(parseDuration(undefined), undefined));

// Real markup, including the irregular whitespace in the class attribute
// and the hidden per-side duplicates that must NOT be picked up.
const FIXTURE = `
<html><body>
  <div class="context-item-name">ZywOo</div>

  <div class="role-stats-row   stats-side-combined"><div class="role-stats-top">
    <div class="role-stats-title">Time alive per round</div>
    <div class="role-stats-data">1m 10s</div></div></div>
  <div class="role-stats-row  hidden stats-side-ct"><div class="role-stats-top">
    <div class="role-stats-title">Time alive per round</div>
    <div class="role-stats-data">1m 9s</div></div></div>
  <div class="role-stats-row  hidden stats-side-t"><div class="role-stats-top">
    <div class="role-stats-title">Time alive per round</div>
    <div class="role-stats-data">1m 11s</div></div></div>

  <div class="stats-row"><span>Deaths / round</span><span>0.60</span></div>
  <div class="stats-row"><span>Damage / Round</span><span>87.3</span></div>
  <div class="stats-row"><span>K/D Ratio</span><span>1.40</span></div>
  <div class="stats-row"><span>Maps played</span><span>1696</span></div>

  <div class="role-attribute"><div class="role-score">80/100</div><div class="role-name">Clutching</div>
    <div class="hidden"><div class="tooltip-box tooltip-attributes"><b>Clutching: </b>The late round players…</div></div></div>
  <div class="role-attribute"><div class="role-score">49/100</div><div class="role-name">Entrying</div>
    <div class="hidden"><div class="tooltip-box tooltip-attributes"><b>Entrying: </b>How likely a player is…</div></div></div>
</body></html>`;

console.log('\nparsePlayerPage (real markup fixture):');
const parsed = parsePlayerPage(FIXTURE);
check('picks combined side, not ct/t', () => assert.strictEqual(parsed.timeAliveRaw, '1m 10s'));
check('time alive -> 70 seconds', () => assert.strictEqual(parsed.timeAliveSec, 70));
check('dpr -> 0.60', () => assert.strictEqual(parsed.dpr, 0.6));
check('dmg/round -> 87.3', () => assert.strictEqual(parsed.dmgPerRound, 87.3));
check('kd -> 1.40', () => assert.strictEqual(parsed.kdRatio, 1.4));
check('entrying attribute -> 49', () => assert.strictEqual(parsed.entrying, 49));
check('clutching attribute -> 80', () => assert.strictEqual(parsed.clutching, 80));
check('ign -> ZywOo', () => assert.strictEqual(parsed.ign, 'ZywOo'));

// Adjacent elements concatenate with no separator, so "49/100Entrying" has
// no word boundary after "100" — this broke attribute matching once.
console.log('\nattributes with concatenated text (no whitespace/tooltip):');
const CONCAT = `<html><body>
  <div class="attr"><div>49/100</div><div>Entrying</div></div>
  <div class="attr"><div>80/100</div><div>Clutching</div></div>
</body></html>`;
const concat = parsePlayerPage(CONCAT);
check('entrying -> 49', () => assert.strictEqual(concat.entrying, 49));
check('clutching -> 80', () => assert.strictEqual(concat.clutching, 80));

console.log(failures === 0 ? '\nAll parsing tests passed.' : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);

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

// Time-alive and overview rows, verbatim from the live page — including the
// irregular whitespace in the class attribute and the hidden per-side
// duplicates that must NOT be picked up. (Attributes are covered below,
// against their own verified markup.)
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
</body></html>`;

console.log('\nparsePlayerPage (real markup fixture):');
const parsed = parsePlayerPage(FIXTURE);
check('picks combined side, not ct/t', () => assert.strictEqual(parsed.timeAliveRaw, '1m 10s'));
check('time alive -> 70 seconds', () => assert.strictEqual(parsed.timeAliveSec, 70));
check('dpr -> 0.60', () => assert.strictEqual(parsed.dpr, 0.6));
check('dmg/round -> 87.3', () => assert.strictEqual(parsed.dmgPerRound, 87.3));
check('kd -> 1.40', () => assert.strictEqual(parsed.kdRatio, 1.4));
check('ign -> ZywOo', () => assert.strictEqual(parsed.ign, 'ZywOo'));

// The ct/t rows are not noise to be filtered out — they are the per-side
// breakdown, and must be readable alongside the combined value.
console.log('\nper-side extraction (same fixture):');
check('ct -> 69s', () => assert.strictEqual(parsed.timeAliveCtSec, 69));
check('t -> 71s', () => assert.strictEqual(parsed.timeAliveTSec, 71));
check('ct raw preserved', () => assert.strictEqual(parsed.timeAliveCtRaw, '1m 9s'));
check('combined still 70s', () => assert.strictEqual(parsed.bySide.combined.seconds, 70));

// Real attribute markup captured from a cached page (inspect-cache.js):
// the score's number is a bare text node with "/100" in a child span, and
// the title carries the tooltip as a child. Each attribute repeats per
// side, with ct/t hidden — only the combined value should be taken.
console.log('\nattributes (verified markup, score nested in the section):');
const section = (name, score, sideClass) => `
  <div class="role-stats-section-title-wrapper ${sideClass}">
    <div class="role-stats-section-title">${name}
      <div class="hidden"><div class="tooltip-box tooltip-attributes"><b>${name}: </b>prose…</div></div>
    </div>
    <div class="row-stats-section-score">${score}<span class="row-stats-section-score-100">/100</span></div>
  </div>`;
const ATTRS = `<html><body>
  ${section('Entrying', 77, 'stats-side-combined')}
  ${section('Entrying', 81, 'stats-side-ct hidden')}
  ${section('Entrying', 61, 'stats-side-t hidden')}
  ${section('Clutching', 73, 'stats-side-combined')}
  ${section('Firepower', 68, 'stats-side-combined')}
</body></html>`;
const attrs = parsePlayerPage(ATTRS);
check('entrying -> 77 (combined, not ct/t)', () => assert.strictEqual(attrs.entrying, 77));
check('clutching -> 73', () => assert.strictEqual(attrs.clutching, 73));
check('firepower -> 68', () => assert.strictEqual(attrs.attributes.firepower, 68));
check('tooltip prose excluded from name', () => assert.ok(!Object.keys(attrs.attributes).some((k) => k.includes(':'))));
check('ct entrying -> 81', () => assert.strictEqual(attrs.attributesBySide.ct.entrying, 81));
check('t entrying -> 61', () => assert.strictEqual(attrs.attributesBySide.t.entrying, 61));

// Same data, but with the score as a SIBLING of the title wrapper rather
// than inside it — the real nesting was not fully confirmed, so both must work.
console.log('\nattributes (score as sibling of the title):');
const sibling = `<html><body>
  <div class="role-stats-section">
    <div class="role-stats-section-title-wrapper stats-side-combined">
      <div class="role-stats-section-title">Entrying<div class="hidden">tip</div></div>
    </div>
    <div class="row-stats-section-score">49<span class="row-stats-section-score-100">/100</span></div>
  </div>
  <div class="role-stats-section">
    <div class="role-stats-section-title-wrapper stats-side-combined">
      <div class="role-stats-section-title">Clutching<div class="hidden">tip</div></div>
    </div>
    <div class="row-stats-section-score">88<span class="row-stats-section-score-100">/100</span></div>
  </div>
</body></html>`;
const sib = parsePlayerPage(sibling);
check('entrying -> 49', () => assert.strictEqual(sib.entrying, 49));
check('clutching -> 88', () => assert.strictEqual(sib.clutching, 88));

// Ambiguity guard: one container holding several titles must yield nothing
// rather than pairing a score with the wrong attribute.
console.log('\nambiguous nesting is reported as missing, not guessed:');
const ambiguous = `<html><body><div class="blob">
  <div class="role-stats-section-title">Entrying</div>
  <div class="role-stats-section-title">Clutching</div>
  <div class="row-stats-section-score">50<span class="row-stats-section-score-100">/100</span></div>
</div></body></html>`;
const amb = parsePlayerPage(ambiguous);
check('no attribute guessed', () => assert.strictEqual(Object.keys(amb.attributes).length, 0));

console.log(failures === 0 ? '\nAll parsing tests passed.' : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);

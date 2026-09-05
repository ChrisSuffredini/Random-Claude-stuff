// Shared data access for analyze.js / sides.js / compare.js: prefers
// results.json (small, committable — see export.js) when present, falling
// back to re-parsing cache/<id>.html directly. Either way callers get the
// same shape back from parsePlayerPage.
const fs = require('fs');
const path = require('path');
const { parsePlayerPage } = require('./parse');

const CACHE_DIR = path.join(__dirname, 'cache');
const RESULTS_FILE = path.join(__dirname, 'results.json');

let resultsCache; // undefined = not loaded yet, null = no file present

function loadResults() {
  if (resultsCache !== undefined) return resultsCache;
  if (!fs.existsSync(RESULTS_FILE)) {
    resultsCache = null;
    return resultsCache;
  }
  try {
    const data = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
    resultsCache = data.players || {};
  } catch (err) {
    console.log(`[data] results.json unreadable (${err.message}) — falling back to cache/`);
    resultsCache = null;
  }
  return resultsCache;
}

function source() {
  return loadResults() ? 'results.json' : 'cache/';
}

function readCached(id, cs2) {
  const results = loadResults();
  if (results) {
    const entry = results[String(id)];
    const scoped = entry?.[cs2 ? 'cs2' : 'career'];
    return scoped || undefined;
  }

  const file = path.join(CACHE_DIR, `${id}${cs2 ? '-cs2' : ''}.html`);
  if (!fs.existsSync(file)) return undefined;
  try {
    return parsePlayerPage(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

module.exports = { readCached, source, RESULTS_FILE };

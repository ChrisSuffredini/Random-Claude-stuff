# CS2 Time Alive Per Round Comparison

Compares "time alive per round" across the 50 players on HLTV's current
top-10 CS2 teams, using the [`hltv`](https://github.com/gigobyte/HLTV)
npm package.

## ⚠️ Cloudflare blocking / browser-backed requests

HLTV's Cloudflare protection now rejects the `hltv` package's default
plain-HTTP requests outright (`Access denied | www.hltv.org used
Cloudflare to restrict access`) — confirmed on the very first request, so
it isn't a rate-limiting issue. This is a known, current limitation of
the package (see [gigobyte/HLTV#43](https://github.com/gigobyte/HLTV/issues/43)
and other scrapers having moved to real/stealth-browser rendering for
HLTV specifically).

**Fix applied:** `browser.js` replaces the package's `loadPage` with a
real Chromium tab (via `puppeteer-extra` + the stealth plugin, reused
across the whole run so a solved Cloudflare session carries over between
requests). `index.js` and `probe.js` both use it automatically — no
extra setup beyond `npm install`.

- The browser window opens **visibly** by default. If HLTV shows a
  Cloudflare checkbox/challenge, solve it by hand in that window once —
  the console will print `[waiting] Cloudflare check is on screen...` if
  it's stuck on one. Subsequent requests reuse the same tab/session.
- Once you've confirmed it passes reliably, you can run headless with
  `HLTV_HEADLESS=true node index.js` (no visible window, but no way to
  manually solve a challenge if one appears).
- If Chromium fails to launch with a missing-library error, install a
  system Chromium (`sudo pacman -S chromium`) and see
  [puppeteer's troubleshooting docs](https://pptr.dev/troubleshooting)
  for pointing it at that binary via `executablePath`.

This was built and syntax-checked in a sandboxed cloud environment whose
network egress proxy blocks `www.hltv.org` entirely, so:

- **It has not been run end-to-end against live HLTV data.** The
  request/error-handling loop (including the browser-backed loader) was
  verified to run cleanly through all 50 players — including opening and
  closing a real headless Chromium instance — and produce a correct
  summary/failure report when every navigation is blocked by the sandbox
  (which is what happens here).
- **The "time alive per round" field's exact page markup is unverified.**
  `HLTV.getPlayerStats({ id })` (the package's documented endpoint) only
  scrapes the Overview, Individual, and Matches pages — confirmed by
  reading `node_modules/hltv/lib/endpoints/getPlayerStats.js`. It does
  **not** include "time alive per round"; that stat lives on a separate,
  undocumented endpoint the package doesn't wrap:
  `https://www.hltv.org/stats/players/clutching/{id}`. `clutching.js`
  scrapes that page directly.
- Because that page couldn't be fetched from here, the label-matching in
  `clutching.js` (`TIME_ALIVE_LABEL_PATTERNS`) is a best-effort guess at
  HLTV's actual wording, not confirmed against the live HTML.
- The top-10 ranking in `roster.js` also could not be re-confirmed
  against the live ranking page for the same reason — it's taken as
  given from the task's 2026-08-10 snapshot.

**Before trusting a real run**, run the probe first:

```bash
npm install
node probe.js         # dumps every stat-row label on ZywOo's clutching
                       # page — confirm the exact "time alive" label text
```

`index.js` also does this automatically for the first player it
successfully fetches — it prints every row label from that player's
clutching page plus whatever value it parsed for time-alive-per-round, so
you can sanity-check the very first real run before trusting the rest.
If the label patterns in `clutching.js` don't match what you see, add the
real label to `TIME_ALIVE_LABEL_PATTERNS` — no other code needs to
change. Also confirm the current top-10 lineup against
https://www.hltv.org/ranking/teams before running, since rosters and
rankings both drift.

## Usage

```bash
npm install
node index.js
```

A Chromium window will open — leave it alone (or solve a Cloudflare
challenge in it if one appears) while the script works through all 50
players sequentially (with a ~750ms pause between every request — each
player needs 4 page loads: 3 from `getPlayerStats` + 1 from the
clutching page). It prints:

- a per-player `OK`/`FAIL` log line as it goes,
- a one-time debug dump of the first successfully-fetched player's
  clutching-page stat labels (see above),
- a final table (`player`, `team`, `time_alive_per_round_s`, `dpr`,
  `entry_rating`) sorted descending by time alive per round,
- explicit max/min call-outs,
- a fetch-success count and a list of any per-player failures (a failed
  player is logged and skipped, not fatal to the run).

`dpr` = deaths per round (`overviewStatistics.deathsPerRound`).
`entry_rating` = HLTV's opening-kill rating
(`individualStatistics.openingKillRating`), used as the closest available
stand-in for "entrying score" since the package doesn't expose a stat
literally named that.

## Files

- `roster.js` — the 10 teams / 50 players and their HLTV player IDs.
- `browser.js` — real-browser-backed `loadPage` replacement, to get past
  HLTV's Cloudflare protection.
- `clutching.js` — scrapes `/stats/players/clutching/{id}` for time alive
  per round (not covered by the `hltv` package's own endpoints).
- `index.js` — fetches everything, merges, sorts, prints the report.
- `probe.js` — standalone diagnostic: dumps raw clutching-page stat rows
  for one player ID (`node probe.js <id>`, defaults to ZywOo), for
  verifying label wording.

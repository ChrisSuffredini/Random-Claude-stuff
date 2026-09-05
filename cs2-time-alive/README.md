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

A Puppeteer-**launched** browser doesn't solve this either: Cloudflare
flags the automated browser itself and re-issues the challenge forever,
so clicking the checkbox by hand in that window does nothing (observed
in practice — ~10 manual clicks, challenge never cleared).

**Fix applied — attach mode.** `browser.js` connects to a normal
Chrome/Chromium **you** start and solve the Cloudflare check in with
your own mouse, then drives navigation inside that already-trusted
session. Nothing about the browser looks automated, and the
`cf_clearance` cookie earned by your real click carries into every
subsequent fetch.

```bash
# 1. Start a browser with remote debugging on a throwaway profile
#    (leaves your normal browsing untouched). Use google-chrome-stable
#    instead of chromium if that's what you have.
chromium --remote-debugging-port=9222 --user-data-dir=/tmp/hltv-profile &

# 2. In THAT window, visit https://www.hltv.org and clear any
#    "verify you are human" check yourself, until the real site loads.

# 3. Leave it open, and point the script at it:
HLTV_CDP_URL=http://127.0.0.1:9222 node probe.js
HLTV_CDP_URL=http://127.0.0.1:9222 node index.js
```

The script never closes that window (it disconnects rather than
quitting), so you can re-run against the same solved session. If HLTV
re-challenges mid-run, the console prints `[waiting] Cloudflare check is
on screen...` — solve it in the window and the run continues.

Without `HLTV_CDP_URL`, `browser.js` falls back to launching its own
browser (visible by default, `HLTV_HEADLESS=true` for headless). That
path only works where Cloudflare isn't actively challenging.

If Chromium isn't installed: `sudo pacman -S chromium` (Arch), and see
[puppeteer's troubleshooting docs](https://pptr.dev/troubleshooting) for
launch problems in the fallback path.

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

**Before trusting a real run**, run the probe first (with attach mode set
up as above):

```bash
npm install
HLTV_CDP_URL=http://127.0.0.1:9222 node probe.js
# dumps every stat-row label on ZywOo's clutching page — confirm the
# exact "time alive" label text
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
HLTV_CDP_URL=http://127.0.0.1:9222 node index.js
```

Leave the browser window from step 1 open (and solve a Cloudflare
challenge in it if one reappears) while the script works through all 50
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

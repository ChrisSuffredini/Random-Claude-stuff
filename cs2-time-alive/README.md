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

## Where the data actually comes from

Found by inspecting the live site (`discover.js`, `inspect-attr.js`):
**everything needed is on the player's stats-overview page**,
`https://www.hltv.org/stats/players/{id}/{slug}` — so this makes **one
request per player**, not four.

- **Time alive per round** is *not* a `.stats-row` and *not* on any
  `/clutching/` URL (that path 404s). It lives in HLTV's attributes
  ("role") section:

  ```html
  <div class="role-stats-row   stats-side-combined">
    <div class="role-stats-top">
      <div class="role-stats-title">Time alive per round</div>
      <div class="role-stats-data">1m 10s</div>
    </div>
  </div>
  ```

  The row repeats as `stats-side-ct` / `stats-side-t` (hidden); we read
  `stats-side-combined` for both sides. Values are formatted `"1m 10s"`,
  not decimals, so `parse.js` converts to seconds (70).
- **DPR** comes from the overview `.stats-row` "Deaths / round".
- **Entrying** is HLTV's attribute score out of 100 (e.g. ZywOo
  `Entrying 49/100`), matched structurally by finding an `NN/100` value
  next to the attribute's name.

`parse.js` is pure (HTML in, values out) and covered by `test-parse.js`
using markup copied verbatim from the live page — run `node test-parse.js`
to check parsing without touching the network.

### Caveats

- **Scope**: with no filters the page covers a player's whole career,
  which for veterans **includes CS:GO**, not just CS2. Pass `--cs2` to
  restrict to CS2 (`?csVersion=CS2`).
- Attribute scores may be absent for players with too few recent maps;
  those show `N/A` rather than failing the run.
- **Roster**: `node fetch-roster.js [topN]` captures the live ranking and
  each team's current five into `roster.json`, which everything else picks
  up automatically. Without it, the built-in 2026-08-10 top-10 snapshot in
  `roster.js` is used, which will drift as lineups change. Going past the
  top 10 also gives the analysis a bigger sample.

## Usage

```bash
npm install
node test-parse.js                                   # offline parser check
HLTV_CDP_URL=http://127.0.0.1:9222 node probe.js     # one player
HLTV_CDP_URL=http://127.0.0.1:9222 node index.js     # all 50
```

Flags: `--cs2` (CS2-only stats), `--refresh` (ignore cache, re-fetch).

Leave the browser window from step 1 open (and solve a Cloudflare
challenge in it if one reappears) while the script works through all 50
players (~800ms between requests). It prints:

- a per-player `OK`/`FAIL` line as it goes,
- a one-time debug dump of the first player's parsed values, so a parsing
  regression is visible before the other 49 are trusted,
- a table (`player`, `team`, `time_alive`, `seconds`, `dpr`, `entrying`)
  sorted descending by time alive per round,
- explicit MAX / MIN call-outs plus the spread,
- a success count and any per-player failures (logged and skipped, never
  fatal to the run).

**Pages are cached** to `cache/<id>.html`. Re-runs reuse them, so parsing
can be revised and re-run instantly without re-scraping HLTV. Use
`--refresh` to force fresh fetches.

## Sharing results without pasting terminal output

`cache/*.html` is gitignored (each page is ~650KB, not worth committing),
so by default the only way to hand off what got scraped is pasting
console output. Instead:

```bash
node export.js
git add results.json
git commit -m "update HLTV results"
git push
```

`export.js` packages every parsed value from `cache/` (both scopes, all
sides, attribute scores) into one small `results.json` — tens of KB, not
hundreds — that IS tracked. `analyze.js`, `sides.js`, and `compare.js` all
check for `results.json` first via `data.js`, falling back to `cache/`
only if it's absent, and each prints `[data source: ...]` so it's obvious
which one is in play. Whoever pulls `results.json` can rerun the exact
same analysis with no cache directory and no browser at all — just
`node analyze.js`.

## Files

- `roster.js` — the 10 teams / 50 players and their HLTV player IDs.
- `browser.js` — attach-mode `loadPage` (connects to your real browser).
- `parse.js` — pure parsing of a stats-overview page.
- `test-parse.js` — parser tests against real captured markup (offline).
- `index.js` — fetches (with caching), parses, sorts, prints the report.
- `probe.js` — dumps one player's parsed values (`node probe.js <id>`).
- `fetch-roster.js` — captures the live ranking + lineups to `roster.json`.
- `data.js` — shared loader: results.json if present, else cache/*.html.
- `export.js` — packages cache/ into the committable results.json.
- `compare.js` — CS2 vs career side by side.
- `analyze.js` — distribution stats, correlations, and the era-vs-role
  decomposition.
- `sides.js` — CT vs T breakdown of time alive.
- `discover.js`, `inspect-attr.js`, `inspect-cache.js` — the discovery
  tools used to locate the stat and its markup; kept for when HLTV's
  layout changes. `inspect-cache.js` works offline against cache/.

## What the data showed

On the top 10 (n=50), time alive per round is largely death rate restated
in seconds — r = -0.87 against DPR in CS2. Players are only interesting
where they sit *off* that trend.

Career spread (31s) looked much wider than CS2 (19s), but removing apEX
and karrigan collapses it to 20s (SD 4.28s vs CS2's 4.23s) — the entire
difference was those two. At the same death rate (~0.70 DPR) they posted
48-49s where comparable players posted 59-62s: dying just as often but
~15s earlier in the round, which is the entry/sacrificial signature.
Roughly -6s of that is a general veteran/CS:GO-era effect (residual
tracks CS:GO history at r = -0.86); the rest is specific to them. In CS2
both sit on the trend, so the signature is gone.

`node analyze.js` recomputes all of this from cache.

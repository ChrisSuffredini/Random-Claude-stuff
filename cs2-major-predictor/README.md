# CS2 Major predictor (PGL Singapore Major 2026)

Predicts Swiss-stage records and the playoff bracket for a CS2 Major, and
picks a Pick'Em card that maximises the chance of hitting the 5/10 needed
to upgrade the coin. Backtested on every CS2 Major so far.

There are two halves:

- `scraper/` (Node) runs on **your** machine and pulls HLTV pages through
  your own browser, because Cloudflare blocks everything else. It saves
  trimmed, gzipped HTML to `data/raw/`, which gets committed.
- `model/` (Python) parses `data/raw/`, builds ratings, trains the model,
  simulates the Major and runs the backtests. It never touches HLTV.

## 1. Pull the data (your machine, ~20-30 min, resumable)

This uses the same attach mode as `../cs2-time-alive`: you start a normal
Chromium, clear Cloudflare in it yourself, and the script borrows that
session.

```bash
cd cs2-major-predictor
npm install
```

Start a throwaway-profile browser with remote debugging, then in **that**
window open https://www.hltv.org and clear any "verify you are human" check:

```bash
chromium --remote-debugging-port=9222 --user-data-dir=/tmp/hltv-profile &
```

Quick probe first (about 25 requests: the Singapore event pages, one month
of results, one ranking). It prints how many matches/teams it found per
page:

```bash
HLTV_CDP_URL=http://127.0.0.1:9222 node scraper/scrape.js --probe
```

You want to see `results 2026-10: <several hundred> matches`, ranking pages
with dozens of teams, and `event 8302: "PGL Major Singapore 2026"` followed by
its stage sub-events. If so, run the whole thing:

```bash
HLTV_CDP_URL=http://127.0.0.1:9222 node scraper/scrape.js
```

It opens its own tab in that browser, so leave the window open. If
Cloudflare challenges mid-run, the console says `[waiting]`: solve it in the
window and the run carries on. Pages are fetched with an in-page `fetch()`
(no images/ads, so a few hundred ms each), with a full navigation fallback
if Cloudflare objects. Ctrl-C is safe: re-running skips what is saved.

Then commit the data (around 10 MB of `.html.gz`):

```bash
git add data/raw
git commit -m "HLTV data for Major model"
git push
```

What gets fetched (newest first, so an interrupted run still has the most
useful data):

| kind | URL | requests |
|---|---|---|
| events | `/events/8302` + each stage sub-event, its `/matches` and `/results` | ~15 |
| results | `/results?startDate=..&endDate=..&offset=..`, month by month since 2023-01, 100 matches each | ~400 |
| results-lan | the same with `matchType=Lan`, to tag LAN matches | ~80 |
| rankings | `/ranking/teams/YYYY/month/D`, every other Monday since 2023-01 | ~100 |

Flags: `--only events,results,lan,rankings`, `--from YYYY-MM`, `--refresh`,
`--event <id>` (a different Major).

During the Major, re-running `--only events,results` picks up the stage
results so far, and the model re-simulates from the live standings.

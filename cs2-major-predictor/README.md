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

### Easiest way on Windows/Mac (no git needed)

`node scraper/run.js` does everything above in one go (opens Chrome, waits
for you to clear Cloudflare, probes, scrapes) and packs the result into a
single `hltv-data.tar.gz`. Upload that file on GitHub in this folder
(**Add file → Upload files → Commit changes**); `python3 model/unpack.py`
puts it back into `data/raw/`.

## 2. Build the model, backtest, predict (Python)

```bash
pip install numpy pandas beautifulsoup4 lxml
python3 model/unpack.py        # only if the data came as hltv-data.tar.gz
python3 model/parse.py         # data/raw -> data/parsed/{matches,rankings}.csv, events.json
python3 model/backtest.py      # every CS2 Major so far; picks the model + noise level
python3 model/predict.py       # Singapore: Pick'Em card, odds for all 32 teams, bracket
```

### How it works

- **Ratings.** A Glicko-style rating per team on the per-map logit scale
  (a 2-1 Bo3 = two map wins and a loss), one over all matches and one
  over LAN only. Uncertainty grows when a team is inactive and jumps when
  HLTV's ranking shows a lineup change, so ratings re-learn fast after
  roster moves. Team identity follows HLTV team ids, so renames keep history.
- **Features per team** at match time (strictly pre-match): both ratings
  and their uncertainty, HLTV ranking points and position, roster
  continuity over 90 days, maps played in 90 days, recent form vs
  expectation, and whether the match is on LAN.
- **Models.** Each maps a team's features to one strength number, and
  P(win a map) = sigmoid(strength A - strength B):
  `glicko` (rating alone), `hltv_rank` (ranking points alone), `linear`
  (logistic regression), `mlp` (small neural net with a linear skip) and
  `ensemble` (average of linear, mlp, glicko). Trained on the two years
  before each cutoff, on matches between top-150 teams, LAN weighted 1.5x.
- **Simulation.** Valve's Swiss rules (1v9 round 1, Buchholz then seed
  pairing, no rematches, Bo1 with Bo3 deciders, all-Bo3 Stage 3 where the
  data shows it), then a seeded 8-team bracket (Bo3, Bo5 final). Each
  simulated tournament gives every team a "form" shock (sigma, chosen by the
  backtest) shared across all its matches, which correlates results.
- **Pick'Em.** The card (two 3-0, six 3-1/3-2, two 0-3) is chosen by local
  search to maximise P(at least 5 correct) over the simulated outcomes,
  not the expected number correct. For playoffs, all 128 brackets are scored.
- **Backtest.** For each stage of every CS2 Major the data contains,
  everything is frozen at stage start: features, model fit, simulation,
  card. Scored on match log loss/accuracy, record log loss, actual Pick'Em
  correct picks vs. a naive seed-based card, and bracket picks. A rolling
  quarterly refit over all LAN matches between ranked teams gives a bigger
  sample for choosing the model.

During the Major: re-run the scraper with `--only events,results` (or
`node scraper/run.js` again), then `parse.py` and `predict.py`; the
simulation resumes from the live standings.

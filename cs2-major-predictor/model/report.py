"""Render prediction.json + backtest.json into one self-contained HTML page.

    python3 model/report.py [--parsed DIR] [--out FILE]
"""
from __future__ import annotations

import argparse
import html
import json
import os
from datetime import datetime, timezone

from data import PARSED

E = html.escape


def pct(x, digits=0):
    if x is None:
        return "–"
    v = 100 * x
    if 0 < v < 0.5 and digits == 0:
        return "&lt;1%"
    return f"{v:.{digits}f}%"


def bar(x, cls="ct"):
    w = max(0.0, min(1.0, x or 0.0)) * 100
    return (f'<span class="cell"><span class="bar {cls}" style="width:{w:.1f}%"></span>'
            f'<span class="num">{pct(x)}</span></span>')


CSS = """
:root {
  /* Layout: one reading column; the Pick'Em card leads, detail tables follow, scroll inside their own boxes. */
  --bg: #f3f5f8; --surface: #ffffff; --fg: #141821; --muted: #5a6475; --line: #dfe3ea;
  --ct: #2f63ad; --t: #b9790f; --win: #1f8a4c; --loss: #c0392b; --chip: #eef2f8;
  --display: "Chakra Petch", "Segoe UI", system-ui, sans-serif;
  --body: "Inter", "Segoe UI", system-ui, sans-serif;
  --mono: "JetBrains Mono", ui-monospace, "SFMono-Regular", Menlo, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #0e1117; --surface: #161a22; --fg: #e6e9ef; --muted: #96a0b2; --line: #272d39;
  --ct: #6d9be3; --t: #e3a73f; --win: #4cc283; --loss: #ee6b5c; --chip: #1e2430; color-scheme: dark } }
:root[data-theme="dark"] {
  --bg: #0e1117; --surface: #161a22; --fg: #e6e9ef; --muted: #96a0b2; --line: #272d39;
  --ct: #6d9be3; --t: #e3a73f; --win: #4cc283; --loss: #ee6b5c; --chip: #1e2430; color-scheme: dark }
body { background: var(--bg); color: var(--fg); font: 15px/1.55 var(--body); }
.wrap { max-width: 1040px; margin: 0 auto; padding-block: 28px 64px;
  padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px));
  display: grid; gap: 28px; }
h1, h2, h3 { font-family: var(--display); text-wrap: balance; margin: 0; letter-spacing: .01em; }
h1 { font-size: clamp(28px, 5vw, 42px); line-height: 1.1; }
h2 { font-size: 22px; }
h3 { font-size: 14px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); }
p { margin: 0; max-width: 68ch; }
.muted { color: var(--muted); }
.sub { display: flex; flex-wrap: wrap; gap: 6px 16px; color: var(--muted); font-size: 13px; }
.sub b { color: var(--fg); font-weight: 600; }
section { display: grid; gap: 14px; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 18px; display: grid; gap: 16px; }
.headline { display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px 28px; }
.big { font: 600 44px/1 var(--display); font-variant-numeric: tabular-nums; }
.big small { font-size: 15px; color: var(--muted); font-family: var(--body); font-weight: 400; margin-left: 6px; }
.cols { display: grid; grid-template-columns: 1fr 2fr 1fr; gap: 14px; }
.col { display: grid; gap: 8px; align-content: start; min-width: 0; }
.col h3 { display: flex; justify-content: space-between; }
.chip { display: flex; justify-content: space-between; gap: 8px; align-items: center; padding: 8px 10px;
  background: var(--chip); border-radius: 6px; border-left: 3px solid var(--ct); min-width: 0; }
.chip .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chip .p { font: 13px var(--mono); color: var(--muted); font-variant-numeric: tabular-nums; }
.c30 .chip { border-left-color: var(--win); }
.c03 .chip { border-left-color: var(--loss); }
.advgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.dist { display: grid; grid-template-columns: repeat(11, 1fr); gap: 3px; align-items: end; height: 70px; }
.dist div { background: var(--ct); border-radius: 2px 2px 0 0; min-height: 1px; }
.dist div.pass { background: var(--win); }
.distlab { display: grid; grid-template-columns: repeat(11, 1fr); gap: 3px; font: 11px var(--mono); color: var(--muted); text-align: center; }
.scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid var(--line); white-space: nowrap; }
th { font: 600 12px var(--body); text-transform: uppercase; letter-spacing: .06em; color: var(--muted); position: sticky; top: 0; background: var(--surface); }
tr:last-child td { border-bottom: 0; }
td.n, th.n { text-align: right; font-family: var(--mono); font-variant-numeric: tabular-nums; }
.cell { display: inline-grid; grid-template-columns: 70px 44px; align-items: center; gap: 8px; }
.bar { height: 6px; border-radius: 3px; background: var(--ct); justify-self: start; }
.bar.t { background: var(--t); } .bar.win { background: var(--win); } .bar.loss { background: var(--loss); }
.num { font: 13px var(--mono); text-align: right; font-variant-numeric: tabular-nums; }
.tag { display: inline-block; font: 600 11px var(--body); letter-spacing: .05em; text-transform: uppercase;
  padding: 2px 6px; border-radius: 4px; background: var(--chip); color: var(--muted); }
.tag.pick30 { color: var(--win); } .tag.pickadv { color: var(--ct); } .tag.pick03 { color: var(--loss); }
.bracket { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; align-items: center; }
.round { display: grid; gap: 10px; }
.match { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.match div { padding: 7px 10px; display: flex; justify-content: space-between; gap: 8px; }
.match div + div { border-top: 1px solid var(--line); }
.match .w { font-weight: 700; } .match .w::after { content: "▸"; color: var(--t); }
.good { color: var(--win); font-weight: 600; } .bad { color: var(--loss); font-weight: 600; }
ul.notes { margin: 0; padding-left: 18px; display: grid; gap: 6px; max-width: 72ch; }
@media (max-width: 720px) {
  .cols { grid-template-columns: 1fr; }
  .bracket { grid-template-columns: 1fr; }
}
"""


def stage1_section(pred):
    s1 = pred["stage1"]
    card = s1["card"]
    probs = {t["team"]: t["p"] for t in s1["teams"]}
    p30 = lambda k: probs[k]["3-0"]
    padv = lambda k: probs[k]["3-1"] + probs[k]["3-2"]
    p03 = lambda k: probs[k]["0-3"]

    def chips(teams, f):
        return "".join(f'<div class="chip"><span class="name">{E(k)}</span><span class="p">{pct(f(k))}</span></div>'
                       for k in sorted(teams, key=lambda k: -f(k)))

    dist = s1.get("dist", [])
    mx = max(dist) if dist else 1
    bars = "".join(f'<div class="{"pass" if i >= 5 else ""}" style="height:{100 * v / mx:.1f}%" '
                   f'title="{i} correct: {pct(v, 1)}"></div>' for i, v in enumerate(dist))
    labs = "".join(f"<span>{i}</span>" for i in range(len(dist)))

    picked = {}
    for k in card["3-0"]:
        picked[k] = '<span class="tag pick30">3-0</span>'
    for k in card["advance (3-1/3-2)"]:
        picked[k] = '<span class="tag pickadv">adv</span>'
    for k in card["0-3"]:
        picked[k] = '<span class="tag pick03">0-3</span>'
    rows = "".join(
        f"<tr><td class='n'>{t['seed']}</td><td>{E(t['team'])}</td><td>{picked.get(t['team'], '')}</td>"
        f"<td>{bar(t['p']['3-0'], 'win')}</td><td>{bar(t['p']['3-1'] + t['p']['3-2'])}</td>"
        f"<td>{bar(t['p']['3-0'] + t['p']['3-1'] + t['p']['3-2'], 't')}</td><td>{bar(t['p']['0-3'], 'loss')}</td>"
        f"<td class='n'>{t['strength']:+.2f}</td></tr>" for t in s1["teams"])
    return f"""
<section>
  <h2>Stage 1 Pick'Em card</h2>
  <div class="card">
    <div class="headline">
      <div class="big">{pct(s1['p_pass'])}<small>chance of 5+ correct (coin upgrade)</small></div>
      <div class="big">{s1['expected']:.1f}<small>expected correct picks of 10</small></div>
    </div>
    <div class="cols">
      <div class="col c30"><h3><span>3-0</span><span>P(3-0)</span></h3>{chips(card['3-0'], p30)}</div>
      <div class="col"><h3><span>Advance 3-1 / 3-2</span><span>P</span></h3><div class="advgrid">{chips(card['advance (3-1/3-2)'], padv)}</div></div>
      <div class="col c03"><h3><span>0-3</span><span>P(0-3)</span></h3>{chips(card['0-3'], p03)}</div>
    </div>
    <div>
      <h3>How many picks land, over {pred['sims']:,} simulated Stage 1s</h3>
      <div class="dist" role="img" aria-label="distribution of correct picks">{bars}</div>
      <div class="distlab">{labs}</div>
    </div>
    <p class="muted">The card maximises the chance of reaching 5 correct, not the expected number. A team that goes
    3-0 does not count as an "advance" pick, so the advance slots go to teams likely to qualify but not cleanly.</p>
  </div>
  <div class="scroll"><table>
    <thead><tr><th class="n">Seed</th><th>Team</th><th>Pick</th><th>3-0</th><th>3-1 / 3-2</th><th>Advance</th><th>0-3</th><th class="n">Strength</th></tr></thead>
    <tbody>{rows}</tbody></table></div>
</section>"""


def tournament_section(pred):
    rows = "".join(
        f"<tr><td>{E(t['team'])}</td><td>{bar(t['s2'])}</td><td>{bar(t['s3'])}</td><td>{bar(t['playoffs'], 't')}</td>"
        f"<td>{bar(t['semis'], 't')}</td><td>{bar(t['final'], 'win')}</td><td>{bar(t['champion'], 'win')}</td></tr>"
        for t in pred["tournament"])
    return f"""
<section>
  <h2>Whole Major, all 32 teams</h2>
  <p class="muted">Chance of reaching each stage. Teams invited to Stage 2 or 3 start at 100% for the stages they skip.
  Stage 2 and 3 Pick'Em cards get built once those fields are known; re-run after each stage.</p>
  <div class="scroll"><table>
    <thead><tr><th>Team</th><th>Stage 2</th><th>Stage 3</th><th>Playoffs</th><th>Semis</th><th>Final</th><th>Champion</th></tr></thead>
    <tbody>{rows}</tbody></table></div>
</section>"""


def bracket_section(pred):
    b = pred["bracket"]
    t, p = b["teams"], b["picks"]
    qf = [(0, 7), (3, 4), (1, 6), (2, 5)]

    def match(a, bb, w):
        return (f'<div class="match"><div class="{"w" if a == w else ""}">{E(a)}</div>'
                f'<div class="{"w" if bb == w else ""}">{E(bb)}</div></div>')

    q = "".join(match(t[a], t[c], p[i]) for i, (a, c) in enumerate(qf))
    s = match(p[0], p[1], p[4]) + match(p[2], p[3], p[5])
    f = match(p[4], p[5], p[6])
    return f"""
<section>
  <h2>Projected playoff bracket</h2>
  <p class="muted">The eight most likely playoff teams, seeded by strength (1v8, 4v5 | 2v7, 3v6). Quarterfinals and
  semis are Bo3, the final Bo5. The real bracket depends on Stage 3, so treat this as the chalk bracket.</p>
  <div class="bracket">
    <div class="round"><h3>Quarterfinals</h3>{q}</div>
    <div class="round"><h3>Semifinals</h3>{s}</div>
    <div class="round"><h3>Final</h3>{f}<p class="muted">Champion: <b>{E(p[6])}</b></p></div>
  </div>
</section>"""


def backtest_section(bt):
    if not bt:
        return ""
    chosen = bt.get("chosen", {})
    cm, cs = chosen.get("model", "ensemble"), chosen.get("sigma", 0.25)
    rows = [r for r in bt["rows"] if r["model"] == cm]
    trs = []
    for r in rows:
        if "seed_card_correct" in r:
            got = r.get(f"picks_s{cs}")
            seed = r["seed_card_correct"]
            cls = "good" if got is not None and got >= 5 else "bad"
            trs.append(f"<tr><td>{E(r['major'])}</td><td>{E(r['stage'])}</td><td class='n {cls}'>{got}/10</td>"
                       f"<td class='n'>{seed}/10</td><td class='n'>{pct(r.get(f'p_pass_s{cs}'))}</td>"
                       f"<td class='n'>{pct(r['match_acc'])}</td></tr>")
        else:
            trs.append(f"<tr><td>{E(r['major'])}</td><td>Playoffs</td><td class='n'>{r['bracket_correct']}/7</td>"
                       f"<td class='n'>–</td><td class='n'>–</td><td class='n'>{pct(r['match_acc'])}</td></tr>")
    summ = bt.get("summary", {})
    models = sorted(summ, key=lambda k: summ[k]["match_ll"])
    roll = bt.get("rolling_lan", {})
    mtr = "".join(
        f"<tr><td>{E(k)}{' <span class=tag>used</span>' if k == cm else ''}</td>"
        f"<td class='n'>{summ[k]['match_ll']:.3f}</td><td class='n'>{pct(summ[k]['match_acc'], 1)}</td>"
        f"<td class='n'>{summ[k].get(f's{cs}', {}).get('pickem_mean', float('nan')):.1f}</td>"
        f"<td class='n'>{pct(summ[k].get(f's{cs}', {}).get('pickem_pass_rate'))}</td>"
        f"<td class='n'>{(roll.get(k, {}).get('series_ll') or float('nan')):.3f}</td></tr>" for k in models)
    sw = [r for r in rows if "seed_card_correct" in r]
    n_pass = sum(1 for r in sw if (r.get(f"picks_s{cs}") or 0) >= 5)
    n_seed = sum(1 for r in sw if r["seed_card_correct"] >= 5)
    return f"""
<section>
  <h2>Backtest on past CS2 Majors</h2>
  <p>Every stage was replayed as of the moment it started: ratings, model fit and simulation used only earlier
  matches. The model's card reached 5+ in <b>{n_pass} of {len(sw)}</b> Swiss stages; a naive seed-order card
  (top two seeds 3-0, seeds 3-8 advance, bottom two 0-3) did it in <b>{n_seed}</b>.</p>
  <div class="scroll"><table>
    <thead><tr><th>Major</th><th>Stage</th><th class="n">Model card</th><th class="n">Seed card</th><th class="n">Model's P(5+)</th><th class="n">Match acc.</th></tr></thead>
    <tbody>{''.join(trs)}</tbody></table></div>
  <h3>Model comparison</h3>
  <div class="scroll"><table>
    <thead><tr><th>Model</th><th class="n">Major match log loss</th><th class="n">Major match acc.</th><th class="n">Avg Pick'Em</th><th class="n">5+ rate</th><th class="n">LAN test log loss</th></tr></thead>
    <tbody>{mtr}</tbody></table></div>
  <p class="muted">Log loss: lower is better (0.693 = coin flip). "LAN test" refits every quarter and predicts the next
  quarter's LAN matches between ranked teams, a much larger sample than the Majors alone.</p>
</section>"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--parsed", default=PARSED)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()
    pred = json.load(open(os.path.join(args.parsed, "prediction.json")))
    btp = os.path.join(args.parsed, "backtest.json")
    bt = json.load(open(btp)) if os.path.exists(btp) else None
    when = datetime.now(timezone.utc).strftime("%d %b %Y")
    model_label = {"ensemble": "ensemble (linear + neural net + Glicko)",
                   "ensemble+maps": "ensemble + map vetoes", "mlp": "neural net", "linear": "logistic model",
                   "glicko": "Glicko rating", "hltv_rank": "HLTV ranking"}.get(pred["model"], pred["model"])
    page = f"""<title>Singapore Major Pick'Em</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@500;600;700&family=Inter:wght@400;600;700&family=JetBrains+Mono:wght@400;600&display=swap">
<style>{CSS}</style>
<div class="wrap">
  <header style="display:grid;gap:10px">
    <h3>PGL Major Singapore 2026 · CS2</h3>
    <h1>Singapore Major Pick'Em</h1>
    <div class="sub"><span>Model <b>{E(model_label)}</b></span><span>Form noise σ <b>{pred['sigma']}</b></span>
    <span><b>{pred['sims']:,}</b> simulated Majors</span><span>HLTV data to <b>{when}</b></span></div>
  </header>
  {stage1_section(pred)}
  {tournament_section(pred)}
  {bracket_section(pred)}
  {backtest_section(bt)}
  <section>
    <h2>How it works</h2>
    <ul class="notes">
      <li>Every CS2-era HLTV result since 2023 feeds a Glicko rating per team on a per-map scale, one over all matches and one over LAN only. Rating uncertainty grows with inactivity and after lineup changes.</li>
      <li>Each team's features (both ratings, HLTV ranking points, roster continuity, recent form, player ratings of the current five) go through a small neural net and a logistic model to give one strength number; the ensemble averages them with Glicko.</li>
      <li>Stages are simulated with Valve's Swiss rules: 1v9 opening round, Buchholz-then-seed pairing, no rematches, Bo1 with Bo3 deciders. Each simulated Major gives every team a shared "form" shock so results correlate.</li>
      <li>The Pick'Em card is searched to maximise the chance of 5+ correct over the simulated outcomes.</li>
      <li>CS is noisy, Bo1s especially. Even a perfect model misses often; use the probabilities, not just the picks.</li>
    </ul>
  </section>
</div>
"""
    out = args.out or os.path.join(args.parsed, "report.html")
    with open(out, "w") as f:
        f.write(page)
    print(f"wrote {out}")


if __name__ == "__main__":
    main()

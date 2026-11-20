"""Backtest on every CS2 Major found in the data.

For each stage, everything is frozen at the moment the stage starts (the
Pick'Em lock): ratings/features use only earlier matches, and the models
are refit on the two years before that moment. Then:
  * match level: log loss / accuracy on the stage's actual matches;
  * stage level: simulate the stage 20k times, score the probability given
    to each team's actual record;
  * Pick'Em: build the optimised card and the naive seed card, count the
    actual correct picks (5+ upgrades the coin);
  * playoffs: best bracket by expected correct picks, count actual hits.
Also a rolling out-of-sample test on all LAN matches between ranked teams
(refit every quarter), which has far more matches than the Majors alone.

    python3 model/backtest.py [--parsed DIR] [--sims 20000] [--quick]
"""
from __future__ import annotations

import argparse
import json
import multiprocessing as mp
import math
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from data import PARSED, prepare  # noqa: E402
from learn import map_logloss  # noqa: E402
from majors import discover, infer_seeds  # noqa: E402
from pickem import card_stats, indicators, optimise_bracket, optimise_card, score_card  # noqa: E402
from pipeline import (DEFAULT_PARAMS, Ensemble, LAN_COL, build_features, fit_models,  # noqa: E402
                      relevant_mask, save_params, team_strengths, tune_glicko)
from sim import REC_INDEX, RECORDS, series_prob, sigmoid, simulate_playoffs, simulate_swiss  # noqa: E402


def seed_card(n=16):
    """Naive card: top-2 seeds 3-0, seeds 3-8 advance, bottom-2 0-3."""
    return [[0, 1], [2, 3, 4, 5, 6, 7], [n - 2, n - 1]]


def bo_of(fmt):
    return {"bo1": 1, "bo3": 3, "bo5": 5}.get(fmt, 3)


def stage_match_metrics(stage, s_of):
    ll, hit, n = 0.0, 0, 0
    for a, b, w1, w2, fmt in zip(stage["matches"]["a"], stage["matches"]["b"], stage["matches"]["maps1"],
                                 stage["matches"]["maps2"], stage["matches"]["format"]):
        p = series_prob(sigmoid(s_of[a] - s_of[b]), bo_of(fmt))
        y = 1 if w1 > w2 else 0
        p = min(max(p, 1e-6), 1 - 1e-6)
        ll += -(y * math.log(p) + (1 - y) * math.log(1 - p))
        hit += int((p > 0.5) == bool(y))
        n += 1
    return ll, hit, n


def rolling_lan_eval(m, Xa, Xb, models_at, start_t, end_t, step=91):
    """Refit every `step` days; score the next window's LAN matches."""
    t = m["t"].values
    wa, wb = m["maps1"].values, m["maps2"].values
    lan = m["lan"].values == 1
    rel = relevant_mask(Xa, Xb)
    tot = {}
    cut = start_t
    while cut < end_t:
        models = models_at(cut)
        mask = (t >= cut) & (t < cut + step) & lan & rel
        if mask.sum():
            for name, mdl in models.items():
                sd = mdl.predict_strength(Xa[mask]) - mdl.predict_strength(Xb[mask])
                p = np.clip(sigmoid(sd), 1e-6, 1 - 1e-6)
                ll = -(wa[mask] * np.log(p) + wb[mask] * np.log(1 - p)).sum()
                # series level, from map p and the match format
                bo = np.array([bo_of(f) for f in m["format"].values[mask]])
                ps = np.clip(np.where(bo == 1, p, np.where(bo == 3, p * p * (3 - 2 * p),
                                                             p ** 3 * (10 - 15 * p + 6 * p * p))), 1e-6, 1 - 1e-6)
                y = (wa[mask] > wb[mask]).astype(float)
                sll = -(y * np.log(ps) + (1 - y) * np.log(1 - ps)).sum()
                acc = ((ps > 0.5) == (y == 1)).sum()
                d = tot.setdefault(name, [0.0, 0.0, 0.0, 0, 0])
                d[0] += ll
                d[1] += (wa[mask] + wb[mask]).sum()
                d[2] += sll
                d[3] += acc
                d[4] += mask.sum()
        cut += step
    return {k: {"map_ll": v[0] / v[1], "series_ll": v[2] / v[4], "acc": v[3] / v[4], "n": v[4]}
            for k, v in tot.items()}


G = {}


def eval_stage(si):
    """Evaluate every model on one stage (runs in a worker process)."""
    st, snap = G["stages"][si], G["snaps"][si]
    models = G["cache"][round(st["t_start"], 3)]
    sigmas, sims = G["sigmas"], G["sims"]
    rank_pts = {k: snap[k][4] for k in st["teams"]}
    rows = []
    for name, mdl in models.items():
        s_vec = team_strengths(mdl, snap, st["teams"])
        s_of = dict(zip(st["teams"], s_vec))
        ll, hit, n = stage_match_metrics(st, s_of)
        row = {"major": st["major"], "stage": st["stage"], "model": name, "match_ll": ll / n,
               "match_acc": hit / n, "n_matches": n}
        if st["kind"] == "swiss":
            seeds = infer_seeds(st["r1_pairs"], rank_pts)
            L = np.array([[s_of[a] - s_of[b] for b in seeds] for a in seeds])
            actual = np.array([REC_INDEX[st["record"][t]] for t in seeds])
            act_ind = indicators(actual[None, :])
            row["seed_card_correct"] = int(score_card(act_ind, seed_card())[0])
            row["actual"] = {t: "%d-%d" % st["record"][t] for t in seeds}
            for sg in sigmas:
                cat, _ = simulate_swiss(L, sims, sigma=sg, all_bo3=st["all_bo3"], seed=si)
                probs = np.stack([(cat == c).mean(0) for c in range(6)], 1)
                row[f"rec_ll_s{sg}"] = float(-np.log(np.clip(probs[np.arange(16), actual], 1e-3, 1)).mean())
                card, cs = optimise_card(indicators(cat), restarts=4, seed=si)
                row[f"picks_s{sg}"] = int(score_card(act_ind, card)[0])
                row[f"p_pass_s{sg}"] = cs["p_pass"]
                row[f"card_s{sg}"] = {"3-0": [seeds[i] for i in card[0]], "adv": [seeds[i] for i in card[1]],
                                      "0-3": [seeds[i] for i in card[2]]}
        else:
            teams = st["teams"]
            pos = {t: i for i, t in enumerate(teams)}
            L = np.array([[s_of[a] - s_of[b] for b in teams] for a in teams])
            qf = [(pos[a], pos[b]) for a, b in st["qf_pairs"]]
            w = simulate_playoffs(L, sims, sigma=sigmas[min(1, len(sigmas) - 1)], qf=qf, seed=si)
            best = optimise_bracket(w, qf)
            picks = [teams[i] for i in best["picks"]]
            row.update({"bracket_correct": sum(int(p == a) for p, a in zip(picks, st["actual"])),
                        "bracket_expected": best["expected"], "bracket_picks": picks, "actual": st["actual"],
                        "champion_pick": picks[-1], "champion_actual": st["actual"][-1],
                        "p_actual_champion": float((w[:, 6] == pos[st["actual"][-1]]).mean())})
        rows.append(row)
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--parsed", default=PARSED)
    ap.add_argument("--sims", type=int, default=8000)
    ap.add_argument("--quick", action="store_true", help="skip Glicko tuning and the rolling LAN test")
    ap.add_argument("--sigmas", default="0,0.25,0.5")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()
    t0 = time.time()

    m, r, idx = prepare(args.parsed)
    stages = discover(m)
    print(f"{len(m)} matches, {len(r)} ranking rows; found {len(stages)} Major stages:")
    for s in stages:
        extra = f"all Bo3" if s.get("all_bo3") else ""
        print(f"  {s['major']:<40} {s['stage']:<18} {len(s['matches']):>3} matches {extra}")
    if not stages:
        print("No Major stages recognised; check event names in matches.csv")
        return

    # 1. Glicko settings, tuned only on data before the first Major in the test
    first_t = stages[0]["t_start"]
    if args.quick:
        params = dict(DEFAULT_PARAMS)
    else:
        print("\nTuning rating settings on data before the first Major (no look-ahead):")
        params, ll = tune_glicko(m, r, first_t)
        print(f"  -> {params} (map log loss {ll:.4f})")
    save_params(params, os.path.join(args.parsed, "params.json"))

    queries = [(s["t_start"], s["teams"]) for s in stages]
    Xa, Xb, pg, snaps = build_features(m, r, queries, params)

    cache = {}

    def models_at(cut):
        key = round(cut, 3)
        if key not in cache:
            ms, n = fit_models(Xa, Xb, m, cut)
            ms["ensemble"] = Ensemble([ms["linear"], ms["mlp"], ms["glicko"]])
            cache[key] = ms
        return cache[key]

    # 2. Rolling LAN test (big sample, for model selection)
    rolling = {}
    if not args.quick:
        print("\nRolling out-of-sample test on LAN matches between ranked teams (refit quarterly):")
        rolling = rolling_lan_eval(m, Xa, Xb, models_at, first_t - 30, m["t"].max())
        for k, v in sorted(rolling.items(), key=lambda kv: kv[1]["series_ll"]):
            print(f"  {k:<10} series log loss {v['series_ll']:.4f}  acc {v['acc']:.3f}  map log loss {v['map_ll']:.4f}  n={v['n']}")

    # 3. Majors: fit models at every stage start, then evaluate stages in parallel
    sigmas = [float(x) for x in args.sigmas.split(",")]
    for st in stages:
        models_at(st["t_start"])
    G.update(stages=stages, snaps=snaps, cache=cache, sigmas=sigmas, sims=args.sims)
    print(f"\nMajor stages (ratings frozen at stage start; {args.sims} sims x {len(sigmas)} noise levels x "
          f"{len(cache[round(stages[0]['t_start'], 3)])} models):")
    with mp.get_context("fork").Pool(max(1, (os.cpu_count() or 2))) as pool:
        per_stage = pool.map(eval_stage, range(len(stages)))
    rows = [row for stage_rows in per_stage for row in stage_rows]
    ref_sigma = sigmas[min(1, len(sigmas) - 1)]
    for st, stage_rows in zip(stages, per_stage):
        e = [x for x in stage_rows if x["model"] == "ensemble"][0]
        if st["kind"] == "swiss":
            print(f"  {st['major'][:34]:<34} {st['stage']:<17} match acc {e['match_acc']:.2f} ll {e['match_ll']:.3f} | "
                  f"pick'em {e[f'picks_s{ref_sigma}']}/10 (seed card {e['seed_card_correct']}/10, "
                  f"model P(5+) {e[f'p_pass_s{ref_sigma}']:.2f})")
        else:
            print(f"  {st['major'][:34]:<34} {st['stage']:<17} match acc {e['match_acc']:.2f} ll {e['match_ll']:.3f} | "
                  f"bracket {e['bracket_correct']}/7, champion pick {e['champion_pick']} (actual {e['champion_actual']}, "
                  f"P={e['p_actual_champion']:.2f})")

    # 4. Aggregate
    print("\nSummary over all Major stages:")
    names = sorted(set(x["model"] for x in rows))
    summ = {}
    for name in names:
        rr = [x for x in rows if x["model"] == name]
        sw = [x for x in rr if "picks_correct" in x]
        po = [x for x in rr if "bracket_correct" in x]
        nm = sum(x["n_matches"] for x in rr)
        d = {
            "match_ll": sum(x["match_ll"] * x["n_matches"] for x in rr) / nm,
            "match_acc": sum(x["match_acc"] * x["n_matches"] for x in rr) / nm,
            "seed_card_mean": float(np.mean([x["seed_card_correct"] for x in sw])) if sw else None,
            "seed_card_pass_rate": float(np.mean([x["seed_card_correct"] >= 5 for x in sw])) if sw else None,
            "bracket_mean": float(np.mean([x["bracket_correct"] for x in po])) if po else None,
            "n_swiss": len(sw),
        }
        for sg in sigmas:
            d[f"s{sg}"] = {
                "rec_ll": float(np.mean([x[f"rec_ll_s{sg}"] for x in sw])),
                "pickem_mean": float(np.mean([x[f"picks_s{sg}"] for x in sw])),
                "pickem_pass_rate": float(np.mean([x[f"picks_s{sg}"] >= 5 for x in sw])),
                "model_expected_pass": float(np.mean([x[f"p_pass_s{sg}"] for x in sw])),
            }
        summ[name] = d
        print(f"  {name:<10} match log loss {d['match_ll']:.3f}, acc {d['match_acc']:.3f} | seed card {d['seed_card_mean']:.1f}/10 "
              f"(5+ in {d['seed_card_pass_rate']:.0%}) | bracket {d['bracket_mean'] if d['bracket_mean'] is not None else float('nan'):.1f}/7")
        for sg in sigmas:
            x = d[f"s{sg}"]
            print(f"      noise {sg:<5} record log loss {x['rec_ll']:.3f} | pick'em {x['pickem_mean']:.1f}/10, "
                  f"5+ in {x['pickem_pass_rate']:.0%} of stages (model expected {x['model_expected_pass']:.0%})")

    # 5. Choose: model by the big rolling LAN test (fallback: Major match log
    # loss); noise level by record log loss of that model at the Majors.
    if rolling:
        best_model = min(rolling, key=lambda k: rolling[k]["series_ll"])
    else:
        best_model = min(summ, key=lambda k: summ[k]["match_ll"])
    best_sigma = min(sigmas, key=lambda sg: summ[best_model][f"s{sg}"]["rec_ll"])
    chosen = {"model": best_model, "sigma": best_sigma}
    print(f"\nChosen for prediction: model={best_model}, tournament-form noise sigma={best_sigma}")

    out = args.out or os.path.join(args.parsed, "backtest.json")
    with open(out, "w") as f:
        json.dump({"params": params, "chosen": chosen, "rolling_lan": rolling, "summary": summ, "rows": rows}, f,
                  indent=1, default=str)
    print(f"\nWrote {out} ({time.time() - t0:.0f}s)")


if __name__ == "__main__":
    main()

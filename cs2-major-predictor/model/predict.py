"""Predict the PGL Singapore Major 2026: Pick'Em card for the stage that is
up next, full-tournament odds, and a bracket.

    python3 model/predict.py [--sims 50000] [--model ensemble] [--sigma 0.3]

Reads data/parsed (matches.csv, rankings.csv, events.json), model/singapore.json
(stage ids, seed hints) and data/parsed/params.json + backtest.json (the
settings the backtest chose). Writes data/parsed/prediction.json and prints
a readable report.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
from collections import defaultdict

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from data import PARSED, RankingLookup, prepare  # noqa: E402
from extras import load_extras, veto_deltas  # noqa: E402
from majors import discover  # noqa: E402
from pickem import card_stats, indicators, optimise_bracket, optimise_card  # noqa: E402
from pipeline import Ensemble, build_features, fit_models, load_params, team_strengths  # noqa: E402
from sim import (PLAYOFF_QF, RECORDS, REC_INDEX, SwissState, series_from_deltas, series_prob,  # noqa: E402
                 sigmoid, simulate_swiss_once, standings)

HERE = os.path.dirname(os.path.abspath(__file__))


def norm(s):
    return "".join(ch for ch in s.lower() if ch.isalnum())


class Names:
    """Maps any spelling seen on event/match pages to the model's team key."""

    def __init__(self, keys, aliases):
        self.by_norm = {norm(k): k for k in keys}
        for a, k in aliases.items():
            self.by_norm[norm(a)] = k

    def __call__(self, name):
        n = norm(name)
        if n in self.by_norm:
            return self.by_norm[n]
        for k_n, k in self.by_norm.items():  # "PARIVISION" vs "PVISION", "FaZe Clan" vs "FaZe"
            if n and (n in k_n or k_n in n) and min(len(n), len(k_n)) >= 3:
                return k
        return name


def stage_events(events, cfg):
    """Pick the Stage 1/2/3 event ids from the scraped event pages."""
    out = {}
    for eid, e in events.items():
        title = (e.get("title") or "").lower()
        for k in ("stage 1", "stage 2", "stage 3"):
            if title.endswith(k):
                out[k] = eid
    main = str(cfg.get("event_id", 8302))
    out.setdefault("stage 3", main)  # main event page lists the Stage 3 / playoff teams
    for k, v in cfg.get("stage_event_ids", {}).items():
        out[k] = str(v)
    return out


def event_teams(e, idx, names):
    teams = []
    for t in e.get("teams", []):
        if not t.get("team") or t["team"].upper() == "TBD":
            continue
        k = idx.key_for_id(t["team_id"], t["team"]) if t.get("team_id") else names(t["team"])
        teams.append(k)
    return teams


def seed_stage(teams, pairs, hints, pts):
    """Seeds (index = seed-1). Round 1 is seed i vs i+8; hints are known seeds."""
    hints = {k: v for k, v in hints.items() if k in teams}
    if pairs and len(pairs) == 8:
        tops = []
        for a, b in pairs:
            ha, hb = hints.get(a), hints.get(b)
            if (ha and ha <= 8) or (hb and hb >= 9):
                top, low = a, b
            elif (hb and hb <= 8) or (ha and ha >= 9):
                top, low = b, a
            else:
                top, low = (a, b) if pts.get(a, 0) >= pts.get(b, 0) else (b, a)
            slot = hints.get(top) if hints.get(top, 99) <= 8 else (hints[low] - 8 if hints.get(low, 0) >= 9 else None)
            tops.append((slot, top, low))
        known = sorted([x for x in tops if x[0]], key=lambda x: x[0])
        free_slots = [s for s in range(1, 9) if s not in {x[0] for x in known}]
        unknown = sorted([x for x in tops if not x[0]], key=lambda x: -pts.get(x[1], 0))
        for s, x in zip(free_slots, unknown):
            known.append((s, x[1], x[2]))
        known.sort(key=lambda x: x[0])
        return [x[1] for x in known] + [x[2] for x in known]
    # no pairings: hints first, then ranking points
    return sorted(teams, key=lambda k: (hints.get(k, 99), -pts.get(k, 0)))


class SubDeltas:
    """View of the global veto table through a stage's local team indices."""

    def __init__(self, gd, ix):
        self.gd, self.ix = gd, ix

    def __bool__(self):
        return True

    def get(self, key):
        i, j, bo = key
        return self.gd.get((self.ix[i], self.ix[j], bo))


def live_state(seeds, played, upcoming):
    st = SwissState(len(seeds))
    pos = {k: i for i, k in enumerate(seeds)}
    for a, b, wa, wb in played:
        if a in pos and b in pos:
            w, l = (a, b) if wa > wb else (b, a)
            st.record(pos[w], pos[l])
    pending = [(pos[a], pos[b]) for a, b in upcoming if a in pos and b in pos]
    return st, pending


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--parsed", default=PARSED)
    ap.add_argument("--sims", type=int, default=50000)
    ap.add_argument("--model", default=None)
    ap.add_argument("--sigma", type=float, default=None)
    args = ap.parse_args()

    cfg = json.load(open(os.path.join(HERE, "singapore.json")))
    bt_path = os.path.join(args.parsed, "backtest.json")
    bt = json.load(open(bt_path)) if os.path.exists(bt_path) else {}
    model_name = args.model or bt.get("chosen", {}).get("model", "ensemble")
    sigma = args.sigma if args.sigma is not None else bt.get("chosen", {}).get("sigma", 0.3)
    params = load_params(os.path.join(args.parsed, "params.json"))

    m, r, idx = prepare(args.parsed)
    events = json.load(open(os.path.join(args.parsed, "events.json")))
    keys = set(m["a"]) | set(m["b"]) | set(r["key"])
    names = Names(keys, cfg.get("aliases", {}))
    sev = stage_events(events, cfg)

    stage_teams = {k: event_teams(events.get(v, {}), idx, names) for k, v in sev.items()}
    s1 = stage_teams.get("stage 1", [])
    s2_inv = [t for t in stage_teams.get("stage 2", []) if t not in s1][:8]
    s3_inv = [t for t in stage_teams.get("stage 3", []) if t not in s1 and t not in s2_inv][:8]
    for k, lst in (("stage1_teams", s1), ("stage2_invited", s2_inv), ("stage3_invited", s3_inv)):
        if cfg.get(k) and len(lst) < len(cfg[k]):
            lst[:] = [names(x) for x in cfg[k]]
    print(f"Stage 1 ({len(s1)}): {', '.join(s1)}")
    print(f"Stage 2 invites ({len(s2_inv)}): {', '.join(s2_inv)}")
    print(f"Stage 3 invites ({len(s3_inv)}): {', '.join(s3_inv)}")
    all_teams = s1 + s2_inv + s3_inv
    missing = [t for t in all_teams if t not in keys]
    if missing:
        print(f"WARNING: no match history for {missing}; add an alias in model/singapore.json")

    # Results already played at this Major (from the monthly results + event pages)
    played = defaultdict(list)
    seen = set()
    for stage, eid in sev.items():
        title = events.get(eid, {}).get("title", "")
        for _, row in m[m["event"] == title].iterrows():
            played[stage].append((row["a"], row["b"], row["maps1"], row["maps2"]))
            seen.add(int(row["id"]))
        for res in events.get(eid, {}).get("results", []):
            if res["id"] in seen:
                continue
            a, b = names(res["team1"]), names(res["team2"])
            s1_, s2_ = res["score1"], res["score2"]
            played[stage].append((a, b, s1_, s2_))
            seen.add(res["id"])
    upcoming = {}
    for k, v in sev.items():
        ev_slug = norm(events.get(v, {}).get("title", ""))
        lst = []
        for u in events.get(v, {}).get("upcoming", []):
            # HLTV's match list ignores the event filter: keep this stage's matches only
            if u["id"] in seen or not (ev_slug and norm(u.get("slug", "")).endswith(ev_slug)):
                continue
            if "-vs-" not in u.get("slug", ""):
                continue  # placeholder for a later Swiss round
            teams = u.get("teams", [])
            if len(teams) < 2 and "-vs-" in u.get("slug", ""):
                # fall back to the match URL: heroic-vs-imperial-pgl-major-singapore-2026-stage-1
                left, right = u["slug"].split("-vs-", 1)
                right_n = norm(right)
                if ev_slug and right_n.endswith(ev_slug):
                    right_n = right_n[: -len(ev_slug)]
                teams = [left, right_n]
            if len(teams) >= 2:
                lst.append((names(teams[0]), names(teams[1])))
        upcoming[k] = lst

    now_t = m["t"].max() + 0.01
    players, mapmodel = load_extras(args.parsed, idx, RankingLookup(r), r)
    use_maps = model_name.endswith("+maps") and mapmodel is not None
    base_name = model_name.replace("+maps", "")
    if use_maps:
        mp = bt.get("map_params", {})
        mapmodel.half_life = mp.get("half_life", 180.0)
        mapmodel.ridge = mp.get("ridge", 6.0)
        map_scale = mp.get("scale", 1.0)
        offsets = mapmodel.offsets(all_teams, now_t)
        pool = mapmodel.pool(now_t)
        print(f"Map pool (last 60 days): {', '.join(pool)}")
    Xa, Xb, pg, snaps = build_features(m, r, [(now_t, all_teams)], params, players=players)
    snap = snaps[0]
    models, n_train = fit_models(Xa, Xb, m, now_t)
    models["ensemble"] = Ensemble([models["linear"], models["mlp"], models["glicko"]])
    model = models[base_name]
    s_vec = team_strengths(model, snap, all_teams)
    S = dict(zip(all_teams, s_vec))
    pts = {k: snap[k][4] for k in all_teams}
    print(f"\nModel: {model_name}, trained on {n_train} matches; tournament form sigma={sigma}")

    # Seeds
    hints = {names(k): v for k, v in cfg.get("stage1_seed_hints", {}).items()}
    r1 = upcoming.get("stage 1", [])[:8] if not played["stage 1"] else []
    if played["stage 1"]:
        # round 1 = the first 8 played/known matches of the stage
        r1 = [(a, b) for a, b, _, _ in played["stage 1"][:8]]
    seeds1 = seed_stage(s1, r1, hints, pts)
    inv2 = sorted(s2_inv, key=lambda k: -pts.get(k, 0))
    inv3 = sorted(s3_inv, key=lambda k: -pts.get(k, 0))
    # Stage 3 format: copy the most recent Major's Stage 3 (all Bo3 or Bo1 + Bo3 deciders)
    past_s3 = [st for st in discover(m) if st["kind"] == "swiss" and st["stage"].lower() == "stage 3"]
    all_bo3_s3 = past_s3[-1]["all_bo3"] if past_s3 else bool(cfg.get("stage3_all_bo3", True))
    print(f"Stage 3 format: {'all Bo3' if all_bo3_s3 else 'Bo1 with Bo3 deciders'}"
          f"{' (as at ' + past_s3[-1]['major'] + ')' if past_s3 else ' (config default)'}")

    rng = np.random.default_rng(1)
    gi = {k: i for i, k in enumerate(all_teams)}
    G = np.array([[S[a] - S[b] for b in all_teams] for a in all_teams])
    n = len(all_teams)
    # veto adjustments for every ordered pair (A = first team), global indices
    GD = veto_deltas(all_teams, offsets, pool, map_scale) if use_maps else None
    reach = defaultdict(lambda: np.zeros(7))  # S2, S3, PO, SF, F, W  (index 1..6)
    s1_cat = np.empty((args.sims, 16), dtype=np.int8)
    st1, pend1 = live_state(seeds1, played["stage 1"], upcoming.get("stage 1", []))
    po_count = defaultdict(int)
    for s in range(args.sims):
        shock = rng.normal(0, sigma, n) if sigma > 0 else np.zeros(n)

        def run(seeds, state=None, pending=None, all_bo3=False):
            ix = [gi[k] for k in seeds]
            L = G[np.ix_(ix, ix)]
            md = SubDeltas(GD, ix) if GD is not None else None
            stt, order = simulate_swiss_once(L, rng, 0.0, all_bo3, state, pending, shock=shock[ix], maps=md)
            return stt, order

        stt, order = run(seeds1, st1, pend1)
        s1_cat[s] = [REC_INDEX[(stt.wins[i], stt.losses[i])] for i in range(16)]
        q1 = [seeds1[i] for i in order if stt.wins[i] == 3]
        seeds2 = inv2 + q1
        stt, order = run(seeds2)
        q2 = [seeds2[i] for i in order if stt.wins[i] == 3]
        seeds3 = inv3 + q2
        stt, order = run(seeds3, all_bo3=all_bo3_s3)
        po = [seeds3[i] for i in order if stt.wins[i] == 3]
        for k in q1:
            reach[k][1] += 1
        for k in seeds2:
            reach[k][1] += 0
        for k in q2:
            reach[k][2] += 1
        for k in po:
            reach[k][3] += 1

        def play(a, b, bo):
            x = S[a] - S[b] + shock[gi[a]] - shock[gi[b]]
            p = (series_from_deltas(x, GD[(gi[a], gi[b], bo)], bo) if GD is not None
                 else series_prob(sigmoid(x), bo))
            return a if rng.random() < p else b

        qw = [play(po[a], po[b], 3) for a, b in PLAYOFF_QF]
        for k in qw:
            reach[k][4] += 1
        f1, f2 = play(qw[0], qw[1], 3), play(qw[2], qw[3], 3)
        reach[f1][5] += 1
        reach[f2][5] += 1
        champ = play(f1, f2, 5)
        reach[champ][6] += 1
        po_count[tuple(sorted(po))] += 1

    # Stage 1 Pick'Em card (if Stage 1 has not finished)
    ind = indicators(s1_cat)
    card, cs = optimise_card(ind, restarts=10, seed=0)
    card_named = {"3-0": [seeds1[i] for i in card[0]], "advance (3-1/3-2)": [seeds1[i] for i in card[1]],
                  "0-3": [seeds1[i] for i in card[2]]}

    print("\n=== Stage 1 Pick'Em (maximises P(5+ correct)) ===")
    for k, v in card_named.items():
        print(f"  {k:<18} {', '.join(v)}")
    print(f"  P(5+ correct) = {cs['p_pass']:.1%}, expected correct = {cs['expected']:.2f}")
    print("\n  seed team                 P(3-0)  P(adv 3-1/3-2) P(advance) P(0-3)  strength")
    for i, k in enumerate(seeds1):
        c = s1_cat[:, i]
        print(f"  {i + 1:>3}  {k:<20} {np.mean(c == 5):6.1%}  {np.mean((c == 3) | (c == 4)):12.1%}  "
              f"{np.mean(c >= 3):9.1%}  {np.mean(c == 0):6.1%}  {S[k]:+.2f}")

    print("\n=== Whole Major (all 32 teams) ===")
    print("  team                 S2      S3      Playoffs Semis   Final   Champion")
    rows = []
    for k in all_teams:
        v = reach[k] / args.sims
        s2 = 1.0 if k in s2_inv or k in s3_inv else v[1]
        s3 = 1.0 if k in s3_inv else v[2]
        rows.append((k, s2, s3, v[3], v[4], v[5], v[6]))
    rows.sort(key=lambda x: -x[6])
    for k, *v in rows:
        print(f"  {k:<20} " + "  ".join(f"{x:6.1%}" for x in v))

    # A plain bracket: the most likely playoff field, seeded by strength
    top8 = sorted(all_teams, key=lambda k: -reach[k][3])[:8]
    top8.sort(key=lambda k: -S[k])
    L8 = np.array([[S[a] - S[b] for b in top8] for a in top8])
    from sim import simulate_playoffs
    w = simulate_playoffs(L8, 20000, sigma=sigma, seed=3)
    br = optimise_bracket(w, PLAYOFF_QF)
    picks = [top8[i] for i in br["picks"]]
    print("\n=== Projected bracket (most likely 8, seeded by strength) ===")
    for (a, b), wq in zip(PLAYOFF_QF, picks[:4]):
        print(f"  QF  {top8[a]} vs {top8[b]}  ->  {wq}")
    print(f"  SF  {picks[0]} vs {picks[1]}  ->  {picks[4]}")
    print(f"  SF  {picks[2]} vs {picks[3]}  ->  {picks[5]}")
    print(f"  Final {picks[4]} vs {picks[5]}  ->  {picks[6]}")

    out = {
        "model": model_name, "sigma": sigma, "sims": args.sims,
        "stage1": {"seeds": seeds1, "card": card_named, "p_pass": cs["p_pass"], "expected": cs["expected"],
                   "dist": cs["dist"].tolist(),
                   "teams": [{"team": k, "seed": i + 1, "strength": float(S[k]),
                              "p": {RECORDS[c]: float(np.mean(s1_cat[:, i] == c)) for c in range(6)}}
                             for i, k in enumerate(seeds1)]},
        "tournament": [{"team": k, "s2": a, "s3": b, "playoffs": c, "semis": d, "final": e, "champion": f}
                       for k, a, b, c, d, e, f in rows],
        "bracket": {"teams": top8, "picks": picks},
        "strengths": {k: float(v) for k, v in S.items()},
    }
    with open(os.path.join(args.parsed, "prediction.json"), "w") as f:
        json.dump(out, f, indent=1)
    print(f"\nWrote {os.path.join(args.parsed, 'prediction.json')}")


if __name__ == "__main__":
    main()

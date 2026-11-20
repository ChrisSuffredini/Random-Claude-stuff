"""Shared plumbing: features for every match + snapshots at stage starts,
model fitting at a cutoff, and per-stage simulation."""
from __future__ import annotations

import itertools
import json
import math
import os

import numpy as np

from data import PARSED, RankingLookup, prepare
from learn import GlickoOnly, MLPStrength, RankOnly, map_logloss
from ratings import FEATURES, FeatureBuilder

DEFAULT_PARAMS = {"v0": 1.2, "c2": 0.004, "roster_v": 0.15, "lan_v0": 1.2, "lan_c2": 0.002}
RANK_COL = FEATURES.index("rank_score")
LAN_COL = FEATURES.index("lan")
RELEVANT_RANK = 150


def build_features(m, r, queries, params=None, players=None):
    """queries: list of (t, [teams]). Returns (Xa, Xb, p_glicko, {query_index: {team: x}})."""
    rl = RankingLookup(r)
    if players is not None:
        players.rl = rl
    fb = FeatureBuilder(rl, **(params or DEFAULT_PARAMS), players=players)
    order = sorted(range(len(queries)), key=lambda i: queries[i][0])
    Xa, Xb, pg, q = fb.run(m, [queries[i] for i in order])
    snaps = {order[j]: q[j] for j in range(len(order))}
    return Xa, Xb, pg, snaps


def relevant_mask(Xa, Xb):
    lim = -math.log(RELEVANT_RANK)
    return (Xa[:, RANK_COL] >= lim) & (Xb[:, RANK_COL] >= lim)


def tune_glicko(m, r, until_t, grid=None, verbose=True):
    """Pick Glicko settings by map log loss on relevant matches before until_t."""
    grid = grid or {
        "v0": [0.8, 1.2, 1.8],
        "c2": [0.001, 0.003, 0.008],
        "roster_v": [0.0, 0.1, 0.25],
    }
    t = m["t"].values
    wa, wb = m["maps1"].values.astype(float), m["maps2"].values.astype(float)
    eval_mask = (t < until_t) & (t >= t.min() + 120)  # skip the burn-in
    best = None
    for v0, c2, rv in itertools.product(grid["v0"], grid["c2"], grid["roster_v"]):
        params = {"v0": v0, "c2": c2, "roster_v": rv, "lan_v0": v0, "lan_c2": c2}
        Xa, Xb, pg, _ = build_features(m, r, [], params)
        mask = eval_mask & relevant_mask(Xa, Xb)
        p = np.clip(pg[mask], 1e-6, 1 - 1e-6)
        ll = float(-(wa[mask] * np.log(p) + wb[mask] * np.log(1 - p)).sum() / (wa[mask] + wb[mask]).sum())
        if verbose:
            print(f"  v0={v0:<4} c2={c2:<6} roster_v={rv:<5} map log loss {ll:.4f}  (n={mask.sum()})")
        if best is None or ll < best[0]:
            best = (ll, params)
    return best[1], best[0]


MODELS = {
    "glicko": lambda: GlickoOnly(),
    "hltv_rank": lambda: RankOnly(),
    "linear": lambda: MLPStrength(linear_only=True, epochs=300, lr=0.02),
    "mlp": lambda: MLPStrength(hidden=12, epochs=300, lr=0.01, l2=3e-3),
}


def fit_models(Xa, Xb, m, cutoff, names=None, window_days=730, lan_weight=1.5):
    t = m["t"].values
    mask = (t < cutoff) & (t >= cutoff - window_days) & relevant_mask(Xa, Xb)
    wa, wb = m["maps1"].values[mask], m["maps2"].values[mask]
    w = np.where(m["lan"].values[mask] == 1, lan_weight, 1.0)
    out = {}
    for name in names or MODELS:
        out[name] = MODELS[name]().fit(Xa[mask], Xb[mask], wa, wb, t[mask], weight=w)
    return out, int(mask.sum())


class Ensemble:
    """Average of member strengths (members must be fitted)."""

    def __init__(self, members):
        self.members = members

    def predict_strength(self, X):
        return np.mean([mm.predict_strength(X) for mm in self.members], axis=0)

    def predict(self, Xa, Xb):
        return 1 / (1 + np.exp(-(self.predict_strength(Xa) - self.predict_strength(Xb))))


def team_strengths(model, snap, teams, lan=1.0):
    X = np.array([snap[k] for k in teams], dtype=float)
    X[:, LAN_COL] = lan
    return model.predict_strength(X)


def save_params(params, path=None):
    with open(path or os.path.join(PARSED, "params.json"), "w") as f:
        json.dump(params, f, indent=1)


def load_params(path=None):
    p = path or os.path.join(PARSED, "params.json")
    if os.path.exists(p):
        with open(p) as f:
            return json.load(f)
    return dict(DEFAULT_PARAMS)

"""Optional data from the second scrape: player ratings and map-level results.

PlayerLookup  team -> mean rating of its current five (lineup from HLTV's
              ranking, or from who played for it last month), each player's
              rating map-weighted over the 6 full months before, shrunk to
              the average with 15 maps of prior weight.
MapModel      per-team, per-map strength offsets on the logit scale, from
              map results vs top-50 teams: residuals against a map-level
              rating, time-decayed and shrunk (ridge). Plus the active map
              pool and Valve's veto, so a Bo1/Bo3 is played on the maps the
              two teams would actually leave in.
"""
from __future__ import annotations

import math
import os
from collections import defaultdict

import numpy as np
import pandas as pd

R0 = 1.0
PRIOR_MAPS = 15.0


def month_of(t_days):
    d = pd.Timestamp("1970-01-01") + pd.Timedelta(days=float(t_days))
    return f"{d.year}-{d.month:02d}"


def prev_months(month, n):
    y, m = map(int, month.split("-"))
    out = []
    for _ in range(n):
        m -= 1
        if m == 0:
            y, m = y - 1, 12
        out.append(f"{y}-{m:02d}")
    return out


class PlayerLookup:
    def __init__(self, ps: pd.DataFrame, rank_lookup, key_to_id: dict, lookback=6):
        self.rl = rank_lookup
        self.key_to_id = key_to_id
        self.lookback = lookback
        self.by = defaultdict(dict)  # (month, filter) -> pid -> (maps, rating)
        self.team_month = defaultdict(lambda: defaultdict(float))  # (month, team_id) -> pid -> maps
        for r in ps.itertuples():
            if pd.isna(r.rating) or pd.isna(r.maps):
                continue
            self.by[(r.month, r.filter)][int(r.player_id)] = (float(r.maps), float(r.rating))
            if r.filter == "all" and isinstance(r.team_ids, str):
                for tid in r.team_ids.split(";"):
                    if tid:
                        self.team_month[(r.month, int(tid))][int(r.player_id)] += float(r.maps)
        self._cache = {}

    def player(self, pid, month, filt):
        num, den = 0.0, 0.0
        for mo in prev_months(month, self.lookback):
            x = self.by.get((mo, filt), {}).get(pid)
            if x:
                num += x[0] * x[1]
                den += x[0]
        return (num + PRIOR_MAPS * R0) / (den + PRIOR_MAPS)

    def lineup(self, key, t):
        ent = self.rl.get(key, t)
        if ent and len(ent[2]) >= 4:
            return [int(p) for p in ent[2]]
        tid = self.key_to_id.get(key)
        if tid is None:
            return []
        for mo in prev_months(month_of(t), 2):
            pl = self.team_month.get((mo, tid))
            if pl:
                return [p for p, _ in sorted(pl.items(), key=lambda kv: -kv[1])[:5]]
        return []

    def features(self, key, t):
        month = month_of(t)
        ck = (key, month, self.rl.snapshot(t) is not None and id(self.rl.snapshot(t)))
        if ck in self._cache:
            return self._cache[ck]
        lu = self.lineup(key, t)
        if not lu:
            out = (0.0, 0.0)
        else:
            a = np.mean([self.player(p, month, "all") for p in lu]) - R0
            b = np.mean([self.player(p, month, "top50") for p in lu]) - R0
            out = (float(a), float(b))
        self._cache[ck] = out
        return out


# ------------------------------------------------------------------ maps
class MapModel:
    def __init__(self, maps_df: pd.DataFrame, idx, half_life=180.0, ridge=6.0, v0=1.2, c2=0.003):
        """maps_df from maps.csv; idx = data.TeamIndex for team identity."""
        self.half_life, self.ridge = half_life, ridge
        df = maps_df.copy()
        df["t"] = df["unix_ms"].astype("int64") / 86400000
        df = df[(df["score1"] != "") & (df["score2"] != "")].copy()
        df["score1"] = pd.to_numeric(df["score1"], errors="coerce")
        df["score2"] = pd.to_numeric(df["score2"], errors="coerce")
        df = df.dropna(subset=["score1", "score2"])
        df = df[df["score1"] != df["score2"]].sort_values("t")

        def key(tid, name, t):
            try:
                tid = int(tid)
            except (TypeError, ValueError):
                tid = None
            return idx.key_for_id(tid, idx.key(name, t)) if tid else idx.key(name, t)

        df["a"] = [key(i, n, t) for i, n, t in zip(df["team1_id"], df["team1"], df["t"])]
        df["b"] = [key(i, n, t) for i, n, t in zip(df["team2_id"], df["team2"], df["t"])]
        df["y"] = (df["score1"] > df["score2"]).astype(float)
        # self-contained map-level rating -> pre-map base probability
        from ratings import Glicko
        gl = Glicko(v0, c2, 0.0)
        p = np.empty(len(df))
        for i, (a, b, y, t) in enumerate(zip(df["a"], df["b"], df["y"], df["t"])):
            p[i] = gl.p(a, b, t)
            gl.update(a, b, int(y), int(1 - y), t)
        df["p"] = p
        self.df = df.reset_index(drop=True)
        self.T = self.df["t"].values

    def pool(self, t, days=60, size=7):
        d = self.df[(self.T < t) & (self.T >= t - days)]
        return list(d["map"].value_counts().index[:size])

    def offsets(self, teams, t):
        """{team: {map: offset}} from maps strictly before t."""
        d = self.df[self.T < t]
        w = np.exp(-(t - d["t"].values) * math.log(2) / self.half_life)
        res = d["y"].values - d["p"].values
        info = d["p"].values * (1 - d["p"].values)
        num = defaultdict(float)
        den = defaultdict(float)
        want = set(teams)
        for a, b, mp, r, i, ww in zip(d["a"].values, d["b"].values, d["map"].values, res, info, w):
            if a in want:
                num[(a, mp)] += ww * r
                den[(a, mp)] += ww * i
            if b in want:
                num[(b, mp)] -= ww * r
                den[(b, mp)] += ww * i
        out = {}
        for tm in teams:
            off = {}
            for (k, mp), v in num.items():
                if k == tm:
                    off[mp] = v / (den[(k, mp)] + self.ridge)
            out[tm] = off
        return out

    def eval_logloss(self, start_t, end_t, scale=1.0, step=30):
        """Out-of-sample map log loss with vs without offsets (offsets refit monthly)."""
        tot0 = tot1 = n = 0.0
        t = start_t
        while t < end_t:
            d = self.df[(self.T >= t) & (self.T < t + step)]
            if len(d):
                teams = set(d["a"]) | set(d["b"])
                off = self.offsets(teams, t)
                p0 = np.clip(d["p"].values, 1e-6, 1 - 1e-6)
                lg = np.log(p0 / (1 - p0)) + scale * np.array(
                    [off[a].get(mp, 0.0) - off[b].get(mp, 0.0) for a, b, mp in zip(d["a"], d["b"], d["map"])])
                p1 = np.clip(1 / (1 + np.exp(-lg)), 1e-6, 1 - 1e-6)
                y = d["y"].values
                tot0 += -(y * np.log(p0) + (1 - y) * np.log(1 - p0)).sum()
                tot1 += -(y * np.log(p1) + (1 - y) * np.log(1 - p1)).sum()
                n += len(d)
            t += step
        return tot0 / max(n, 1), tot1 / max(n, 1), int(n)


def veto(off_a, off_b, pool, bo):
    """Valve Major veto with greedy teams. A = higher seed.
    Bo1: A removes 2, B removes 3, A picks from the last 2.
    Bo3: A ban, B ban, A pick, B pick, A ban, B ban, decider.
    Bo5: A ban, B ban, then picks A, B, A, B, decider.
    Returns the maps in playing order."""
    left = list(pool)
    adv = {m: off_a.get(m, 0.0) - off_b.get(m, 0.0) for m in left}  # A's edge

    def ban(team):
        m = min(left, key=lambda x: adv[x]) if team == "A" else max(left, key=lambda x: adv[x])
        left.remove(m)

    def pick(team):
        m = max(left, key=lambda x: adv[x]) if team == "A" else min(left, key=lambda x: adv[x])
        left.remove(m)
        return m

    if len(left) < 7:
        return [None] * bo
    if bo == 1:
        ban("A"); ban("A"); ban("B"); ban("B"); ban("B")
        return [pick("A")]
    if bo == 3:
        ban("A"); ban("B")
        m1, m2 = pick("A"), pick("B")
        ban("A"); ban("B")
        return [m1, m2, left[0]]
    ban("A"); ban("B")
    seq = [pick("A"), pick("B"), pick("A"), pick("B")]
    return seq + [left[0]]


def series_from_maps(ps):
    """P(A wins) when maps are played in order with win probabilities ps."""
    need = len(ps) // 2 + 1
    # dp over (wins A, wins B)
    dp = {(0, 0): 1.0}
    win = 0.0
    for p in ps:
        nd = defaultdict(float)
        for (wa, wb), pr in dp.items():
            for da, q in ((1, p), (0, 1 - p)):
                na, nb = wa + da, wb + (1 - da)
                if na == need:
                    win += pr * q
                elif nb == need:
                    pass
                else:
                    nd[(na, nb)] += pr * q
        dp = nd
    return win


def load_extras(parsed_dir, idx, rank_lookup, r):
    """Returns (PlayerLookup or None, MapModel or None)."""
    pl = mm = None
    pp = os.path.join(parsed_dir, "player_stats.csv")
    if os.path.exists(pp):
        ps = pd.read_csv(pp, keep_default_na=False)
        ps["rating"] = pd.to_numeric(ps["rating"], errors="coerce")
        ps["maps"] = pd.to_numeric(ps["maps"], errors="coerce")
        key_to_id = {}
        for k, tid in zip(r["key"], r["team_id"]):
            if not pd.isna(tid):
                key_to_id[k] = int(tid)
        pl = PlayerLookup(ps, rank_lookup, key_to_id)
    mp = os.path.join(parsed_dir, "maps.csv")
    if os.path.exists(mp):
        mm = MapModel(pd.read_csv(mp, keep_default_na=False), idx)
    return pl, mm


def veto_deltas(teams, offsets, pool, scale=1.0, bos=(1, 3, 5)):
    """{(i, j, bo): np.array of per-map logit adjustments} for every ordered pair,
    team i being veto team A. Offsets are centred over the pool per team."""
    if not pool or len(pool) < 7:
        return None
    cen = {}
    for t in teams:
        o = offsets.get(t, {})
        vals = {m: o.get(m, 0.0) for m in pool}
        mu = sum(vals.values()) / len(vals)
        cen[t] = {m: v - mu for m, v in vals.items()}
    out = {}
    for i, a in enumerate(teams):
        for j, b in enumerate(teams):
            if i == j:
                continue
            for bo in bos:
                seq = veto(cen[a], cen[b], pool, bo)
                out[(i, j, bo)] = np.array([scale * (cen[a][m] - cen[b][m]) for m in seq])
    return out

"""Online ratings and point-in-time team features.

Glicko-style rating on the per-map logit scale: P(A wins a map) =
sigmoid(g(vA + vB) * (rA - rB)). A Bo3 that ends 2-1 counts as two map
wins and one loss. Variance grows with inactivity (c2 per day) and jumps
when HLTV's ranking shows a lineup change (roster_v per changed player),
so ratings re-learn quickly after roster moves.

Two ratings are kept: all matches, and LAN matches only.
Every feature is computed from information strictly before the match.
"""
from __future__ import annotations

import math
from collections import defaultdict, deque

import numpy as np

PI2 = math.pi ** 2

FEATURES = ["r_all", "sd_all", "r_lan", "sd_lan", "log_pts", "rank_score",
            "continuity", "activity", "form", "lan", "plr_all", "plr_top50"]


def g(v):
    return 1.0 / math.sqrt(1.0 + 3.0 * v / PI2)


def sig(x):
    return 1.0 / (1.0 + math.exp(-x))


class Glicko:
    def __init__(self, v0=1.2, c2=0.004, roster_v=0.0):
        self.v0, self.c2, self.roster_v = v0, c2, roster_v
        self.r = {}
        self.v = {}
        self.last = {}

    def get(self, k, t):
        if k not in self.r:
            return 0.0, self.v0
        v = min(self.v0, self.v[k] + self.c2 * max(0.0, t - self.last[k]))
        return self.r[k], v

    def p(self, a, b, t):
        ra, va = self.get(a, t)
        rb, vb = self.get(b, t)
        return sig(g(va + vb) * (ra - rb))

    def update(self, a, b, wa, wb, t):
        ra, va = self.get(a, t)
        rb, vb = self.get(b, t)
        n = wa + wb
        ga, gb = g(vb), g(va)
        ea, eb = sig(ga * (ra - rb)), sig(gb * (rb - ra))
        va2 = 1.0 / (1.0 / va + ga * ga * ea * (1 - ea) * n)
        vb2 = 1.0 / (1.0 / vb + gb * gb * eb * (1 - eb) * n)
        self.r[a], self.v[a], self.last[a] = ra + va2 * ga * (wa - n * ea), va2, t
        self.r[b], self.v[b], self.last[b] = rb + vb2 * gb * (wb - n * eb), vb2, t

    def shock(self, k, t, changed):
        if k in self.r and changed > 0 and self.roster_v > 0:
            r, v = self.get(k, t)
            self.v[k] = min(self.v0, v + self.roster_v * changed)
            self.last[k] = t


class FeatureBuilder:
    def __init__(self, rank_lookup, v0=1.2, c2=0.004, roster_v=0.15, lan_v0=1.2, lan_c2=0.002,
                 form_days=45, act_days=90, cont_days=90, players=None):
        self.rl = rank_lookup
        self.players = players  # extras.PlayerLookup or None
        self.all = Glicko(v0, c2, roster_v)
        self.lan = Glicko(lan_v0, lan_c2, roster_v)
        self.hist = defaultdict(deque)  # key -> (t, maps, residual)
        self.form_days, self.act_days, self.cont_days = form_days, act_days, cont_days
        self.prev_lineup = {}
        self._ri = 0

    # --- roster shocks, applied as ranking snapshots go by
    def apply_rankings_until(self, t):
        rl = self.rl
        while self._ri < len(rl.dates) and rl.dates[self._ri] <= t:
            d = rl.dates[self._ri]
            for k, (_, _, lineup) in rl.by_date[d].items():
                old = self.prev_lineup.get(k)
                if old is not None and lineup and len(old) >= 4 and len(lineup) >= 4:
                    changed = len(lineup - old)
                    self.all.shock(k, d, changed)
                    self.lan.shock(k, d, changed)
                if lineup:
                    self.prev_lineup[k] = lineup
            self._ri += 1

    def team_features(self, k, t, lan_ctx):
        ra, va = self.all.get(k, t)
        rl_, vl = self.lan.get(k, t)
        ent = self.rl.get(k, t)
        rank, pts, lineup = ent if ent else (999, 0.0, frozenset())
        old = self.rl.get(k, t - self.cont_days)
        if lineup and old and old[2]:
            cont = float(len(lineup & old[2]))
        else:
            cont = 4.5
        h = self.hist[k]
        while h and h[0][0] < t - max(self.form_days, self.act_days):
            h.popleft()
        act = sum(x[1] for x in h if x[0] >= t - self.act_days)
        res = [x for x in h if x[0] >= t - self.form_days]
        form = sum(x[2] for x in res) / (sum(x[1] for x in res) + 5.0)
        return [ra, math.sqrt(va), rl_, math.sqrt(vl), math.log1p(pts),
                -math.log(min(rank, 400)), cont, math.log1p(act), form, float(lan_ctx),
                *(self.players.features(k, t) if self.players else (0.0, 0.0))]

    def run(self, matches, queries=None):
        """matches: DataFrame sorted by t with a, b, maps1, maps2, lan, t.
        queries: list of (t, [keys]) snapshots, answered with info < t.
        Returns (Xa, Xb, p_glicko, query_results)."""
        queries = sorted(queries or [], key=lambda q: q[0])
        qi = 0
        q_out = []
        n = len(matches)
        Xa = np.zeros((n, len(FEATURES)))
        Xb = np.zeros((n, len(FEATURES)))
        pg = np.zeros(n)
        A, B = matches["a"].values, matches["b"].values
        W1, W2 = matches["maps1"].values, matches["maps2"].values
        LAN, T = matches["lan"].values, matches["t"].values
        for i in range(n):
            t = T[i]
            while qi < len(queries) and queries[qi][0] <= t:
                qt, keys = queries[qi]
                self.apply_rankings_until(qt)
                q_out.append({k: self.team_features(k, qt, 1) for k in keys})
                qi += 1
            self.apply_rankings_until(t)
            a, b = A[i], B[i]
            Xa[i] = self.team_features(a, t, LAN[i])
            Xb[i] = self.team_features(b, t, LAN[i])
            p = self.all.p(a, b, t)
            pg[i] = p
            wa, wb = int(W1[i]), int(W2[i])
            self.all.update(a, b, wa, wb, t)
            if LAN[i]:
                self.lan.update(a, b, wa, wb, t)
            nm = wa + wb
            self.hist[a].append((t, nm, wa - nm * p))
            self.hist[b].append((t, nm, wb - nm * (1 - p)))
        while qi < len(queries):
            qt, keys = queries[qi]
            self.apply_rankings_until(qt)
            q_out.append({k: self.team_features(k, qt, 1) for k in keys})
            qi += 1
        return Xa, Xb, pg, q_out

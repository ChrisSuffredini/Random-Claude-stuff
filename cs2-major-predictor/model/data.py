"""Load parsed tables and resolve team identities.

HLTV results only carry team *names*; rankings carry name + team id. A
team that renames (same id) keeps its history, and a name is mapped to
the id it belonged to closest in time. Unranked teams keep their name.
"""
from __future__ import annotations

import bisect
import os
from collections import defaultdict

import numpy as np
import pandas as pd

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")
PARSED = os.path.join(ROOT, "parsed")

DAY_MS = 86400000


def load_tables(parsed_dir=PARSED):
    m = pd.read_csv(os.path.join(parsed_dir, "matches.csv"), keep_default_na=False)
    r = pd.read_csv(os.path.join(parsed_dir, "rankings.csv"), keep_default_na=False)
    m["t"] = m["unix_ms"].astype("int64") / DAY_MS  # days since epoch
    r["t"] = pd.to_datetime(r["date"]).astype("int64") / 1e9 / 86400
    r["team_id"] = pd.to_numeric(r["team_id"], errors="coerce")
    r["points"] = pd.to_numeric(r["points"], errors="coerce").fillna(0)
    return m, r


class TeamIndex:
    """name (+time) -> canonical team key (latest HLTV name of that id)."""

    def __init__(self, rankings: pd.DataFrame):
        self.obs = defaultdict(list)  # name -> sorted [(t, id)]
        latest = {}
        for row in rankings.itertuples():
            if pd.isna(row.team_id):
                continue
            tid = int(row.team_id)
            self.obs[row.team.lower()].append((row.t, tid))
            if tid not in latest or row.t >= latest[tid][0]:
                latest[tid] = (row.t, row.team)
        for k in self.obs:
            self.obs[k].sort()
        self.id_name = {tid: name for tid, (_, name) in latest.items()}
        self._cache = {}

    def key(self, name: str, t: float):
        lst = self.obs.get(name.lower())
        if not lst:
            return name
        if len(lst) == 1 or lst[0][1] == lst[-1][1]:
            return self.id_name[lst[0][1]]
        ts = [x[0] for x in lst]
        i = bisect.bisect_left(ts, t)
        cands = [lst[j] for j in (i - 1, i) if 0 <= j < len(lst)]
        best = min(cands, key=lambda x: abs(x[0] - t))
        return self.id_name[best[1]]

    def key_for_id(self, tid, fallback_name):
        return self.id_name.get(tid, fallback_name)


def prepare(parsed_dir=PARSED):
    """Matches with canonical team keys; drops forfeits and unknown formats."""
    m, r = load_tables(parsed_dir)
    idx = TeamIndex(r)
    m = m[(m["format"].isin(["bo1", "bo2", "bo3", "bo5"])) & ((m["maps1"] + m["maps2"]) > 0)].copy()
    m["a"] = [idx.key(n, t) for n, t in zip(m["team1"], m["t"])]
    m["b"] = [idx.key(n, t) for n, t in zip(m["team2"], m["t"])]
    m = m[m["a"] != m["b"]].sort_values(["t", "id"]).reset_index(drop=True)
    r["key"] = [idx.id_name.get(int(i), n) if not pd.isna(i) else n for i, n in zip(r["team_id"], r["team"])]
    return m, r, idx


class RankingLookup:
    """Latest HLTV ranking entry for a team at or before time t."""

    def __init__(self, r: pd.DataFrame):
        self.dates = np.array(sorted(r["t"].unique()))
        self.by_date = {}
        for t, g in r.groupby("t"):
            self.by_date[t] = {
                k: (int(rank) if str(rank).strip() not in ("", "nan") else 999, float(p),
                    frozenset(x for x in str(pl).split(";") if x))
                for k, rank, p, pl in zip(g["key"], g["rank"], g["points"], g["players"])
            }

    def snapshot(self, t):
        i = bisect.bisect_right(self.dates, t) - 1
        return self.by_date[self.dates[i]] if i >= 0 else {}

    def get(self, key, t):
        return self.snapshot(t).get(key)

"""Find CS2 Major stages in the match table and reconstruct what happened.

Stages are recognised by HLTV event name, e.g.
  "PGL CS2 Major Copenhagen 2024 Opening Stage"   (2024 format: Opening/Elimination)
  "BLAST.tv Austin Major 2025 Stage 2"             (2025+ format: Stage 1/2/3)
  "BLAST.tv Austin Major 2025"                     (playoffs = the bare name)
Regional qualifiers (RMR, closed/open qualifiers) are excluded.
"""
from __future__ import annotations

import re
from collections import defaultdict

import numpy as np

from sim import REC_INDEX, SwissState

STAGE_RE = re.compile(r"^(?P<base>.*\bMajor\b.*?\b20\d\d)\s*[-:]?\s*(?P<stage>Opening Stage|Elimination Stage|Stage [123]|Playoffs?)$",
                      re.I)
EXCLUDE = re.compile(r"RMR|Qualifier|Closed|Open Qual|Regional|Showmatch|Academy|Challengers|Legends|Champions Stage", re.I)
STAGE_ORDER = {"opening stage": 1, "stage 1": 1, "elimination stage": 2, "stage 2": 2, "stage 3": 3}


def discover(m, min_year=2024):
    """Returns a list of stage dicts in chronological order."""
    by_event = defaultdict(list)
    for i, ev in enumerate(m["event"].values):
        by_event[ev].append(i)
    bases = {}
    for ev, idx in by_event.items():
        if EXCLUDE.search(ev):
            continue
        mm = STAGE_RE.match(ev.strip())
        if mm and mm.group("stage").lower().startswith("playoff"):
            bases.setdefault(mm.group("base").strip(), {})["playoffs"] = ev
        elif mm:
            bases.setdefault(mm.group("base").strip(), {})[mm.group("stage").lower()] = ev
    # playoffs are usually the bare Major name
    for base in list(bases):
        if "playoffs" not in bases[base] and base in by_event:
            bases[base]["playoffs"] = base
    stages = []
    for base, evs in bases.items():
        year = int(re.search(r"20\d\d", base).group())
        if year < min_year:
            continue
        for key, ev in evs.items():
            sub = m.iloc[sorted(by_event[ev])]
            if key == "playoffs":
                st = playoff_stage(base, ev, sub)
            else:
                st = swiss_stage(base, ev, key, sub)
            if st:
                stages.append(st)
    stages.sort(key=lambda s: s["t_start"])
    return stages


def swiss_stage(base, ev, key, sub):
    sub = sub.sort_values(["t", "id"])
    teams = sorted(set(sub["a"]) | set(sub["b"]))
    if len(teams) != 16 or len(sub) < 30:
        return None
    r1 = sub.iloc[:8]
    if len(set(r1["a"]) | set(r1["b"])) != 16:
        return None
    wins, losses = defaultdict(int), defaultdict(int)
    for a, b, w1, w2 in zip(sub["a"], sub["b"], sub["maps1"], sub["maps2"]):
        win, lose = (a, b) if w1 > w2 else (b, a)
        wins[win] += 1
        losses[lose] += 1
    rec = {t: (wins[t], losses[t]) for t in teams}
    if any(r not in REC_INDEX for r in rec.values()):
        return None
    fmts = set(sub["format"])
    return {
        "major": base,
        "stage": key.title(),
        "kind": "swiss",
        "event": ev,
        "t_start": float(sub["t"].min()) - 0.25,  # a few hours before the first match
        "teams": teams,
        "r1_pairs": list(zip(r1["a"], r1["b"])),
        "matches": sub,
        "all_bo3": fmts == {"bo3"},
        "record": rec,
        "order": STAGE_ORDER.get(key, 0),
    }


def playoff_stage(base, ev, sub):
    sub = sub.sort_values(["t", "id"])
    if len(sub) != 7:
        return None
    qf = sub.iloc[:4]
    winners = [a if w1 > w2 else b for a, b, w1, w2 in zip(sub["a"], sub["b"], sub["maps1"], sub["maps2"])]
    qf_pairs = list(zip(qf["a"], qf["b"]))
    qw = winners[:4]
    sf = sub.iloc[4:6]
    # Order QFs so that (QF0, QF1) feed SF0 and (QF2, QF3) feed SF1.
    order = []
    for a, b in zip(sf["a"], sf["b"]):
        ia = qw.index(a) if a in qw else None
        ib = qw.index(b) if b in qw else None
        if ia is None or ib is None:
            return None
        order += [ia, ib]
    qf_pairs = [qf_pairs[i] for i in order]
    qw = [qw[i] for i in order]
    actual = qw + winners[4:7]
    return {
        "major": base,
        "stage": "Playoffs",
        "kind": "playoffs",
        "event": ev,
        "t_start": float(sub["t"].min()) - 0.25,
        "teams": sorted(set(sub["a"]) | set(sub["b"])),
        "qf_pairs": qf_pairs,
        "matches": sub,
        "actual": actual,
        "order": 4,
    }


def infer_seeds(pairs, strength):
    """Seed list (index = seed-1) consistent with round 1 being 1v9 ... 8v16:
    the stronger team of each pair is a top-8 seed, ordered by strength."""
    tops = []
    for a, b in pairs:
        hi, lo = (a, b) if strength.get(a, -1e9) >= strength.get(b, -1e9) else (b, a)
        tops.append((hi, lo))
    tops.sort(key=lambda x: -strength.get(x[0], -1e9))
    return [h for h, _ in tops] + [l for _, l in tops]


def category_matrix(record, seeds):
    return np.array([REC_INDEX[record[t]] for t in seeds])

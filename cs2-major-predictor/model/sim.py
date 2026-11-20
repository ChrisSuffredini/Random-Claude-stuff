"""Monte Carlo simulation of CS2 Major stages.

Swiss stage (16 teams, 3 wins advance, 3 losses out), following Valve's
Major rules as closely as the public rulebook allows:
  * round 1 pairs seed i with seed i+8 (1v9, 2v10, ... 8v16);
  * later rounds pair teams with the same W-L record, ordered by Buchholz
    difficulty (sum of opponents' current W-L differential), then seed;
    highest plays lowest, avoiding rematches (backtracking);
  * Bo1 except advancement/elimination matches (Bo3), unless the stage is
    all Bo3.
Playoffs: 8-team single elimination, Bo3 with a Bo5 final.

Win probabilities come from a matrix of per-map logits L[a, b]
(P(a wins a map vs b) = sigmoid(L[a, b])). Each simulation adds a
per-team "form on the day" shock e ~ N(0, sigma^2) to every logit
involving that team, which correlates a team's results inside one
simulated tournament the way real over/under-performance does.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

# Final Swiss record categories, indexed by wins - losses mapping below.
RECORDS = ["0-3", "1-3", "2-3", "3-2", "3-1", "3-0"]
REC_INDEX = {(0, 3): 0, (1, 3): 1, (2, 3): 2, (3, 2): 3, (3, 1): 4, (3, 0): 5}


def sigmoid(x):
    return 1.0 / (1.0 + np.exp(-x))


def series_prob(p, bo):
    """P(win a best-of-`bo` series) from per-map win probability p (maps i.i.d.)."""
    if bo == 1:
        return p
    if bo == 3:
        return p * p * (3 - 2 * p)
    if bo == 5:
        return p ** 3 * (10 - 15 * p + 6 * p * p)
    raise ValueError(bo)


@dataclass
class SwissState:
    """Records and history; lets a stage be resumed from live results."""

    n: int
    wins: list = field(default=None)
    losses: list = field(default=None)
    opps: list = field(default=None)

    def __post_init__(self):
        self.wins = self.wins or [0] * self.n
        self.losses = self.losses or [0] * self.n
        self.opps = self.opps or [[] for _ in range(self.n)]

    def copy(self):
        return SwissState(self.n, list(self.wins), list(self.losses), [list(o) for o in self.opps])

    def record(self, winner, loser):
        self.wins[winner] += 1
        self.losses[loser] += 1
        self.opps[winner].append(loser)
        self.opps[loser].append(winner)

    def active(self, t):
        return self.wins[t] < 3 and self.losses[t] < 3

    def buchholz(self, t):
        return sum(self.wins[o] - self.losses[o] for o in self.opps[t])


def _pair_group(ts, opps):
    """First rematch-free pairing in 'top vs bottom' priority order."""
    if not ts:
        return []
    a = ts[0]
    for b in reversed(ts[1:]):
        if b in opps[a]:
            continue
        rest = [t for t in ts[1:] if t != b]
        sub = _pair_group(rest, opps)
        if sub is not None:
            return [(a, b)] + sub
    return None


def swiss_pairings(state: SwissState):
    """Pairings for the next round from the current state (seed = index)."""
    n = state.n
    if all(w == 0 and l == 0 for w, l in zip(state.wins, state.losses)):
        half = n // 2
        return [(i, i + half) for i in range(half)]
    groups = {}
    for t in range(n):
        if state.active(t):
            groups.setdefault((state.wins[t], state.losses[t]), []).append(t)
    pairs = []
    for key in sorted(groups, key=lambda k: (-k[0], k[1])):
        ts = sorted(groups[key], key=lambda t: (-state.buchholz(t), t))
        p = _pair_group(ts, state.opps)
        if p is None:  # unavoidable rematch: plain top-vs-bottom
            p = [(ts[i], ts[-1 - i]) for i in range(len(ts) // 2)]
        pairs.extend(p)
    return pairs


def match_bo(state: SwissState, a, b, all_bo3=False):
    if all_bo3:
        return 3
    decider = state.wins[a] == 2 or state.losses[a] == 2 or state.wins[b] == 2 or state.losses[b] == 2
    return 3 if decider else 1


def standings(state: SwissState):
    """Final order: record, then Buchholz, then seed."""
    return sorted(
        range(state.n),
        key=lambda t: (-(state.wins[t] - state.losses[t]), -state.wins[t], -state.buchholz(t), t),
    )


def simulate_swiss_once(L, rng, sigma=0.0, all_bo3=False, state=None, pending=None, shock=None):
    """One simulated Swiss stage. Returns (final state, standings order).

    L: (n, n) per-map logit matrix, team index == seed - 1.
    state: optional SwissState with results already played.
    pending: optional pairings already drawn for the current round.
    """
    n = L.shape[0]
    st = state.copy() if state is not None else SwissState(n)
    if shock is None:
        shock = rng.normal(0.0, sigma, n) if sigma > 0 else np.zeros(n)
    first = True
    while any(st.active(t) for t in range(n)):
        if first and pending:
            pairs = [p for p in pending if st.active(p[0]) and st.active(p[1])]
            if not pairs:
                pairs = swiss_pairings(st)
        else:
            pairs = swiss_pairings(st)
        first = False
        results = []
        for a, b in pairs:
            bo = match_bo(st, a, b, all_bo3)
            p = series_prob(sigmoid(L[a, b] + shock[a] - shock[b]), bo)
            results.append((a, b) if rng.random() < p else (b, a))
        for w, l in results:
            st.record(w, l)
    return st, standings(st)


def simulate_swiss(L, n_sims=20000, sigma=0.0, all_bo3=False, state=None, pending=None, seed=0):
    """Returns cat[s, t] (index into RECORDS) and order[s, :] (standings)."""
    rng = np.random.default_rng(seed)
    n = L.shape[0]
    cat = np.empty((n_sims, n), dtype=np.int8)
    order = np.empty((n_sims, n), dtype=np.int16)
    for s in range(n_sims):
        st, o = simulate_swiss_once(L, rng, sigma, all_bo3, state, pending)
        for t in range(n):
            cat[s, t] = REC_INDEX[(st.wins[t], st.losses[t])]
        order[s] = o
    return cat, order


# ---------------------------------------------------------------- playoffs
# Seeded bracket (seed index 0..7): QF 1v8, 4v5 | 2v7, 3v6.
PLAYOFF_QF = [(0, 7), (3, 4), (1, 6), (2, 5)]


def simulate_playoffs(L, n_sims=20000, sigma=0.0, qf=None, bo=(3, 3, 5), seed=0, shocks=None):
    """L is the 8x8 logit matrix in bracket-seed order (or any order with qf
    giving index pairs). Returns winners[s, 7]: QF1..QF4, SF1, SF2, Final."""
    rng = np.random.default_rng(seed)
    qf = qf or PLAYOFF_QF
    out = np.empty((n_sims, 7), dtype=np.int16)
    n = L.shape[0]
    for s in range(n_sims):
        sh = shocks[s] if shocks is not None else (rng.normal(0, sigma, n) if sigma > 0 else np.zeros(n))

        def play(a, b, k):
            p = series_prob(sigmoid(L[a, b] + sh[a] - sh[b]), k)
            return a if rng.random() < p else b

        q = [play(a, b, bo[0]) for a, b in qf]
        s1 = play(q[0], q[1], bo[1])
        s2 = play(q[2], q[3], bo[1])
        f = play(s1, s2, bo[2])
        out[s] = q + [s1, s2, f]
    return out


def playoff_seeding(state: SwissState, order):
    """Top 8 of a Swiss stage in bracket-seed order (record, Buchholz, seed)."""
    return [t for t in order if state.wins[t] == 3][:8]

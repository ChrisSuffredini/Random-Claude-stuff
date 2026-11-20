"""Pick'Em optimisation from simulated outcomes.

Swiss stage card (Valve Major Pick'Em): 2 teams to go 3-0, 6 teams to
advance with 3-1 or 3-2, 2 teams to go 0-3, no team twice. A 3-0 team does
NOT score as an "advance" pick. The coin upgrade needs >= 5 correct, so we
maximise P(correct >= 5) over the joint simulated outcomes (which keeps
the correlations between picks), not the expected number correct.

Playoffs: pick the winner of every match of a known 8-team bracket
(4 QF, 2 SF, final), bracket-consistent. All 128 brackets are scored.
"""
from __future__ import annotations

import itertools

import numpy as np

N30, NADV, N03 = 2, 6, 2


def indicators(cat):
    """cat[s, t] record index (0='0-3' ... 5='3-0') -> three boolean matrices."""
    return (cat == 5), ((cat == 3) | (cat == 4)), (cat == 0)


def score_card(ind, card):
    i30, iadv, i03 = ind
    t30, tadv, t03 = card
    return i30[:, t30].sum(1) + iadv[:, tadv].sum(1) + i03[:, t03].sum(1)


def card_stats(ind, card, need=5):
    c = score_card(ind, card)
    return {
        "p_pass": float((c >= need).mean()),
        "expected": float(c.mean()),
        "dist": np.bincount(c, minlength=11)[:11] / len(c),
    }


def greedy_card(ind):
    """Highest marginal probability per slot (the 'expected-picks' card)."""
    i30, iadv, i03 = (m.mean(0) for m in ind)
    n = len(i30)
    best, best_val = None, -1
    # Try each 3-0 pair / 0-3 pair combination greedily on marginals.
    order30 = np.argsort(-i30)
    order03 = np.argsort(-i03)
    t30 = list(order30[:N30])
    t03 = [t for t in order03 if t not in t30][:N03]
    rest = [t for t in np.argsort(-iadv) if t not in t30 and t not in t03]
    tadv = rest[:NADV]
    best = (t30, tadv, t03)
    return [list(map(int, x)) for x in best]


def optimise_card(ind, need=5, restarts=8, seed=0, start=None):
    """Local search over swaps maximising P(correct >= need); ties broken by
    expected correct. Returns (card, stats)."""
    rng = np.random.default_rng(seed)
    i30, iadv, i03 = (m.astype(np.int16) for m in ind)
    n_sims, n = i30.shape

    def objective(card):
        c = i30[:, card[0]].sum(1) + iadv[:, card[1]].sum(1) + i03[:, card[2]].sum(1)
        return (c >= need).mean() + 1e-4 * c.mean()

    def neighbours(card):
        flat = card[0] + card[1] + card[2]
        unused = [t for t in range(n) if t not in flat]
        slots = [(k, j) for k in range(3) for j in range(len(card[k]))]
        # replace a picked team with an unused one
        for k, j in slots:
            for u in unused:
                new = [list(card[0]), list(card[1]), list(card[2])]
                new[k][j] = u
                yield new
        # swap two picked teams between categories
        for (k1, j1), (k2, j2) in itertools.combinations(slots, 2):
            if k1 == k2:
                continue
            new = [list(card[0]), list(card[1]), list(card[2])]
            new[k1][j1], new[k2][j2] = new[k2][j2], new[k1][j1]
            yield new

    starts = [start or greedy_card(ind)]
    for _ in range(restarts - 1):
        perm = [int(x) for x in rng.permutation(n)]
        starts.append([perm[:N30], perm[N30:N30 + NADV], perm[N30 + NADV:N30 + NADV + N03]])

    best_card, best_val = None, -1
    for card in starts:
        val = objective(card)
        improved = True
        while improved:
            improved = False
            for nb in neighbours(card):
                v = objective(nb)
                if v > val + 1e-12:
                    card, val, improved = nb, v, True
                    break
        if val > best_val:
            best_card, best_val = card, val
    best_card = [sorted(x) for x in best_card]
    return best_card, card_stats(ind, best_card, need)


# ---------------------------------------------------------------- playoffs
def all_brackets():
    """Every consistent bracket as (qf winners slot 0/1 x4, sf pick 0/1 x2, final 0/1)."""
    return list(itertools.product([0, 1], repeat=7))


def bracket_teams(qf_pairs, b):
    q = [qf_pairs[i][b[i]] for i in range(4)]
    s1 = (q[0], q[1])[b[4]]
    s2 = (q[2], q[3])[b[5]]
    f = (s1, s2)[b[6]]
    return q + [s1, s2, f]


def optimise_bracket(winners, qf_pairs, weights=(1, 1, 1, 1, 1, 1, 1)):
    """winners[s, 7] simulated (QF1..4, SF1, SF2, F). Returns best by expected
    (weighted) correct picks and the per-bracket distribution."""
    w = np.array(weights)
    best = None
    for b in all_brackets():
        picks = bracket_teams(qf_pairs, b)
        hit = (winners == np.array(picks)[None, :])
        exp = float((hit * w).sum(1).mean())
        if best is None or exp > best[1]:
            best = (picks, exp, np.bincount(hit.sum(1), minlength=8) / len(hit))
    return {"picks": best[0], "expected": best[1], "dist": best[2]}

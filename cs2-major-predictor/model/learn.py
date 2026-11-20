"""Learned combiners: per-team strength s = f(features), P(map) = sigmoid(sA - sB).

Because the network scores each team separately (a "siamese" setup), the
output is a strength per team, so predictions are antisymmetric
(P(A beats B) = 1 - P(B beats A)) and transitive, and the tournament
simulator can treat each team as one number plus noise.

  * LinearStrength: f(x) = w . x            (logistic regression on differences)
  * MLPStrength:    f(x) = w . x + v . tanh(W x + c)   (small neural net with a
                    linear skip connection), trained with Adam on map-level
                    log loss, L2 and early stopping on the latest 15% of time.
Inputs are standardised; the match context (LAN or not) is fed in too.
"""
from __future__ import annotations

import numpy as np


def _sig(x):
    return 1.0 / (1.0 + np.exp(-np.clip(x, -30, 30)))


def map_logloss(s_diff, wa, wb):
    p = np.clip(_sig(s_diff), 1e-9, 1 - 1e-9)
    return float(-(wa * np.log(p) + wb * np.log(1 - p)).sum() / (wa + wb).sum())


class Standardizer:
    def fit(self, X):
        self.mu = X.mean(0)
        self.sd = X.std(0) + 1e-9
        return self

    def __call__(self, X):
        return (X - self.mu) / self.sd


class MLPStrength:
    def __init__(self, hidden=12, l2=1e-3, lr=0.01, epochs=400, batch=2048, seed=0, linear_only=False):
        self.h, self.l2, self.lr, self.epochs, self.batch = hidden, l2, lr, epochs, batch
        self.seed, self.linear_only = seed, linear_only

    def _init(self, d):
        rng = np.random.default_rng(self.seed)
        self.P = {
            "w": np.zeros(d),
            "W": rng.normal(0, 0.3 / np.sqrt(d), (self.h, d)),
            "c": np.zeros(self.h),
            "v": rng.normal(0, 0.05, self.h),
        }

    def strength(self, X, P=None):
        P = P or self.P
        s = X @ P["w"]
        if not self.linear_only:
            s = s + np.tanh(X @ P["W"].T + P["c"]) @ P["v"]
        return s

    def _grads(self, Xa, Xb, wa, wb):
        P = self.P
        ha = np.tanh(Xa @ P["W"].T + P["c"])
        hb = np.tanh(Xb @ P["W"].T + P["c"])
        sa = Xa @ P["w"] + (0 if self.linear_only else ha @ P["v"])
        sb = Xb @ P["w"] + (0 if self.linear_only else hb @ P["v"])
        p = _sig(sa - sb)
        n = wa + wb
        dz = (n * p - wa) / n.sum()  # d loss / d (sa - sb)
        G = {"w": dz @ (Xa - Xb) + self.l2 * P["w"]}
        if self.linear_only:
            G.update(W=np.zeros_like(P["W"]), c=np.zeros_like(P["c"]), v=np.zeros_like(P["v"]))
            return G
        G["v"] = dz @ (ha - hb) + self.l2 * P["v"]
        da = (dz[:, None] * P["v"][None, :]) * (1 - ha ** 2)
        db = (dz[:, None] * P["v"][None, :]) * (1 - hb ** 2)
        G["W"] = da.T @ Xa - db.T @ Xb + self.l2 * P["W"]
        G["c"] = da.sum(0) - db.sum(0)
        return G

    def fit(self, Xa, Xb, wa, wb, t, weight=None):
        """Xa/Xb raw features (n, d); wa/wb maps won; t times (for the split)."""
        self.std = Standardizer().fit(np.vstack([Xa, Xb]))
        Xa, Xb = self.std(Xa), self.std(Xb)
        wa = wa.astype(float) * (weight if weight is not None else 1.0)
        wb = wb.astype(float) * (weight if weight is not None else 1.0)
        order = np.argsort(t)
        cut = order[: int(len(order) * 0.85)]
        val = order[int(len(order) * 0.85):]
        self._init(Xa.shape[1])
        m = {k: np.zeros_like(v) for k, v in self.P.items()}
        s2 = {k: np.zeros_like(v) for k, v in self.P.items()}
        rng = np.random.default_rng(self.seed)
        best, best_P, bad, step = np.inf, None, 0, 0
        for ep in range(self.epochs):
            perm = rng.permutation(cut)
            for i in range(0, len(perm), self.batch):
                b = perm[i:i + self.batch]
                G = self._grads(Xa[b], Xb[b], wa[b], wb[b])
                step += 1
                for k in self.P:
                    m[k] = 0.9 * m[k] + 0.1 * G[k]
                    s2[k] = 0.999 * s2[k] + 0.001 * G[k] ** 2
                    mh = m[k] / (1 - 0.9 ** step)
                    vh = s2[k] / (1 - 0.999 ** step)
                    self.P[k] -= self.lr * mh / (np.sqrt(vh) + 1e-8)
            vl = map_logloss(self.strength(Xa[val]) - self.strength(Xb[val]), wa[val], wb[val])
            if vl < best - 1e-5:
                best, best_P, bad = vl, {k: v.copy() for k, v in self.P.items()}, 0
            else:
                bad += 1
                if bad >= 25:
                    break
        self.P = best_P
        self.val_loss = best
        # Refit briefly on everything? Keep early-stopped weights: the
        # validation slice is the most recent data, so it is already used
        # for selection only; the bias this leaves is small.
        return self

    def predict_strength(self, X):
        return self.strength(self.std(np.asarray(X, dtype=float)))

    def predict(self, Xa, Xb):
        return _sig(self.predict_strength(Xa) - self.predict_strength(Xb))


class GlickoOnly:
    """Baseline: the Glicko rating alone (feature 0), with a fitted scale."""

    def fit(self, Xa, Xb, wa, wb, t, weight=None):
        d = Xa[:, 0] - Xb[:, 0]
        best = (np.inf, 1.0)
        for k in np.linspace(0.5, 1.5, 41):
            ll = map_logloss(k * d, wa, wb)
            best = min(best, (ll, k))
        self.k = best[1]
        return self

    def predict_strength(self, X):
        return self.k * np.asarray(X)[:, 0]

    def predict(self, Xa, Xb):
        return _sig(self.predict_strength(Xa) - self.predict_strength(Xb))


class RankOnly:
    """Baseline: HLTV ranking points only."""

    def fit(self, Xa, Xb, wa, wb, t, weight=None):
        d = Xa[:, 4] - Xb[:, 4]
        best = (np.inf, 1.0)
        for k in np.linspace(0.05, 2.0, 79):
            best = min(best, (map_logloss(k * d, wa, wb), k))
        self.k = best[1]
        return self

    def predict_strength(self, X):
        return self.k * np.asarray(X)[:, 4]

    def predict(self, Xa, Xb):
        return _sig(self.predict_strength(Xa) - self.predict_strength(Xb))

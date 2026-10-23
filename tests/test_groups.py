import numpy as np

from sportsan.tracking.groups import (FEATURES, GroupClassifier, classify, features, goalkeeper_group, group_doubts,
                                      hex_to_lab, truth_groups)
from sportsan.tracking.tracklets import Box, Tracklet


def tk(i, track, lab, x, y, team="own", n=20, start=0, crowd=(False, False)):
    boxes = [Box(start + k, track, 0, 0, 20, 60, lab, x, y, team, True) for k in range(n)]
    return Tracklet(i, track, boxes, *crowd)


def test_truth_groups():
    labels = {"people": [{"label": 1, "team": "own"}, {"label": 2, "team": "opp"}, {"label": 3, "team": "ref"}, {"label": 4, "team": "unk"}],
              "frames": [{"frame": 0, "boxes": [{"track": 1, "label": 1, "status": "player"}, {"track": 2, "label": 2, "status": "player"},
                                                {"track": 3, "label": 3, "status": "player"}, {"track": 4, "label": 4, "status": "player"},
                                                {"track": 5, "label": 9, "status": "removed"}]}]}
    assert truth_groups(labels) == {(0, 1): "propias", (0, 2): "rivales", (0, 3): "arbitros", (0, 5): "fuera"}


def test_classify_separates_groups():
    rng = np.random.default_rng(0)
    ts, y = [], []
    for i in range(60):
        g = ["propias", "rivales", "arbitros", "fuera"][i % 4]
        lab = {"propias": (100, 120, 130), "rivales": (40, 128, 128), "arbitros": (180, 110, 160), "fuera": (90, 128, 128)}[g]
        team = {"propias": "own", "rivales": "opp", "arbitros": "ref", "fuera": "unk"}[g]
        pos = (-5, -5) if g == "fuera" else (rng.uniform(10, 90), rng.uniform(10, 55))
        ts.append(tk(i, i, tuple(np.array(lab) + rng.normal(0, 2, 3)), *pos, team=team))
        y.append(g)
    m = GroupClassifier().fit(np.array([features(t, 105, 68, 30) for t in ts]), y)
    g, p = classify(ts, m, 105, 68, 30)
    assert g == y and (p > 0.9).all()


def test_goalkeeper_rule_needs_seeds_and_goal():
    seeds = {"own": "#5c5a72", "own_gk": "#d84242"}
    f = np.zeros(len(FEATURES))
    f[:3] = hex_to_lab("#d84242")
    f[FEATURES.index("goal_dist_m")] = 5
    assert goalkeeper_group("propias", f, seeds) == "porteras_propias"
    assert goalkeeper_group("propias", f, None) == "propias"
    f[FEATURES.index("goal_dist_m")] = 40
    assert goalkeeper_group("propias", f, seeds) == "propias"
    f[FEATURES.index("goal_dist_m")] = 5
    f[:3] = hex_to_lab("#5c5a72")
    assert goalkeeper_group("propias", f, seeds) == "propias"


def test_doubt_only_without_crossing():
    a, b = tk(0, 7, (0, 0, 0), 0, 0), tk(1, 7, (0, 0, 0), 0, 0, start=30)
    c, d = tk(2, 8, (0, 0, 0), 0, 0), tk(3, 8, (0, 0, 0), 0, 0, start=30, crowd=(True, False))
    assert group_doubts([a, b, c, d], ["propias", "fuera", "propias", "fuera"]) == {0, 1}


def test_overlap_features_and_detector():
    from sportsan.tracking.groups import DuplicateDetector, OVERLAP_FEATURES, overlap_features

    def bx(frame, track, x1, h, xm, lab=(100, 120, 130)):
        return Box(frame, track, x1, 100 - h, x1 + h / 2, 100, lab, xm, 10.0, "own", True)

    rng = np.random.default_rng(1)
    ts, frames = [], []
    for i in range(80):
        dup = i % 2 == 0
        rows_t = []
        main = [bx(f, 1000 + i, 0, 80, 20.0) for f in range(10)]
        # duplicate: a smaller box inside a bigger one of the same color; otherwise a lone box far away
        extra = [bx(f, 5000 + i, 2 if dup else 400, 60 if dup else 80, 20.3 if dup else 60.0) for f in range(10)]
        frames_i = [[m, e] for m, e in zip(main, extra)]
        t = Tracklet(i, 5000 + i, extra)
        ts.append(t)
        frames.append(frames_i)
    X, y = [], []
    for i, (t, fr) in enumerate(zip(ts, frames)):
        o = overlap_features([t], fr)[0]
        assert o.shape == (len(OVERLAP_FEATURES),)
        X.append(o + rng.normal(0, 0.01, len(o)))
        y.append(i % 2 == 0)
    X, y = np.array(X), np.array(y)
    det = DuplicateDetector().fit(X, y)
    assert (det.predict(X) == y).mean() > 0.95

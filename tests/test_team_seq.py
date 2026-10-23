import numpy as np

from sportsan.tracking.anchors import Chain, fill_between
from sportsan.tracking.team_seq import (
    FEATURE_NAMES,
    SeqModel,
    StaticModel,
    features,
    mahalanobis2,
    match_roles,
    resolve_roles,
    seq_context,
    seq_cost,
    to_field,
    to_relative_m,
)
from sportsan.tracking.tracklets import Box, Tracklet


def _box(frame, track, x, y, team):
    return Box(frame, track, 0, 0, 10, 30, (50, 0, 0), x, y, team, True)


def _frames(n=40, fps=10.0, shift=0.0):
    """Dos equipos de 6 en línea; el propio se desplaza `shift` m por cuadro en x."""
    out = []
    for i in range(n):
        f = i * 3
        row = [_box(f, k, 20 + 5 * k + shift * i, 10 + 8 * k, "own") for k in range(6)]
        row += [_box(f, 100 + k, 60 + 5 * k, 12 + 8 * k, "opp") for k in range(6)]
        out.append(row)
    return out


def test_resolve_roles_keeps_two_zoes_apart():
    roles = {"GK": "Zoe S.", "MCO_izq": "Zoe", "LB": "ivonne", "X": "Nadie"}
    out = resolve_roles(roles, ["Zoe", "Zoe S.", "Ivonne", "Kat"])
    assert out == {"GK": "Zoe S.", "MCO_izq": "Zoe", "LB": "Ivonne"}


def test_context_ball_lags_only_from_reviewed_ball():
    fr = _frames()
    ctx = seq_context(fr, {30: (50.0, 30.0)}, 105, 68, fps=10.0)
    i = ctx.index[30]
    assert np.allclose(ctx.ball[i, 0], (50, 30))
    assert np.isnan(ctx.ball[ctx.index[90], 0]).all()       # sin balón: NaN, nunca inventado
    assert np.allclose(ctx.ball[ctx.index[81], 3], (50, 30))  # 81 - 5 s * 10 fps = 31, a 1 cuadro de la marca


def test_features_shape_and_roundtrip():
    fr = _frames()
    ctx = seq_context(fr, None, 105, 68, fps=10.0)
    idx = np.array([0, 5, 10])
    X, base, ok = features(ctx, idx, np.array([[0.5, -0.5]] * 3))
    assert X.shape == (3, len(FEATURE_NAMES)) and ok.all()
    xy = np.array([[30.0, 20.0]] * 3)
    assert np.allclose(to_field(ctx, idx, to_relative_m(ctx, idx, xy)), xy)
    _, _, ok2 = features(ctx, idx, np.array([[np.nan, 0]] * 3))
    assert not ok2.any()


def test_seq_model_learns_ball_dependence_better_than_static():
    """Sintético: la jugadora se corre hacia el balón (y) con su rol fijo; la red con balón lo capta y la estática no."""
    rng = np.random.default_rng(1)
    fr = _frames(n=400)
    ball = {f * 3: (50.0, float(rng.uniform(5, 63))) for f in range(400)}
    ctx = seq_context(fr, ball, 105, 68, fps=10.0)
    idx = np.arange(400)
    role = np.tile([[0.0, 0.0]], (400, 1))
    X, base, ok = features(ctx, idx, role)
    by = ctx.ball[idx, 0, 1]
    target_xy = np.column_stack([ctx.own[idx, 0], 0.5 * by + 0.5 * ctx.own[idx, 1]])
    T = to_relative_m(ctx, idx, target_xy)
    st = StaticModel().fit(X, base, T)
    sq = SeqModel(epochs=1500, hidden=32, lr=1e-2).fit(X, base, T)
    e_st = np.hypot(*(st.predict(X, base)[0] - T).T).mean()
    e_sq = np.hypot(*(sq.predict(X, base)[0] - T).T).mean()
    assert e_sq < 0.5 * e_st
    mu, var = sq.predict(X, base)
    assert (var > 0).all() and np.isfinite(mahalanobis2(T, mu, var)).all()


def test_seq_cost_caps_and_zero_for_nan():
    c = seq_cost(np.array([0.0, 4.0, 1e6, np.nan]), 1.0)
    assert np.allclose(c, [0.0, 2.0, 8.0, 0.0])


def test_match_roles_hungarian():
    out = match_roles({"a": np.array([0.0, 1.0]), "b": np.array([0.0, -1.0])},
                      {"LB": np.array([0.0, 0.9]), "RB": np.array([0.0, -0.9])})
    assert out["a"][0] == "LB" and out["b"][0] == "RB"


def test_fill_between_extra_cost_changes_assignment():
    def chain(i, f0, f1, x, y):
        boxes = [_box(f, 500 + i, x, y, "own") for f in range(f0, f1, 3)]
        return Chain(i, Tracklet(id=-1, track=500 + i, boxes=boxes), i, i, "own")

    # Dos anclas en el mismo sitio; la cadena nueva es igual de alcanzable para las dos.
    chs = [chain(0, 0, 30, 10, 10), chain(1, 0, 30, 10, 12), chain(2, 36, 60, 10, 11)]
    team = {1: "own", 2: "own"}
    base = fill_between(chs, {0: 1, 1: 2}, 30.0, {}, team, unnamed_cost=10.0)
    who = base.owner.get(2)
    other = 2 if who == 1 else 1
    pushed = fill_between(chs, {0: 1, 1: 2}, 30.0, {}, team, unnamed_cost=10.0,
                          extra_cost=lambda cid, p: 5.0 if (cid, p) == (2, who) else 0.0)
    assert pushed.owner.get(2) == other

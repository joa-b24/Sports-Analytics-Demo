import numpy as np

from sportsan.tracking.priors import (
    BALL_FEATURES,
    FORMATION_FEATURES,
    auc,
    ball_track,
    ball_zone,
    fit_formation,
    orientation,
    part_context,
    prior_features,
    relative,
    team_shape,
)
from sportsan.tracking.tracklets import Box, Candidate, Tracklet

# Formación sintética: 6 jugadoras en una línea a lo ancho y una portera atrás; el bloque se mueve a lo largo.
SLOTS = {"A": (0, 10), "B": (0, 20), "C": (0, 30), "D": (0, 40), "E": (0, 50), "GK": (-25, 30)}


def fixed_part(n_frames=60, flip=False, ball=True, seed=0):
    rng = np.random.default_rng(seed)
    people = [{"id": i + 1, "team": "own", "player_id": name, "tracks": [i + 1]} for i, name in enumerate(SLOTS)]
    frames, balls = [], []
    for f in range(n_frames):
        cx = 40 + 20 * np.sin(f / 10)
        pos = []
        for i, (dx, y) in enumerate(SLOTS.values()):
            x = cx + dx + rng.normal(0, 0.5)
            yy = y + rng.normal(0, 0.5)
            if flip:
                x, yy = 105 - x, 68 - yy
            pos.append({"id": i + 1, "x": float(x), "y": float(yy), "source": "auto"})
        frames.append({"frame": f * 3, "positions": pos})
        if ball and f % 5 == 0:
            balls.append({"frame": f * 3, "x": float(cx + 10), "y": 34.0, "source": "manual"})
    return {"fps": 30.0, "venue": {"length_m": 105, "width_m": 68}, "people": people, "frames": frames, "ball": balls}


def test_shape_needs_enough_players_and_never_divides_by_zero():
    assert team_shape(np.array([[1.0, 1.0]] * 4)) is None
    s = team_shape(np.array([[10.0, 5.0]] * 6))
    assert s[:2] == (10.0, 5.0) and s[2] > 0 and s[3] > 0
    assert np.isnan(relative(np.nan, 1, s, 1)).all()


def test_orientation_follows_the_goalkeeper():
    xy = np.array([[50, 10], [50, 20], [50, 30], [50, 40], [50, 50], [20, 30]], dtype=float)
    assert orientation([xy]) == 1.0
    assert orientation([np.array([[105 - x, y] for x, y in xy])]) == -1.0


def test_ball_only_from_hand_marks_and_close_interpolation():
    fixed = {"fps": 30, "ball": [
        {"frame": 0, "x": 1, "y": 1, "source": "manual"},
        {"frame": 3, "x": 2, "y": 1, "source": "interpolated"},
        {"frame": 6, "x": 3, "y": 1, "source": "manual"},
        {"frame": 9, "x": 4, "y": 1, "source": "interpolated"},
        {"frame": 12, "x": 5, "y": 1, "source": "auto"},           # tracker: nunca
        {"frame": 300, "x": 6, "y": 1, "source": "manual"},
        {"frame": 303, "x": 7, "y": 1, "source": "interpolated"},  # entre marcas a más de 2 s
        {"frame": 400, "x": 8, "y": 1, "source": "manual"},
    ]}
    assert sorted(ball_track(fixed)) == [0, 3, 6, 300, 400]


def test_zone_is_rotated_with_the_team():
    assert ball_zone(100, 5, 105, 68, 1) == 2 * 3 + 0
    assert ball_zone(100, 5, 105, 68, -1) == 0 * 3 + 2
    assert ball_zone(np.nan, 5, 105, 68, 1) is None


def test_formation_cost_prefers_the_right_player_even_when_sides_change():
    m = fit_formation([fixed_part(seed=1)])
    assert set(m.roster("own")) == set(SLOTS)
    # Segunda parte con lados cambiados: la orientación la deja en el mismo sitio relativo.
    f2 = fixed_part(flip=True, seed=2)
    from sportsan.tracking.priors import formation_samples

    right = wrong = 0
    for t, p, r, z in formation_samples(f2):
        costs = {q: m.cost("own", q, r) for q in m.roster("own")}
        right += min(costs, key=costs.get) == p
        wrong += min(costs, key=costs.get) != p
    assert right > 0.95 * (right + wrong)
    assert np.isnan(m.cost("own", "A", np.array([np.nan, 0.0])))
    assert np.isnan(m.cost("own", "nadie", np.zeros(2)))


def _boxes_from_fixed(fixed, keep=lambda f, pid: True):
    rows = []
    for fr in fixed["frames"]:
        rows.append([Box(fr["frame"], p["id"], 0, 0, 10, 30, (50, 0, 0), p["x"], p["y"], "own", True)
                     for p in fr["positions"] if keep(fr["frame"], p["id"])])
    return rows


def test_prior_features_tell_same_player_from_another():
    model = fit_formation([fixed_part(seed=3)])
    test = fixed_part(seed=4)
    frames = _boxes_from_fixed(test)
    ctx = part_context(frames, ball_track(test), 105, 68)
    # Trozo a: jugadora B hasta el cuadro 90; b1: B desde el 96 (misma); b2: C desde el 96 (otra).
    by = lambda pid, lo, hi: [b for row in frames for b in row if b.track == pid and lo <= b.frame <= hi]  # noqa: E731
    a = Tracklet(0, 2, by(2, 60, 90))
    b1 = Tracklet(1, 2, by(2, 96, 120))
    b2 = Tracklet(2, 3, by(3, 96, 120))
    cands = [Candidate(0, 1, np.zeros(1)), Candidate(0, 2, np.zeros(1))]
    X = prior_features(cands, [a, b1, b2], ctx, model, 30.0, use_ball=True)
    assert X.shape == (2, len(FORMATION_FEATURES) + len(BALL_FEATURES))
    same, dr = FORMATION_FEATURES.index("form_same"), FORMATION_FEATURES.index("form_dr")
    assert X[0, same] > 0.8 > X[1, same]
    assert X[0, dr] < X[1, dr]
    assert np.isfinite(X[0, len(FORMATION_FEATURES)])          # hay balón cerca de esos cuadros
    # Sin modelo de formación ni balón: NaN, nunca un valor inventado.
    from sportsan.tracking.priors import FormationModel

    X0 = prior_features(cands, [a, b1, b2], part_context(frames, None, 105, 68), FormationModel(), 30.0, use_ball=True)
    assert np.isnan(X0).all()


def test_auc():
    assert auc(np.array([0.9, 0.8, 0.1]), np.array([1, 1, 0])) == 1.0
    assert auc(np.array([0.5, 0.5]), np.array([1, 0])) == 0.5

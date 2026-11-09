import numpy as np

from sportsan.tracking.tracklets import (
    LOOSE_ID,
    Box,
    Candidate,
    TreeModel,
    accept_greedy,
    candidate_labels,
    chains,
    link_candidates,
    pure_tracklets,
    score_groups,
    tracklet_truth,
)

FPS = 30.0


def box(frame, track, x, y, h=100.0, lab=(50, 130, 130), team="own"):
    # A box of height h whose feet are at (x, y) metres; pixels only matter for overlaps and size.
    px = x * 20
    return Box(frame=frame, track=track, x1=px - 20, y1=500 - h, x2=px + 20, y2=500, lab=lab, xm=x, ym=y, team=team, on_pitch=True)


def frames_of(boxes):
    rows = {}
    for b in boxes:
        rows.setdefault(b.frame, []).append(b)
    return [rows[f] for f in sorted(rows)]


def test_a_crossing_cuts_the_track_and_isolated_runs_stay_whole():
    # Track 1 runs alone, then passes next to track 2 (closer than 1.2 m) and goes on alone.
    boxes = []
    for i in range(30):
        f = i * 3
        x1 = 10 + 0.2 * i
        boxes.append(box(f, 1, x1, 30))
        boxes.append(box(f, 2, 14, 30 if 12 <= i <= 16 else 40))
    tl = pure_tracklets(frames_of(boxes), FPS)
    pieces_1 = [t for t in tl if t.track == 1]
    assert len(pieces_1) == 3  # before, during and after the crossing
    assert any(t.crowded_start and t.crowded_end for t in pieces_1)


def test_size_jump_and_impossible_speed_cut():
    boxes = [box(i * 3, 1, 10, 30, h=100) for i in range(10)] + [box(30 + i * 3, 1, 10, 30, h=160) for i in range(10)]
    assert len(pure_tracklets(frames_of(boxes), FPS)) == 2
    boxes = [box(i * 3, 1, 10, 30) for i in range(10)] + [box(30 + i * 3, 1, 40, 30) for i in range(10)]
    assert len(pure_tracklets(frames_of(boxes), FPS)) == 2


def test_loose_boxes_are_their_own_tracklets():
    boxes = [box(0, LOOSE_ID + 1, 10, 30), box(3, LOOSE_ID + 2, 10.1, 30)]
    tl = pure_tracklets(frames_of(boxes), FPS)
    assert len(tl) == 2 and all(len(t.boxes) == 1 for t in tl)


def test_candidates_follow_the_motion_and_skip_the_other_team():
    a = [box(i * 3, 1, 10 + 0.2 * i, 30) for i in range(10)]
    b = [box(30 + 6 + i * 3, 2, 12.4 + 0.2 * i, 30) for i in range(10)]
    rival = [box(30 + 6 + i * 3, 3, 12.4, 30.5, team="opp") for i in range(10)]
    tl = pure_tracklets(frames_of(a + b + rival), FPS)
    cands = link_candidates(tl, FPS)
    ids = {t.track: t.id for t in tl}
    pairs = {(c.a, c.b) for c in cands}
    assert (ids[1], ids[2]) in pairs
    assert (ids[1], ids[3]) not in pairs


def test_labels_ignore_tracklets_that_are_not_players():
    a = [box(i * 3, 1, 10, 30) for i in range(5)]
    b = [box(18 + i * 3, 2, 10.3, 30) for i in range(5)]
    c = [box(18 + i * 3, 3, 10.6, 30) for i in range(5)]
    tl = pure_tracklets(frames_of(a + b + c), FPS)
    truth = {(x.frame, x.track): 7 for x in a + b}
    truth.update({(x.frame, x.track): "no" for x in c})
    cands = link_candidates(tl, FPS)
    y = candidate_labels(cands, tl, truth)
    who = {t.id: tracklet_truth(t, truth)[0] for t in tl}
    for cand, yi in zip(cands, y):
        if "no" in (who[cand.a], who[cand.b]):
            assert yi == -1
        else:
            assert yi == 1


def test_greedy_accepts_one_to_one_and_abstains_below_the_threshold():
    cands = [Candidate(0, 1, np.zeros(1), 0.995), Candidate(0, 2, np.zeros(1), 0.994), Candidate(3, 2, np.zeros(1), 0.993), Candidate(4, 5, np.zeros(1), 0.5)]
    acc = accept_greedy(cands, p_min=0.99)
    assert [(c.a, c.b) for c in acc] == [(0, 1), (3, 2)]
    assert accept_greedy(cands, p_min=0.99, allowed={0, 1}) == [cands[0]]
    ident = chains(6, acc)
    assert ident[0] == ident[1] and ident[3] == ident[2] and ident[0] != ident[3]


def test_tree_model_learns_a_threshold_rule():
    rng = np.random.default_rng(0)
    X = rng.uniform(0, 10, size=(2000, 2))
    y = ((X[:, 0] < 3) & (X[:, 1] > 5)).astype(float)
    m = TreeModel(trees=40).fit(X, y)
    p = m.predict(np.array([[1.0, 8.0], [8.0, 8.0], [1.0, 1.0]]))
    assert p[0] > 0.9 and p[1] < 0.1 and p[2] < 0.1
    m2 = TreeModel.from_dict(m.to_dict())
    assert np.allclose(m2.predict(X[:50]), m.predict(X[:50]))


def test_score_counts_purity_joins_and_cuts():
    truth = {(0, 1): 7, (3, 1): 7, (6, 1): 8, (0, 2): 8, (3, 2): "no"}
    # One group mixes 7 then 8 (a cut), person 8 is in two groups (a join).
    s = score_groups({(0, 1): 0, (3, 1): 0, (6, 1): 0, (0, 2): 1, (3, 2): 1}, truth)
    assert s.boxes_known == 4
    assert s.impure_boxes == 1
    assert s.cuts_needed == 1
    assert s.joins_needed == 1


def _runner(track, t0_frame, n, x0, speed, team="own"):
    # n boxes, one every 3 frames (0.1 s), moving along x at `speed` m/s.
    return [box(t0_frame + 3 * i, track, x0 + speed * 0.1 * i, 30, team=team) for i in range(n)]


def test_a_standing_player_cannot_join_a_runner_that_appears_2_m_away_0_3_s_later():
    from sportsan.tracking.tracklets import FEATURES

    stand = [box(3 * i, 1, 10.0, 30) for i in range(10)]
    # 0.3 s after the last box (frame 27 + 9), 2 m away, already at 8 m/s.
    run = _runner(2, 27 + 9, 10, 12.0, 8.0)
    tl = pure_tracklets(frames_of(stand + run), FPS)
    ids = {t.track: t.id for t in tl}
    cands = link_candidates(tl, FPS)
    c = next(c for c in cands if (c.a, c.b) == (ids[1], ids[2]))
    assert c.x[FEATURES.index("accel_excess")] > 0
    assert (ids[1], ids[2]) not in {(c.a, c.b) for c in link_candidates(tl, FPS, accel_veto=True)}


def test_a_steady_runner_keeps_her_join_with_the_veto():
    from sportsan.tracking.tracklets import FEATURES

    a = _runner(1, 0, 10, 10.0, 5.0)
    # Same pace through a 0.3 s hole: she is where she would be.
    b = _runner(2, 27 + 9, 10, 10.0 + 5.0 * (0.9 + 0.3), 5.0)
    tl = pure_tracklets(frames_of(a + b), FPS)
    ids = {t.track: t.id for t in tl}
    cands = link_candidates(tl, FPS, accel_veto=True)
    c = next(c for c in cands if (c.a, c.b) == (ids[1], ids[2]))
    assert c.x[FEATURES.index("accel_excess")] <= 0

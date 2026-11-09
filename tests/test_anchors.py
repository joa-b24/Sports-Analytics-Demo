import numpy as np

from sportsan.tracking.anchors import (
    build_chains,
    fill_between,
    groups_after_fill,
    isolated,
    named_correct,
    camera_sign,
    in_goal_zone,
    lateral,
    person_hybrid_rates,
    pick_anchors,
    transition_cost,
    zone_edges,
    zone_of,
)
from sportsan.tracking.tracklets import Box, Tracklet

FPS = 30.0


def box(frame, track, x, y, team="own"):
    px = x * 20
    return Box(frame=frame, track=track, x1=px - 20, y1=400, x2=px + 20, y2=500, lab=(50, 130, 130), xm=x, ym=y, team=team, on_pitch=True)


def run(track, f0, f1, x0, y, vx=1.0, team="own"):
    """Trozo que corre a vx m/s en x desde x0, cada 3 cuadros."""
    return [box(f, track, x0 + vx * (f - f0) / FPS, y, team) for f in range(f0, f1, 3)]


def tracklets_of(runs):
    return [Tracklet(id=i, track=r[0].track, boxes=r) for i, r in enumerate(runs)]


def two_players():
    # Player 1 at y=10 and player 2 at y=50, each in three pieces with 1 s gaps.
    runs = []
    for y, base in ((10, 0), (50, 10)):
        runs += [run(base + 1, 0, 150, 5, y), run(base + 2, 180, 330, 12, y), run(base + 3, 360, 510, 18, y)]
    return tracklets_of(runs)


def test_chains_follow_links_and_keep_ends():
    from sportsan.tracking.tracklets import Candidate

    tl = two_players()
    chs = build_chains(tl, [Candidate(0, 1, np.zeros(1))])
    assert len(chs) == 5
    long = max(chs, key=lambda c: len(c.tl.boxes))
    assert (long.first, long.last) == (0, 1)


def test_fill_assigns_each_piece_to_the_right_player():
    tl = two_players()
    chs = build_chains(tl, [])
    truth = {(b.frame, b.track): (1 if c.tl.boxes[0].ym == 10 else 2) for c in chs for b in c.tl.boxes}
    first = {c.id: (1 if c.tl.boxes[0].ym == 10 else 2) for c in chs if c.start == 0}
    f = fill_between(chs, first, FPS, {}, {1: "own", 2: "own"})
    assert len(f.owner) == 6 and f.doubts_overlap == 0 and f.doubts_jump == 0
    tot, ok, bad = named_correct(chs, f.owner, truth, {1, 2})
    assert ok == tot and bad == 0
    from sportsan.tracking.tracklets import score_groups

    s = score_groups(groups_after_fill(chs, f.owner), truth)
    assert s.joins_needed == 0 and s.cuts_needed == 0


def test_fill_never_crosses_teams_and_respects_next_anchor():
    a = run(1, 0, 150, 5, 10)
    rival = run(2, 180, 330, 10, 10, team="opp")
    far = run(3, 180, 330, 60, 10)          # same team but cannot reach it in time
    b = run(4, 360, 510, 11, 10)
    chs = build_chains(tracklets_of([a, rival, far, b]), [])
    by_track = {c.tl.track: c.id for c in chs}
    f = fill_between(chs, {by_track[1]: 7, by_track[4]: 7}, FPS, {}, {7: "own"})
    assert by_track[2] not in f.owner and by_track[3] not in f.owner


def test_two_players_compete_for_one_piece():
    # Both players end near the same start; only the closer one takes it, and it counts as a doubt if they are similar.
    p1 = run(1, 0, 150, 5, 10)
    p2 = run(2, 0, 150, 5, 11)
    nxt = run(3, 180, 330, 10, 10.5)
    chs = build_chains(tracklets_of([p1, p2, nxt]), [])
    ids = {c.tl.track: c.id for c in chs}
    f = fill_between(chs, {ids[1]: 1, ids[2]: 2}, FPS, {}, {1: "own", 2: "own"})
    assert list(f.owner.values()).count(1) + list(f.owner.values()).count(2) == 3
    assert f.doubts_close == 1


def test_model_probability_lowers_cost():
    a, b = build_chains(tracklets_of([run(1, 0, 150, 5, 10), run(2, 180, 330, 10, 10)]), [])
    assert transition_cost(a, b, FPS, {(a.last, b.first): 0.99}) < transition_cost(a, b, FPS, {})
    assert transition_cost(b, a, FPS, {}) == np.inf


def test_anchors_only_long_isolated_pieces():
    alone = run(1, 0, 150, 5, 10)                 # 5 s, alone
    short = run(2, 150, 210, 30, 30)              # 2 s
    crowded = run(3, 0, 150, 40, 50)              # 5 s, someone 1 m away
    neighbour = run(4, 0, 150, 41, 50)
    chs = build_chains(tracklets_of([alone, short, crowded, neighbour]), [])
    rows = {}
    for c in chs:
        for b in c.tl.boxes:
            rows.setdefault(b.frame, []).append(b)
    truth = {(b.frame, b.track): b.track for c in chs for b in c.tl.boxes}
    ids = {c.tl.track: c.id for c in chs}
    assert isolated(next(c for c in chs if c.tl.track == 3), rows) is None
    anchors, empty = pick_anchors(chs, truth, rows, FPS, 0, 300, 3, {1, 2, 3})
    assert anchors == {ids[1]: 1}
    assert empty == 2  # 10 s is one slot of 20 s; players 2 and 3 have no valid piece


def test_backward_fill_names_pieces_before_the_first_anchor():
    from sportsan.tracking.anchors import fill_both

    tl = two_players()
    chs = build_chains(tl, [])
    # Anchor only the last piece of each player: the earlier two are filled backwards.
    last = {c.id: (1 if c.tl.boxes[0].ym == 10 else 2) for c in chs if c.start == 360}
    f = fill_both(chs, last, FPS, {}, {1: "own", 2: "own"})
    assert len(f.owner) == 6
    assert all(f.owner[c.id] == (1 if c.tl.boxes[0].ym == 10 else 2) for c in chs)
    assert f.doubts_overlap == 0 and f.doubts_jump == 0
    # A low unnamed_cost leaves everything unnamed except the anchors.
    assert len(fill_both(chs, last, FPS, {}, {1: "own", 2: "own"}, unnamed_cost=0.1).owner) == 2


def test_camera_sign_and_lateral_zones():
    near_big_y = [[Box(0, 1, 0, 100 + 10 * y, 10, 110 + 10 * y, (0, 0, 0), 5.0, float(y), "own", True) for y in range(0, 60, 5)]]
    assert camera_sign(near_big_y) == 1
    flipped = [[Box(0, 1, 0, 100 + 10 * y, 10, 110 + 10 * y, (0, 0, 0), 5.0, float(60 - y), "own", True) for y in range(0, 60, 5)]]
    assert camera_sign(flipped) == -1
    assert camera_sign([]) == 1
    assert lateral(60, 68, 1) < 1 / 3 < 2 / 3 < lateral(5, 68, 1)
    assert lateral(60, 68, -1) > 2 / 3
    assert [zone_of(u) for u in (0.1, 0.5, 0.9)] == ["near", "center", "far"]
    a, b = zone_edges([0.1, 0.2, 0.3, 0.8, 0.9, 0.95], "quantiles")
    assert 0.2 < a < b < 0.9
    assert zone_edges([0.1], "quantiles") == (1 / 3, 2 / 3)
    assert in_goal_zone(3, 34, 105, 68) and in_goal_zone(102, 40, 105, 68) and not in_goal_zone(3, 5, 105, 68)
    assert not in_goal_zone(float("nan"), 34, 105, 68)


def test_hybrid_rates_by_person_and_goalkeeper_capped():
    runs = [run(1, 0, 300, 40, 60), run(2, 0, 300, 40, 30), run(3, 0, 300, 40, 8), run(4, 0, 300, 3, 34, vx=0)]
    chs = build_chains(tracklets_of(runs), [])
    truth = {(b.frame, b.track): b.track for r in runs for b in r}
    rates, zones, edges = person_hybrid_rates(chs, truth, {1, 2, 3, 4}, 1, 105, 68, {"near": 2, "center": 3, "far": 4})
    assert zones == {1: "near", 2: "center", 3: "far", 4: "center"}
    assert rates[1] == 2 and rates[2] == 3 and rates[3] == 4
    assert rates[4] == 2                                   # portera en el centro: 2, no 3
    rates_g, zones_g, _ = person_hybrid_rates(chs, truth, {3, 4}, 1, 105, 68, {"near": 5, "center": 5, "far": 5})
    assert rates_g[4] == 2 and rates_g[3] == 5            # la portera nunca pide más de 2


def test_pick_anchors_with_per_person_rates_gives_more_to_higher_rate():
    # Cada persona tiene una cadena de 5 s cada 15 s durante 120 s.
    runs, truth = [], {}
    for person, y in ((1, 60), (2, 8)):
        for k in range(8):
            r = run(person * 100 + k, k * 450, k * 450 + 150, 30, y)
            runs.append(r)
            truth.update({(b.frame, b.track): person for b in r})
    chs = build_chains(tracklets_of(runs), [])
    rows = {b.frame: [b] for r in runs for b in r}
    low, _ = pick_anchors(chs, truth, rows, FPS, 0, 3600, {1: 1.0, 2: 4.0}, {1, 2})
    n1 = sum(1 for v in low.values() if v == 1)
    n2 = sum(1 for v in low.values() if v == 2)
    assert n2 > n1 >= 1
    same, _ = pick_anchors(chs, truth, rows, FPS, 0, 3600, 2.0, {1, 2})
    same_d, _ = pick_anchors(chs, truth, rows, FPS, 0, 3600, {1: 2.0, 2: 2.0}, {1, 2})
    assert same == same_d

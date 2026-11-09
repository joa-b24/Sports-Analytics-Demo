"""Cobertura y tiempo de la analista (sportsan.tracking.coverage) con cadenas sintéticas."""
from __future__ import annotations

import math

from sportsan.tracking.anchors import Chain
from sportsan.tracking.coverage import (
    ERR,
    FILL,
    HOLE,
    OK,
    at_edge,
    bridge_possible,
    bridges,
    frame_status,
    hole_class,
    hole_runs,
    person_coverage,
    review_seconds,
    to_match_hours,
)
from sportsan.tracking.tracklets import Box, Tracklet

FPS = 30.0


def box(frame: int, x: float, y: float = 10.0, track: int = 1) -> Box:
    return Box(frame, track, 0, 0, 10, 20, (0, 0, 0), x, y, "own", True)


def chain(cid: int, f0: int, f1: int, x0: float, x1: float, step: int = 3) -> Chain:
    """Cadena recta que va de x0 a x1 entre los cuadros f0 y f1."""
    frames = list(range(f0, f1 + 1, step))
    boxes = [box(f, x0 + (x1 - x0) * (f - f0) / max(1, f1 - f0)) for f in frames]
    return Chain(cid, Tracklet(id=-1, track=cid, boxes=boxes), cid, cid, "own")


def test_bridge_feasible_and_impossible():
    a = chain(0, 0, 30, 0, 5)                       # 5 m/ 1 s, termina en x=5
    near = chain(1, 90, 150, 12, 18)                # 2 s después, a 7 m: posible
    far = chain(2, 90, 150, 60, 66)                 # 55 m en 2 s: imposible
    assert bridge_possible(a, near, FPS)
    assert not bridge_possible(a, far, FPS)


def test_bridge_longer_than_four_seconds_not_filled():
    a = chain(0, 0, 30, 0, 0)
    ok = chain(1, 30 + 120, 300, 0, 0)              # 4.0 s justo
    late = chain(2, 30 + 121, 300, 0, 0)            # 4.03 s
    assert bridge_possible(a, ok, FPS)
    assert not bridge_possible(a, late, FPS)


def test_bridges_chains_sorted_and_overlap_skipped():
    a, b = chain(0, 0, 30, 0, 0), chain(1, 60, 90, 1, 1)
    c = chain(2, 80, 120, 1, 1)                     # se solapa con b
    assert bridges([b, a], FPS) == [(30, 60)]
    assert (90, 80) not in bridges([a, b, c], FPS)


def test_frame_status_ok_fill_err_hole():
    owner = {0: 7, 3: 7, 6: None, 9: None, 12: 8, 30: None}
    st = frame_status([0, 3, 6, 9, 12, 30], owner, 7, [(3, 10)])
    assert st == {0: OK, 3: OK, 6: FILL, 9: FILL, 12: ERR, 30: HOLE}


def test_hole_runs_split_by_other_state_and_by_absence():
    st = {0: HOLE, 3: HOLE, 6: OK, 9: HOLE, 12: HOLE, 30: HOLE}      # 12 -> 30: salió de cuadro según labels
    assert hole_runs(st, 3) == [(0, 3, 2), (9, 12, 2), (30, 30, 1)]


def test_person_coverage_counts_fill_as_correct_and_err_apart():
    step = 3
    # cuadros 0..99: 0-29 ok, 30-59 sin nombre con puente, 60-69 de otra, 70-99 sin nombre y sin puente (1 s).
    frames = list(range(0, 100, step))
    owner = {}
    for f in frames:
        owner[f] = 7 if f < 30 else None if f < 60 else 8 if f < 70 else None
    c = person_coverage(7, frames, owner, [(29, 60)], lambda f: False, step, FPS)
    sec = step / FPS
    assert math.isclose(c.in_s, len(frames) * sec)
    assert math.isclose(c.ok_s, 10 * sec)
    assert math.isclose(c.fill_s, 10 * sec)
    assert math.isclose(c.err_s, 4 * sec)
    assert math.isclose(c.hole_s, 10 * sec)
    assert math.isclose(c.coverage, 20 / len(frames))
    assert len(c.holes) == 1 and c.holes[0][1] is False
    assert math.isclose(c.ok_s + c.fill_s + c.err_s + c.hole_s, c.in_s)


def test_hole_classes_and_edge_split():
    step = 3
    frames = list(range(0, 600, step))                 # 20 s sin nombre
    owner = {f: None for f in frames}
    c = person_coverage(1, frames, owner, [], lambda f: f == frames[-1], step, FPS)
    assert hole_class(c.holes[0][0]) == ">15"
    assert c.holes[0][1] is True                       # el último cuadro está en el borde
    assert c.holes_to_review() == 0                    # por fuera de cuadro: no se revisa
    c2 = person_coverage(1, frames, owner, [], lambda f: False, step, FPS)
    assert c2.holes_to_review() == 1
    assert c2.holes_by_class()[">15"] == (1, 0)


def test_hole_class_boundaries():
    assert hole_class(4.0) == "≤4" and hole_class(4.1) == "4-15"
    assert hole_class(15.0) == "4-15" and hole_class(15.1) == ">15"


def test_at_edge():
    inside = Box(0, 1, 500, 300, 560, 420, (0, 0, 0), 0, 0, "own", True)
    left = Box(0, 1, 10, 300, 70, 420, (0, 0, 0), 0, 0, "own", True)
    right = Box(0, 1, 1700, 300, 1900, 420, (0, 0, 0), 0, 0, "own", True)
    assert not at_edge(inside, 1920, 1080)
    assert at_edge(left, 1920, 1080) and at_edge(right, 1920, 1080)


def test_review_seconds_and_scaling():
    assert review_seconds(10, 2, 3, 1) == 2 * 10 + 3 * 6
    # 19 min medidos, 3800 s de revisión -> a 90 min
    assert math.isclose(to_match_hours(3600.0, 45 * 60), 3600 * 2 / 3600)

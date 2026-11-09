"""Relleno por tramos (tracking/segments.py y `segments` de links_*_exp): fixtures sintéticos, sin GPU ni archivos."""
import json

import numpy as np

from sportsan.tracking.anchors import build_chains
from sportsan.tracking.anchors_cli import Prepared, fill_part
from sportsan.tracking.segments import (SegmentPolicy, accepts, conflicts, reachable, segment_boxes, selected_boxes,
                                        to_segments)
from sportsan.tracking.tracklets import Box, Candidate, Tracklet

FPS = 30.0


def box(frame, track, x, y):
    px = x * 20
    return Box(frame=frame, track=track, x1=px - 20, y1=400, x2=px + 20, y2=500, lab=(50, 130, 130), xm=x, ym=y, team="own", on_pitch=True)


def run(track, f0, f1, x0, y, vx=1.0):
    return [box(f, track, x0 + vx * (f - f0) / FPS, y) for f in range(f0, f1, 3)]


def prep_of(runs, links=(), stride=3):
    tl = [Tracklet(id=i, track=r[0].track, boxes=r) for i, r in enumerate(runs)]
    chs = build_chains(tl, list(links))
    last = max(b.frame for r in runs for b in r)
    frames = [[b for r in runs for b in r if b.frame == f] for f in range(0, last + 1, stride)]
    rows = {r[0].frame: r for r in frames if r}
    return Prepared("t", FPS, frames, chs, {c.id for c in chs}, {}, rows, (1920.0, 1080.0), {}, stride=stride)


def link(a, b, p):
    return Candidate(a=a, b=b, x=np.zeros(1), p=p)


def test_track_claimed_by_two_players_goes_to_each_owner_without_overlap():
    # Un mismo track (7) lo cortó el cuadro 90 en dos trozos puros: el primero es de A (y=10), el segundo de B (y=50).
    runs = [run(7, 0, 90, 5, 10), run(7, 90, 180, 8, 50)]
    prep = prep_of(runs)
    anchors = [{"frame": 30, "track": 7, "player": "A"}, {"frame": 150, "track": 7, "player": "B"}]
    out = fill_part(prep, anchors, variant="exp").out
    ids = {i["player"]: i for i in out["identities"]}
    assert ids["A"]["tracks"] == ids["B"]["tracks"] == [7]            # campos de siempre intactos
    assert ids["A"]["segments"] == [[7, 0, 87]] and ids["B"]["segments"] == [[7, 90, 177]]
    assert out["segments_summary"]["conflicts"] == 0 and conflicts(out["identities"]) == 0
    json.dumps(out)


def test_contiguous_pieces_of_one_track_make_one_segment_and_other_tracks_new_ones():
    runs = [run(1, 0, 90, 5, 10), run(1, 90, 180, 8, 10), run(2, 210, 300, 11, 10)]
    out = fill_part(prep_of(runs, [link(0, 1, 0.999), link(1, 2, 0.999)]), [{"frame": 30, "track": 1, "player": "A"}], variant="exp").out
    assert out["identities"][0]["segments"] == [[1, 0, 177], [2, 210, 297]]


def test_segment_never_crosses_a_box_of_the_track_that_is_not_selected():
    track_frames = {3: [0, 3, 6, 9, 12]}
    assert to_segments({(0, 3), (3, 3), (9, 3), (12, 3)}, track_frames) == [[3, 0, 3], [3, 9, 12]]
    assert segment_boxes([[3, 0, 3], [3, 9, 12]], track_frames) == {(0, 3), (3, 3), (9, 3), (12, 3)}


def test_conflicts_detects_overlap_between_players():
    a = {"player": "A", "segments": [[1, 0, 50]]}
    assert conflicts([a, {"player": "B", "segments": [[1, 51, 90]]}]) == 0
    assert conflicts([a, {"player": "B", "segments": [[1, 50, 90]]}]) == 1


def test_internal_links_below_threshold_release_the_far_pieces():
    assert reachable(4, (0.999, 0.9, 0.999), {0}, None) == [0, 1, 2, 3]
    assert reachable(4, (0.999, 0.9, 0.999), {0}, 0.99) == [0, 1]
    assert reachable(4, (0.999, 0.9, 0.999), {3}, 0.99) == [2, 3]
    assert reachable(3, (None, 0.999), {0}, 0.99) == [0]              # unión sin p: cortada


def test_selected_boxes_keeps_only_reachable_pieces_of_a_chain():
    runs = [run(1, 0, 60, 5, 10), run(2, 90, 150, 9, 10), run(3, 180, 240, 13, 10)]
    prep = prep_of(runs, [link(0, 1, 0.999), link(1, 2, 0.9)])
    (c,) = prep.chains
    assert len(c.members) == 3 and c.link_ps == (0.999, 0.9)
    assert {t for _, t in selected_boxes(c, {0}, 0.99)} == {1, 2}
    assert {t for _, t in selected_boxes(c, {0}, None)} == {1, 2, 3}


def test_policy_abstains_by_cost_entry_p_and_prior():
    pol = SegmentPolicy(max_cost=1.0, min_entry_p=0.99, prior_ok=False)
    assert accepts(pol, None, None)                  # ancla: siempre
    assert accepts(pol, 0.5, 0.995)
    assert not accepts(pol, 1.5, 0.995)              # costo alto
    assert not accepts(pol, 0.5, 0.9)                # unión de entrada floja
    assert not accepts(pol, 0.5, None)               # sin candidato (a priori)
    assert accepts(SegmentPolicy(), 1.9, None)


def test_fill_abstains_from_chains_the_policy_rejects_and_keeps_the_anchor():
    # A: ancla (track 1) y dos trozos que siguen (2: unión 0.999; 3: unión no candidata). Misma fila de y.
    runs = [run(1, 0, 90, 5, 10), run(2, 120, 210, 9, 10), run(3, 240, 330, 13, 10)]
    prep = prep_of(runs)
    prep.link_p.update({(0, 1): 0.999})
    anchors = [{"frame": 30, "track": 1, "player": "A"}]
    full = fill_part(prep, anchors, variant="exp", policy=SegmentPolicy()).out["identities"][0]["segments"]
    assert [s[0] for s in full] == [1, 2, 3]
    strict = fill_part(prep, anchors, variant="exp", policy=SegmentPolicy(min_entry_p=0.99, prior_ok=False))
    seg = strict.out["identities"][0]["segments"]
    assert [s[0] for s in seg] == [1, 2]                               # el 3 se abstiene; el ancla y el 2 se quedan
    assert strict.out["segments_summary"]["chains_abstained"] == 1
    assert strict.out["segment_policy"]["prior_ok"] is False
    none = fill_part(prep, anchors, variant="exp", policy=SegmentPolicy(max_cost=-1.0)).out["identities"][0]["segments"]
    assert [s[0] for s in none] == [1]                                  # solo el ancla


def test_anchor_extends_only_through_trusted_links():
    runs = [run(1, 0, 90, 5, 10), run(2, 120, 210, 9, 10)]
    prep = prep_of(runs, [link(0, 1, 0.97)])                           # unida (>= 0.95) pero por debajo de 0.99
    anchors = [{"frame": 30, "track": 1, "player": "A"}]
    assert [s[0] for s in fill_part(prep, anchors, variant="exp", policy=SegmentPolicy()).out["identities"][0]["segments"]] == [1, 2]
    trimmed = fill_part(prep, anchors, variant="exp", policy=SegmentPolicy(internal_p=0.99))
    assert [s[0] for s in trimmed.out["identities"][0]["segments"]] == [1]
    assert trimmed.out["segments_summary"]["chains_trimmed"] == 1


def test_variant_a_has_no_segments():
    prep = prep_of([run(1, 0, 90, 5, 10)])
    out = fill_part(prep, [{"frame": 30, "track": 1, "player": "A"}]).out
    assert "segments" not in out["identities"][0] and "segment_policy" not in out


def test_default_policy_is_the_most_precise_measured_point():
    from sportsan.tracking.segments import DEFAULT_POLICY

    assert (DEFAULT_POLICY.max_cost, DEFAULT_POLICY.min_entry_p, DEFAULT_POLICY.internal_p) == (1.0, 0.8, 0.995)
    assert DEFAULT_POLICY.prior_ok is False and DEFAULT_POLICY.reject_close is True


def test_suggestions_offer_free_pure_pieces_without_assigning_them():
    # A: ancla (track 1) y un trozo libre (track 2) que la política estricta suelta; su unión tiene p 0.9.
    runs = [run(1, 0, 90, 5, 10), run(2, 120, 210, 9, 10)]
    prep = prep_of(runs)
    prep.link_p.update({(0, 1): 0.9})
    out = fill_part(prep, [{"frame": 30, "track": 1, "player": "A"}], variant="exp",
                    policy=SegmentPolicy(min_entry_p=0.95)).out
    assert [s[0] for s in out["identities"][0]["segments"]] == [1]
    (sg,) = out["suggestions"]
    assert sg["kind"] == "union_dudosa" and sg["person"] == "A" and sg["track"] == 2
    assert (sg["frame_ini"], sg["frame_fin"]) == (120, 207) and sg["p"] == 0.9 and sg["cost"] <= 1.0
    weak = prep_of(runs)
    weak.link_p.update({(0, 1): 0.5})
    assert fill_part(weak, [{"frame": 30, "track": 1, "player": "A"}], variant="exp",
                     policy=SegmentPolicy(min_entry_p=0.95)).out["suggestions"] == []

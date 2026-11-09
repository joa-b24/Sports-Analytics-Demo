import json

import numpy as np

from sportsan.tracking.anchors import build_chains
from sportsan.tracking.anchors_cli import Prepared, fill_part, suggest
from sportsan.tracking.tracklets import Box, Tracklet

FPS = 30.0


def box(frame, track, x, y):
    px = x * 20
    return Box(frame=frame, track=track, x1=px - 20, y1=400, x2=px + 20, y2=500, lab=(50, 130, 130), xm=x, ym=y, team="own", on_pitch=True)


def run(track, f0, f1, x0, y, vx=1.0):
    return [box(f, track, x0 + vx * (f - f0) / FPS, y) for f in range(f0, f1, 3)]


def prepared():
    # Dos jugadoras (y=10 y y=50), cada una en tres trozos de 5 s con huecos de 1 s.
    runs = []
    for y, base in ((10, 0), (50, 10)):
        runs += [run(base + 1, 0, 150, 5, y), run(base + 2, 180, 330, 12, y), run(base + 3, 360, 510, 18, y)]
    tl = [Tracklet(id=i, track=r[0].track, boxes=r) for i, r in enumerate(runs)]
    chs = build_chains(tl, [])
    frames = [[b for r in runs for b in r if b.frame == f] for f in range(0, 510, 3)]
    rows = {r[0].frame: r for r in frames if r}
    return Prepared("t", FPS, frames, chs, {c.id for c in chs}, {}, rows, (1920.0, 1080.0), {})


def test_suggest_contract_and_available():
    res = suggest(prepared(), 2.0)
    assert set(res) == {"part", "fps", "chains", "suggestions", "available"}
    assert set(res["available"]) == {"1", "2", "3", "4", "5", "hybrid", "zones"}
    assert set(res["available"]["zones"]) == {"near", "center", "far"}
    assert sum(res["available"]["zones"].values()) == res["available"]["hybrid"]
    assert res["suggestions"] and all(s["why"] in ("larga", "aislada", "incierta") for s in res["suggestions"])
    ch = {c["id"]: c for c in res["chains"]}
    for s in res["suggestions"]:
        assert [s["frame"], s["track"]] in ch[s["chain"]]["boxes"] or ch[s["chain"]]["n"] > 60
    assert all(len(c["boxes"]) <= 60 for c in res["chains"])
    json.dumps(res)


def test_fill_names_all_pieces_and_bridges_gaps():
    prep = prepared()
    anchors = [{"frame": 75, "track": 1, "player": "A"}, {"frame": 75, "track": 11, "player": "B"},
               {"frame": 9999, "track": 99, "player": "A"}]
    r = fill_part(prep, anchors)
    out = r.out
    assert set(out) >= {"part", "identities", "doubts", "coverage"}
    ids = {i["player"]: i for i in out["identities"]}
    assert set(ids) == {"A", "B"}
    assert ids["A"]["tracks"] == [1, 2, 3] and ids["B"]["tracks"] == [11, 12, 13]
    assert len(out["ignored_anchors"]) == 1
    assert abs(out["coverage"]["per_player"]["A"] - 14.8) < 0.3
    assert out["coverage"]["interpolated_s"] > 3          # 2 huecos de 1 s por jugadora
    assert not any(d["kind"] in ("salto", "dos_sitios") for d in out["doubts"])


def long_prepared():
    # Dos jugadoras, una por banda (ym=50 cerca de la cámara, ym=10 lejos), 150 trozos de 3.2 s cada 4 s en 10 minutos (la ventana pide a lo más 11 y salta trozos pegados).
    runs, t = [], 1
    for y in (50, 10):
        for k in range(150):
            runs.append(run(t, k * 120, k * 120 + 96, 30, y, vx=0))
            t += 1
    tl = [Tracklet(id=i, track=r[0].track, boxes=r) for i, r in enumerate(runs)]
    chs = build_chains(tl, [])
    frames = [[b for r in runs for b in r if b.frame == f] for f in range(0, 18000, 3)]
    rows = {r[0].frame: r for r in frames if r}
    return Prepared("t", FPS, frames, chs, {c.id for c in chs}, {}, rows, (1920.0, 1080.0), {})


def test_hybrid_gives_far_side_more_suggestions_than_near():
    prep = long_prepared()
    res = suggest(prep, "hybrid", zone_rates={"near": 0.5, "center": 2.0, "far": 4.0})
    z = res["available"]["zones"]
    assert 20 <= z["near"] <= 55 < z["far"] and z["center"] == 0
    assert len(res["suggestions"]) == res["available"]["hybrid"] == z["far"] + z["near"]
    assert [s["frame"] for s in res["suggestions"]] == sorted(s["frame"] for s in res["suggestions"])
    prep.sign = -1                                       # la cámara al otro lado: se invierte
    res2 = suggest(prep, "hybrid", zone_rates={"near": 0.5, "center": 2.0, "far": 4.0})
    assert res2["available"]["zones"] == z              # mismas cuotas, pero ahora la de ym=10 es la cercana
    ym_of = {c.id: c.tl.boxes[0].ym for c in prep.chains}
    far_ym = lambda r: np.mean([ym_of[s["chain"]] == 10 for s in r["suggestions"]])  # noqa: E731
    assert far_ym(res2) < far_ym(res)
    json.dumps(res)


def test_hybrid_number_mode_unchanged_and_goal_zone_capped():
    prep = prepared()
    a = suggest(prep, 2.0)
    assert a["available"]["2"] == len(a["suggestions"])


def test_doubts_split_into_tasks_and_info():
    r = fill_part(prepared(), [{"frame": 75, "track": 1, "player": "A"}])
    out = r.out
    sm = out["doubt_summary"]
    assert sm["tasks"] == sum(sm["by_kind"].values()) == sum(1 for d in out["doubts"] if d["task"])
    assert all(d["task"] == (d["kind"] in ("salto", "dos_sitios", "union_dudosa")) for d in out["doubts"])
    assert sm["info"]["sin_nombre"] == sum(1 for d in out["doubts"] if d["kind"] == "sin_nombre")
    assert set(sm["info"]) >= {"hueco_largo", "sin_nombre"}


def overlap_prepared():
    # Una persona en dos cadenas que se solapan: la cadena de la pista 1 (5 s) y la de la pista 2 (1 s), a 4 m de distancia.
    ra = run(1, 0, 150, 5, 10)
    rb = run(2, 120, 150, 9, 10)
    rc = run(3, 300, 450, 30, 10)      # tercera cadena (lejos en el tiempo) para anclar sin tocar las dos solapadas
    tl = [Tracklet(id=i, track=r[0].track, boxes=r) for i, r in enumerate([ra, rb, rc])]
    chs = build_chains(tl, [])
    frames = [[b for r in (ra, rb, rc) for b in r if b.frame == f] for f in range(0, 450, 3)]
    rows = {r[0].frame: r for r in frames if r}
    return Prepared("t", FPS, frames, chs, {c.id for c in chs}, {}, rows, (1920.0, 1080.0), {})


def _forced_both(monkeypatch):
    """fill_both asigna las dos cadenas solapadas a la misma persona (lo que dejan las anclas o el relleno en los casos reales)."""
    from sportsan.tracking import anchors_cli
    from sportsan.tracking.anchors import Fill

    def fake(chs, anchor_of, *a, **k):
        return Fill(owner={c.id: 0 for c in chs})

    monkeypatch.setattr(anchors_cli, "fill_both", fake)


def test_dos_sitios_resolved_by_anchor(monkeypatch):
    _forced_both(monkeypatch)
    prep = overlap_prepared()
    # ancla solo en la cadena corta: gana aunque sea la menor
    out = fill_part(prep, [{"frame": 135, "track": 2, "player": "A"}]).out
    assert out["doubt_summary"]["tasks"] == 0 and out["doubt_summary"]["auto_resolved"] == {"dos_sitios": 1}
    assert out["identities"][0]["tracks"] == [2, 3]
    assert "ancla" in out["auto_resolved"][0]["reason"] and out["auto_resolved"][0]["task"] is False
    assert not any(d["kind"] == "dos_sitios" for d in out["doubts"])


def test_dos_sitios_by_duration_or_task(monkeypatch):
    _forced_both(monkeypatch)
    # sin ancla en ninguna y 4.9 s contra 1 s: gana la larga
    out = fill_part(overlap_prepared(), [{"frame": 375, "track": 3, "player": "A"}]).out
    assert out["doubt_summary"]["auto_resolved"] == {"dos_sitios": 1} and out["doubt_summary"]["tasks"] == 0
    assert "ninguna tiene ancla" in out["auto_resolved"][0]["reason"] and out["identities"][0]["tracks"] == [1, 3]
    # anclas en las dos: es tarea
    out = fill_part(overlap_prepared(), [{"frame": 135, "track": 2, "player": "A"}, {"frame": 3, "track": 1, "player": "A"}],
                    doubles=False).out
    assert out["doubt_summary"]["by_kind"] == {"dos_sitios": 1} and out["auto_resolved"] == []
    assert [d["task"] for d in out["doubts"] if d["kind"] == "dos_sitios"] == [True]


# ------------------------------------------------------------------ dobles cajas (doubles.py)

def test_doubles_undecided_short_overlap_drops_both_in_fill(monkeypatch):
    """Las dos cadenas ancladas y en el mismo sitio durante 1 s: la ruta no distingue, así que se quitan las dos cajas solo
    en los cuadros del solape (no se elige a nadie) y ya no queda la duda dos_sitios."""
    from sportsan.tracking.doubles import Weights

    _forced_both(monkeypatch)
    out = fill_part(overlap_prepared(), [{"frame": 135, "track": 2, "player": "A"}, {"frame": 3, "track": 1, "player": "A"}],
                    weights=Weights(length=0.0), doubles=True).out
    assert not any(d["kind"] == "dos_sitios" for d in out["doubts"])
    assert {d["track"] for d in out["drops"]} == {1, 2} and {d["reason"] for d in out["drops"]} == {"ambas"}
    assert sorted({d["frame"] for d in out["drops"]}) == list(range(120, 150, 3)) and all(d["player"] == "A" for d in out["drops"])
    dbl = out["doubt_summary"]["doubles"]
    assert dbl["frames_before"] == 10 and dbl["frames_after"] == 0 and dbl["dropped"]["ambas"] == 20
    assert out["identities"][0]["tracks"] == [1, 2, 3]       # no se parte ni se une nada


def _layers(*tracks):
    """tracks: (track, f0, f1, x0, y, vx, unary). Capas por cuadro con las cajas de esos tracks."""
    from sportsan.tracking.doubles import Cand

    by_f: dict[int, list] = {}
    for tr, f0, f1, x0, y, vx, u in tracks:
        for f in range(f0, f1, 3):
            by_f.setdefault(f, []).append(Cand(f, tr, x0 + vx * (f - f0) / FPS, y, u))
    return [by_f[f] for f in sorted(by_f)]


def test_doubles_route_drops_impossible_box():
    from sportsan.tracking.doubles import resolve_player

    L = _layers((1, 0, 300, 0, 10, 1.0, 0.0), (2, 90, 150, 0, 40, 0.0, -1.0))    # otra caja a 30 m durante 2 s
    drops, doubts, before, after = resolve_player("A", L, FPS, 3)
    assert {d["track"] for d in drops} == {2} and {d["reason"] for d in drops} == {"ruta"} and len(drops) == 20
    assert doubts == [] and before == 20 and after == 0


def test_doubles_short_undecided_drops_both():
    from sportsan.tracking.doubles import resolve_player

    # la ruta pasa por y=10; durante 0.5 s hay dos cajas a 1.5 m y a 2 m de ella: la ruta no distingue y se quitan las dos
    L = _layers((1, 0, 90, 0, 10, 0.0, 0.0), (1, 105, 300, 0, 10, 0.0, 0.0), (2, 90, 105, 0, 11.5, 0.0, 0.0),
                (3, 90, 105, 0, 8.0, 0.0, 0.0))
    drops, doubts, before, after = resolve_player("A", L, FPS, 3)
    assert {d["track"] for d in drops} == {2, 3} and {d["reason"] for d in drops} == {"ambas"}
    assert {d["frame"] for d in drops} == set(range(90, 105, 3)) and doubts == [] and after == 0


def test_doubles_long_undecided_is_a_task():
    from sportsan.tracking.doubles import resolve_player

    L = _layers((1, 0, 180, 0, 10, 0.0, 0.0), (2, 0, 180, 0, 30, 0.0, 0.0))     # 6 s en dos sitios, nada las distingue
    drops, doubts, before, after = resolve_player("A", L, FPS, 3)
    assert drops == [] and len(doubts) == 1 and doubts[0]["kind"] == "dos_sitios" and doubts[0]["task"] is True
    assert before == after == 60


def test_player_tracks_skips_conflicts():
    from sportsan.tracking.doubles import player_tracks

    ids = [{"player": "A", "tracks": [1, 2]}, {"player": "B", "tracks": [2, 3]}]
    assert player_tracks(ids) == {"A": {1}, "B": {3}}


def test_second_pass_counts_jumps_and_long_holes():
    from sportsan.tracking.doubles import second_pass

    path = [(f, f / FPS, 10.0) for f in range(0, 60, 3)]
    path[5] = (15, 0.5, 25.0)                                # pico de un punto: lo quita la limpieza
    path += [(f, 20.0, 10.0) for f in range(60, 90, 3)]       # salto real de ~18 m en 0.1 s
    path += [(f, 20.0, 10.0) for f in range(300, 330, 3)]     # hueco de 7 s
    r = second_pass(path, FPS)
    assert r["jumps"] == 1 and r["holes_long"] == 1


# ------------------------------------------------------------------ variante B (fill --variant exp)

def test_exclusive_assignment_frees_overlapping_chain(monkeypatch):
    """Con un costo que no mira el tiempo, la cadena C iría a la jugadora 1 aunque se solape con su ancla; con la exclusión
    la jugadora 1 queda vetada y C pasa a la 2."""
    from sportsan.tracking import anchors as A

    tl = [Tracklet(id=0, track=1, boxes=run(1, 0, 300, 5, 10)), Tracklet(id=1, track=2, boxes=run(2, 0, 60, 5, 40)),
          Tracklet(id=2, track=3, boxes=run(3, 150, 250, 6, 10))]
    chs = build_chains(tl, [])
    by_track = {c.tl.track: c.id for c in chs}
    monkeypatch.setattr(A, "transition_cost", lambda a, c, *k: 0.5 if a.tl.track == 1 else 1.0)
    anchors = {by_track[1]: 1, by_track[2]: 2}
    plain = A.fill_between(chs, anchors, FPS, {}, {1: "own", 2: "own"})
    excl = A.fill_between(chs, anchors, FPS, {}, {1: "own", 2: "own"}, exclusive=True)
    assert plain.owner[by_track[3]] == 1
    assert excl.owner[by_track[3]] == 2 and excl.excluded >= 1
    # sin otra jugadora posible, la cadena vetada queda sin nombre
    alone = A.fill_between(chs, {by_track[1]: 1}, FPS, {}, {1: "own"}, exclusive=True)
    assert by_track[3] not in alone.owner


def exp_prepared():
    """Jugadora A: track 1 (0-5 s, con una excursión de 0.2 s a 20 m) y track 2 (10-15 s). Un trozo suelto del track 2
    (4-5 s) es otra cadena que no es suya: en la mesa sale como doble caja de A."""
    r1 = run(1, 0, 150, 5, 10)
    for i in (20, 21):                               # cuadros 60 y 63: los pies caen 20 m más allá
        b = r1[i]
        r1[i] = box(b.frame, 1, b.xm, 30.0)
    r2 = run(2, 300, 450, 20, 10)
    r2b = run(2, 120, 150, 40, 50)
    runs = [r1, r2b, r2]
    tl = [Tracklet(id=i, track=r[0].track, boxes=r) for i, r in enumerate(runs)]
    chs = build_chains(tl, [])
    frames = [[b for r in runs for b in r if b.frame == f] for f in range(0, 450, 3)]
    rows = {r[0].frame: r for r in frames if r}
    return Prepared("t", FPS, frames, chs, {c.id for c in chs}, {}, rows, (1920.0, 1080.0), {}, stride=3)


def _owner_by_track(monkeypatch, tracks_frames):
    """fill_both falso: A se queda con las cadenas cuyo primer cuadro y track están en `tracks_frames`."""
    from sportsan.tracking import anchors_cli
    from sportsan.tracking.anchors import Fill

    def fake(chs, anchor_of, *a, **k):
        return Fill(owner={c.id: 0 for c in chs if (c.tl.boxes[0].track, c.start) in tracks_frames})

    monkeypatch.setattr(anchors_cli, "fill_both", fake)


def test_exp_passes_order_and_reasons(monkeypatch):
    _owner_by_track(monkeypatch, {(1, 0), (2, 300)})
    prep = exp_prepared()
    anchors = [{"frame": 30, "track": 1, "player": "A"}]
    out = fill_part(prep, anchors, variant="exp").out
    assert out["variant"] == "exp" and set(out["passes"]) == {"exclusion", "doubles", "jumps", "holes"}
    by = {}
    for d in out["drops"]:
        by.setdefault(d["reason"], set()).add((d["frame"], d["track"]))
    # 1: la doble caja del trozo suelto se quita por exclusión (antes que la ruta: ningún «ruta»/«ambas»)
    assert by["exclusion"] == {(f, 2) for f in range(120, 150, 3)}
    assert "ruta" not in by and "ambas" not in by
    # 3: la excursión de 2 cuadros que vuelve a donde podía estar se descarta como salto
    assert by["salto"] == {(60, 1), (63, 1)}
    assert out["passes"]["doubles"]["frames_before"] == 10 and out["passes"]["doubles"]["frames_after"] == 0
    assert out["passes"]["jumps"]["tasks"] == 0
    # 4: el hueco que deja la excursión se interpola; el de 5 s (150 -> 300) es largo y queda informativo
    assert out["identities"][0]["interpolated"] == [[1.9, 2.2]] and out["doubt_summary"]["info"]["hueco_largo"] == 1
    assert out["doubt_summary"]["auto_resolved"]["drops"] == {"exclusion": 10, "ruta": 0, "ambas": 0, "salto": 2}
    json.dumps(out)


def test_exp_interpolates_short_holes_and_keeps_a_unchanged():
    prep = prepared()
    anchors = [{"frame": 75, "track": 1, "player": "A"}, {"frame": 75, "track": 11, "player": "B"}]
    a = fill_part(prep, anchors).out
    a2 = fill_part(prep, anchors, variant="").out
    assert a == a2 and "variant" not in a and "passes" not in a and a["drops"] == []
    b = fill_part(prep, anchors, variant="exp").out
    assert [i["tracks"] for i in b["identities"]] == [i["tracks"] for i in a["identities"]]
    assert all(len(i["interpolated"]) == 2 for i in b["identities"])       # huecos de 1 s, posibles
    assert b["drops"] == [] and b["doubt_summary"]["by_kind"].get("salto", 0) == 0


def test_cli_variant_never_writes_links_of_a(monkeypatch, tmp_path):
    import pytest

    from sportsan.tracking import anchors_cli

    with pytest.raises(SystemExit):
        anchors_cli.cli(["suggest", "--part", "x", "--variant", "exp"])
    with pytest.raises(SystemExit):
        anchors_cli.cli(["fill", "--part", "x", "--variant", "exp", "--doubles"])


# ------------------------------------------------------------------ cajas y resolución de cada duda

def _fake_owner(monkeypatch, owner, cost=None):
    from sportsan.tracking import anchors_cli
    from sportsan.tracking.anchors import Fill

    def fake(chs, anchor_of, *a, **k):
        return Fill(owner={c.id: 0 for c in chs if c.tl.track in owner}, cost={c.id: cost for c in chs if cost and c.tl.track in owner})

    monkeypatch.setattr(anchors_cli, "fill_both", fake)


def _prep_of(*runs, stride=3):
    tl = [Tracklet(id=i, track=r[0].track, boxes=r) for i, r in enumerate(runs)]
    chs = build_chains(tl, [])
    last = max(r[-1].frame for r in runs)
    frames = [[b for r in runs for b in r if b.frame == f] for f in range(0, last + 1, 3)]
    rows = {r[0].frame: r for r in frames if r}
    return Prepared("t", FPS, frames, chs, {c.id for c in chs}, {}, rows, (1920.0, 1080.0), {}, stride=stride)


def _check_box(b, frame, track, role, player):
    assert (b["frame"], b["track"], b["role"], b["player"]) == (frame, track, role, player)
    assert abs(b["t"] - frame / FPS) < 1e-3 and "chain" in b


def test_salto_has_before_after_boxes_jump_and_resolution(monkeypatch):
    _fake_owner(monkeypatch, {1, 2})
    prep = _prep_of(run(1, 0, 90, 5, 10), run(2, 96, 200, 60, 10))      # 0.3 s y ~55 m entre una y otra
    d = [x for x in fill_part(prep, [{"frame": 30, "track": 1, "player": "A"}]).out["doubts"] if x["kind"] == "salto"]
    assert len(d) == 1
    d = d[0]
    ante, desp = d["boxes"]
    _check_box(ante, 87, 1, "antes", "A")
    _check_box(desp, 96, 2, "despues", "A")
    assert d["jump"]["dist_m"] > 50 and d["jump"]["dt_s"] == 0.3 and d["jump"]["speed_ms"] > 100
    assert d["jump"]["from"][0] < d["jump"]["to"][0]
    assert d["resolution"] == {"options": ["antes_es_ella", "despues_es_ella", "ninguna", "esta_bien"], "default": "esta_bien"}
    json.dumps(d)


def test_dos_sitios_boxes_share_a_frame_when_they_overlap(monkeypatch):
    _forced_both(monkeypatch)
    out = fill_part(overlap_prepared(), [{"frame": 135, "track": 2, "player": "A"}, {"frame": 3, "track": 1, "player": "A"}]).out
    d = [x for x in out["doubts"] if x["kind"] == "dos_sitios"][0]
    a, b = d["boxes"]
    assert a["frame"] == b["frame"] and 120 <= a["frame"] < 150 and (a["track"], b["track"]) == (1, 2)
    assert (a["role"], b["role"], a["player"]) == ("a", "b", "A") and a["chain"] != b["chain"]
    assert d["resolution"]["options"] == ["a_es_ella", "b_es_ella", "ninguna", "las_dos"]
    assert d["resolution"]["default"] in d["resolution"]["options"]


def test_dos_sitios_from_doubles_pass_has_boxes():
    from sportsan.tracking.doubles import resolve_player

    L = _layers((1, 0, 180, 0, 10, 0.0, 0.0), (2, 0, 180, 0, 30, 0.0, 0.0))
    _, doubts, _, _ = resolve_player("A", L, FPS, 3)
    a, b = doubts[0]["boxes"]
    assert a["frame"] == b["frame"] == 0 and {a["track"], b["track"]} == {1, 2} and (a["role"], b["role"]) == ("a", "b")


def test_union_dudosa_boxes_end_start_and_candidates(monkeypatch):
    # A: pista 1 (0-3 s) y pista 2 (5-8 s, la dudosa); otra cadena (pista 3) empieza casi al mismo tiempo que la 2
    _fake_owner(monkeypatch, {1, 2}, cost=4.0)
    prep = _prep_of(run(1, 0, 90, 5, 10), run(2, 150, 240, 8, 10), run(3, 156, 240, 8, 12))
    out = fill_part(prep, [{"frame": 30, "track": 1, "player": "A"}]).out
    d = [x for x in out["doubts"] if x["kind"] == "union_dudosa" and x["track"] == 2]
    assert d, out["doubts"]
    d = d[0]
    assert [b["role"] for b in d["boxes"]] == ["a", "b", "candidata"]
    _check_box(d["boxes"][0], 87, 1, "a", "A")
    _check_box(d["boxes"][1], 150, 2, "b", "A")
    _check_box(d["boxes"][2], 156, 3, "candidata", None)
    assert d["resolution"] == {"options": ["unir", "no_unir", "otra"], "default": "unir"}


def test_hueco_largo_and_sin_nombre_have_boxes_and_times(monkeypatch):
    _fake_owner(monkeypatch, {1, 2})
    prep = _prep_of(run(1, 0, 90, 5, 30), run(2, 450, 540, 8, 30), run(3, 0, 120, 70, 50))
    doubts = fill_part(prep, [{"frame": 30, "track": 1, "player": "A"}]).out["doubts"]
    h = [x for x in doubts if x["kind"] == "hueco_largo"][0]
    assert [b["role"] for b in h["boxes"]] == ["antes", "despues"] and h["boxes"][1]["frame"] == 450
    assert abs(h["t0"] - 3.0) < 0.15 and abs(h["t1"] - 15.0) < 0.05 and h["task"] is False and "resolution" not in h
    s = [x for x in doubts if x["kind"] == "sin_nombre"][0]
    assert [b["role"] for b in s["boxes"]] == ["a"] and s["boxes"][0]["player"] is None and s["boxes"][0]["track"] == 3
    assert s["t0"] == 0.0 and abs(s["t1"] - 3.9) < 0.15


def test_exp_salto_and_hueco_have_boxes(monkeypatch):
    _owner_by_track(monkeypatch, {(1, 0), (2, 300)})
    out = fill_part(exp_prepared(), [{"frame": 30, "track": 1, "player": "A"}], variant="exp").out
    h = [x for x in out["doubts"] if x["kind"] == "hueco_largo"][0]
    assert [b["role"] for b in h["boxes"]] == ["antes", "despues"] and h["t1"] > h["t0"]
    prep = _prep_of(run(1, 0, 90, 5, 10), run(2, 96, 200, 60, 10))
    _fake_owner(monkeypatch, {1, 2})
    s = [x for x in fill_part(prep, [{"frame": 30, "track": 1, "player": "A"}], variant="exp").out["doubts"] if x["kind"] == "salto"][0]
    assert [b["role"] for b in s["boxes"]] == ["antes", "despues"] and s["jump"]["dist_m"] > 50
    assert s["resolution"]["default"] == "esta_bien"


def test_not_player_anchor_leaves_chain_out_of_fill_and_doubts():
    prep = prepared()
    base = [{"frame": 75, "track": 1, "player": "A"}, {"frame": 75, "track": 11, "player": "B"}]
    out = fill_part(prep, base + [{"frame": 435, "track": 3, "player": "__no__"}]).out
    ids = {i["player"]: i for i in out["identities"]}
    assert set(ids) == {"A", "B"}                                   # no se crea una «jugadora» __no__
    assert 3 not in ids["A"]["tracks"] and 2 in ids["A"]["tracks"]
    assert out["doubt_summary"]["info"]["no_jugadora"] == 1 and [x["track"] for x in out["not_player"]] == [3]
    assert not any(d["kind"] == "sin_nombre" and d["track"] == 3 for d in out["doubts"])
    assert out["ignored_anchors"] == []
    plain = fill_part(prep, base).out                               # sin __no__ sí se rellena y no hay lista
    assert 3 in {i["player"]: i for i in plain["identities"]}["A"]["tracks"] and plain["not_player"] == []


def test_not_player_never_beats_a_named_chain_and_suggest_skips_it():
    from sportsan.tracking.anchors_cli import not_player_chains

    prep = prepared()
    anchors = [{"frame": 75, "track": 1, "player": "A"}, {"frame": 75, "track": 1, "player": "__no__"}]
    assert not_player_chains(prep, anchors) == set()
    r = fill_part(prep, anchors).out
    assert [i["player"] for i in r["identities"]] == ["A"] and len(r["ignored_anchors"]) == 1
    no = not_player_chains(prep, [{"frame": 435, "track": 3, "player": "__no__"}])
    assert len(no) == 1
    sug = suggest(prep, 2.0, covered=no)
    assert all(s["chain"] not in no for s in sug["suggestions"])


def test_cli_suggest_reads_not_player_from_anchor_file(monkeypatch, tmp_path):
    from sportsan.tracking import anchors_cli

    prep = prepared()
    (tmp_path / "auto").mkdir()
    (tmp_path / "auto" / "anchors_t.json").write_text(json.dumps({"anchors": [{"frame": 75, "track": 1, "player": "__no__"}]}))
    monkeypatch.setattr(anchors_cli, "_paths", lambda *a, **k: (tmp_path, tmp_path / "auto", anchors_cli.Progress(None)))
    monkeypatch.setattr(anchors_cli, "prepare", lambda *a, **k: prep)
    monkeypatch.setattr(anchors_cli.Models, "load", classmethod(lambda cls, d: None))
    anchors_cli.cli(["suggest", "--part", "t"])
    res = json.loads((tmp_path / "auto" / "suggest_t.json").read_text())
    c1 = [c["id"] for c in res["chains"] if c["boxes"][0][1] == 1][0]
    assert all(s["chain"] != c1 for s in res["suggestions"])


def test_old_doubts_keep_their_keys():
    out = fill_part(prepared(), [{"frame": 75, "track": 1, "player": "A"}]).out
    for d in out["doubts"]:
        assert {"kind", "frame", "track", "players", "note", "task"} <= set(d)

import json

import pytest

from sportsan.tracking.evaluate import file_identities, labels_from, load_labels, make_fixture, score


def truth(rows, reviewed=None, dropped=()):
    """rows: lista de (cuadro, track, persona). Etiquetas como las exporta la app."""
    frames: dict[int, list] = {}
    for f, t, p in rows:
        frames.setdefault(f, []).append({"track": t, "label": p, "status": "player"})
    for f, t in dropped:
        frames.setdefault(f, []).append({"track": t, "label": None, "status": "dropped"})
    people = {p for _, _, p in rows}
    return labels_from({
        "kind": "tracks_labels",
        "frames": [{"frame": f, "boxes": b} for f, b in sorted(frames.items())],
        "people": [{"label": p, "reviewed": reviewed is None or p in reviewed} for p in people],
    })


# Dos personas (1 y 2) en 6 cuadros; los tracks del seguidor son 10, 11, 12 (persona 1) y 20 (persona 2).
ROWS = [(f, 10 if f < 2 else 11 if f < 4 else 12, 1) for f in range(6)] + [(f, 20, 2) for f in range(6)]


def test_propuesta_perfecta():
    labels, reviewed = truth(ROWS)
    r = score({(f, t): p for f, t, p in ROWS}, labels, reviewed)
    assert r["ops_needed"] == 0 and r["link_precision"] == 1 and r["link_recall"] == 1
    assert r["identities_per_person"] == 1


def test_persona_partida_en_tres():
    labels, reviewed = truth(ROWS)
    r = score({(f, t): (t if p == 1 else 2) for f, t, p in ROWS}, labels, reviewed)
    assert r["merges_needed"] == 2 and r["splits_needed"] == 0
    assert r["link_precision"] == 1 and r["link_recall"] == round(8 / 10, 4)


def test_identidad_que_pasa_de_una_persona_a_otra_y_vuelve():
    # La identidad 7 es la persona 1, luego la 2, luego la 1 otra vez.
    rows = [(0, 1, 1), (1, 1, 1), (2, 2, 2), (3, 2, 2), (4, 3, 1), (5, 3, 1)]
    labels, reviewed = truth(rows)
    r = score({(f, t): 7 for f, t, _ in rows}, labels, reviewed)
    assert r["splits_needed"] == 2 and r["merges_needed"] == 0


def test_las_no_revisadas_no_cuentan():
    labels, reviewed = truth(ROWS, reviewed={1})
    good = {(f, t): p for f, t, p in ROWS}
    worse = {**good, **{(f, 20): 99 + f for f in range(6)}}  # la persona 2 (no revisada) partida en 6
    assert score(good, labels, reviewed) == score(worse, labels, reviewed)


def test_duplicado_con_identidad_de_jugadora():
    labels, reviewed = truth(ROWS, dropped=[(3, 30)])
    proposed = {**{(f, t): p for f, t, p in ROWS}, (3, 30): 1}
    r = score(proposed, labels, reviewed)
    assert r["dup_assigned"] == 1 and r["ops_needed"] == 0
    assert score({**proposed, (3, 30): None}, labels, reviewed)["dup_assigned"] == 0


def test_rechaza_otro_tipo_de_archivo(tmp_path):
    p = tmp_path / "x.json"
    p.write_text(json.dumps({"kind": "tracks_px", "frames": []}), encoding="utf-8")
    with pytest.raises(ValueError, match="tracks_labels"):
        load_labels(p)


def test_identidad_del_archivo_y_fixture_sin_nombres():
    tracks = {"start_frame": 0, "fps": 10.0, "quality": {}, "frames": [
        {"frame": f, "H": None, "boxes": [[5, 0, 0, 1, 1, 0.9, 0, 0, 0, 1.0, 1.0, True, "own", 4], [6, 0, 0, 1, 1, 0.9, 0, 0, 0, 1.0, 1.0, True, "own"]]}
        for f in range(0, 100, 5)
    ]}
    assert file_identities(tracks)[(0, 5)] == 4 and file_identities(tracks)[(0, 6)] == 6
    labels = {"kind": "tracks_labels", "start_frame": 0, "end_frame": 100,
              "frames": [{"frame": f, "boxes": [{"track": 5, "label": 4, "status": "player"}]} for f in range(0, 100, 5)],
              "manual": [{"label": 4, "frame": 50, "px": 1, "py": 1}],
              "people": [{"label": 4, "reviewed": True, "named": True, "player_id": "Zoe"}],
              "edits": {"people": {"4": {"player_id": "Zoe"}}}}
    fx = make_fixture(tracks, labels, start_s=3, dur_s=4)
    frames = [fr["frame"] for fr in fx["tracks"]["frames"]]
    assert frames[0] == 30 and frames[-1] == 65 and fx["tracks"]["start_frame"] == 30
    assert [fr["frame"] for fr in fx["labels"]["frames"]] == frames and fx["labels"]["manual"][0]["frame"] == 50
    text = json.dumps(fx)
    assert "player_id" not in text and "Zoe" not in text


def test_las_etiquetas_pasan_a_otra_corrida_de_las_mismas_cajas():
    from sportsan.tracking.evaluate import remap_labels

    old = {"frames": [{"frame": 0, "boxes": [[5, 0, 0, 10, 30], [6, 100, 0, 110, 30]]}]}
    new = {"frames": [{"frame": 0, "boxes": [[41, 101, 1, 111, 31], [40, 0, 0, 10, 30], [42, 500, 0, 510, 30]]}]}
    labels = {"kind": "tracks_labels", "frames": [{"frame": 0, "boxes": [{"track": 5, "label": 1, "status": "player"},
                                                                          {"track": 6, "label": 2, "status": "dropped"}]}]}
    out, info = remap_labels(labels, old, new)
    got = {b["track"]: (b["label"], b["status"]) for b in out["frames"][0]["boxes"]}
    assert got == {40: (1, "player"), 41: (2, "dropped")} and info == {"boxes": 3, "matched": 2}


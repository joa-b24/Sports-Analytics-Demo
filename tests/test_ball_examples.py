"""Ejemplos de balón (ball_examples), penalización por cajas (ball_track) y zonas (ball_fp): funciones puras."""
import pytest

from sportsan.tracking import ball_examples as E
from sportsan.tracking import ball_fp as F
from sportsan.tracking import ball_track as T


def test_parse_examples_valida_y_corrige_el_motivo():
    d = {"kind": "ball_examples", "positives": [{"video_id": "v1", "t_video": 3, "px": [1, 2]}], "negatives": [{"video_id": "v1", "t_video": 4, "px": [5, 6], "why": "cosa"}]}
    ok = E.parse_examples(d)
    assert ok["positives"][0]["aerial"] is False and ok["negatives"][0]["why"] == "otro"
    with pytest.raises(ValueError):
        E.parse_examples({"kind": "otra"})
    with pytest.raises(ValueError):
        E.parse_examples({"kind": "ball_examples", "positives": [{"video_id": "v1", "t_video": 3, "px": [1]}]})
    with pytest.raises(ValueError):
        E.parse_examples({"kind": "ball_examples", "positives": [{"video_id": "v1", "t_video": -1, "px": [1, 2]}]})


def test_plan_es_determinista_y_separa_los_cuadros():
    pool = [{"video_id": "v1", "frame": f, "fps": 30.0} for f in range(0, 30 * 600, 3)]
    a = E.sample_plan(pool, 40, seed=7)
    assert a == E.sample_plan(pool, 40, seed=7) and len(a) == 40
    ts = sorted(x["t_video"] for x in a)
    assert all(b - c >= E.PLAN_GAP_S for c, b in zip(ts, ts[1:]))
    assert len({x["id"] for x in a}) == 40


def test_train_se_niega_sin_ejemplos(tmp_path, monkeypatch):
    from sportsan.tracking import ball as B

    (tmp_path / "tracking").mkdir()
    monkeypatch.setattr(B, "match_dir", lambda m: tmp_path)
    with pytest.raises(SystemExit, match="no tiene positivos"):
        E.train("x")


def test_penalizacion_de_cajas_zapato_y_candidato_libre():
    # Caja de 40 x 100 px; un candidato en el zapato (se repite en el mismo lugar relativo) y otro libre, en tres cuadros.
    box = [7, 100, 100, 140, 200]
    frames = [{"frame": f, "boxes": [box]} for f in (0, 3, 6)]
    nodes = [[(120.0, 195.0, 0.9), (500.0, 500.0, 0.9)] for _ in frames]
    cost = T._box_cost({"frames": frames}, nodes)
    assert cost[(0, 0)] >= T.BOX_FEET_COST + T.SHOE_COST
    assert (0, 1) not in cost


def test_zonas_y_yardas():
    box = [1, 100, 100, 140, 200]
    assert F.zone(box, 120, 190) == "pies" and F.zone(box, 120, 110) == "cabeza" and F.zone(box, 120, 150) == "tronco" and F.zone(box, 0, 0) is None
    assert F.zone_in([box], 150, 150) == "junto" and F.zone_in([box], 900, 900) == "libre" and F.zone_in([], 1, 1) == "libre"
    h = F.yard_histogram([F.YARD_M * i + 0.2 for i in range(50)])
    assert h[0] == 50 and sum(h) == 50

"""Falta tracking/link_model.json: el mensaje explica qué es y cómo entrenarlo, sin un FileNotFoundError crudo."""
from __future__ import annotations

import json
import sys

import pytest

from sportsan.tracking import links_eval
from sportsan.tracking.anchors_cli import Models, Progress, missing_model_message


def _tracking(tmp_path, match="2026_10_10_tec_ccm_vs_up"):
    d = tmp_path / "matches" / match / "tracking"
    d.mkdir(parents=True)
    return d


def _labels(d, part, named=True):
    (d / f"tracks_{part}.json").write_text("{}", encoding="utf-8")
    (d / f"labels_{part}.json").write_text(json.dumps({"people": [{"named": named}]}), encoding="utf-8")


def test_sin_labels_dice_que_no_hay_con_que_entrenar(tmp_path):
    d = _tracking(tmp_path)
    with pytest.raises(SystemExit) as e:
        Models.load(d)
    msg = str(e.value)
    assert "Falta el modelo de uniones" in msg
    assert "no existe ningún labels_*.json" in msg
    assert "links_eval --match 2026_10_10_tec_ccm_vs_up" in msg


def test_con_labels_da_el_comando_con_los_prefijos(tmp_path):
    d = _tracking(tmp_path)
    for p in ("v1_0_100", "v1_100_200", "v2_0_100"):
        _labels(d, p)
    msg = missing_model_message(d)
    assert "--train v1,v2" in msg
    assert "una sola vez" in msg or "una vez" in msg
    assert "8 minutos" in msg


def test_labels_sin_nombres(tmp_path):
    d = _tracking(tmp_path)
    _labels(d, "v1_0_100", named=False)
    msg = missing_model_message(d)
    assert "ninguno tiene personas con nombre" in msg
    assert "--train v1" in msg


def test_links_eval_train_auto_sin_labels(tmp_path, monkeypatch):
    d = _tracking(tmp_path)
    monkeypatch.setattr(links_eval, "load_config", lambda match=None: {"paths": {"tracking_dir": "matches/x/tracking"}, "match_id": "x"})
    monkeypatch.setattr(links_eval, "project_root", lambda: d.parents[2])
    monkeypatch.setattr(sys, "argv", ["links_eval", "--match", "x"])
    (d.parents[2] / "matches" / "x").mkdir()
    (d.parents[2] / "matches" / "x" / "tracking").mkdir()
    with pytest.raises(SystemExit) as e:
        links_eval.main()
    assert "No hay con qué entrenar" in str(e.value)


def test_prefijos_y_comando():
    assert links_eval.video_prefixes(["v1_0_5", "v2_0_5", "v1_5_9"]) == ["v1", "v2"]
    assert links_eval.train_command("m", []).endswith("--train auto")


def test_progress_formato_compartido(tmp_path):
    p = tmp_path / "revision" / "progreso_linkmodel_modelo.log"
    pg = Progress(p)
    pg.log("entrenamiento", 1, 4)
    line = p.read_text(encoding="utf-8").strip()
    assert " entrenamiento 1/4 25% ETA " in line

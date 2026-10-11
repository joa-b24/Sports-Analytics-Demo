import pandas as pd
import pytest

from sportsan.mock.generate import generate
from sportsan.io import load_ball, load_events, load_tracking
from sportsan.metrics.team_shape import heatmap, team_shape
from sportsan.schema import SchemaError, validate_events, validate_tracking


@pytest.fixture(scope="module")
def mock_dir(tmp_path_factory):
    return generate(tmp_path_factory.mktemp("mock"), duration_s=20)


def test_mock_cumple_el_contrato(mock_dir):
    tr, ba, ev = load_tracking(mock_dir), load_ball(mock_dir), load_events(mock_dir)
    assert len(tr) > 0 and len(ba) > 0 and len(ev) == 6


def test_equipo_invalido_falla(mock_dir):
    tr = load_tracking(mock_dir).copy()
    tr.loc[0, "team"] = "otro"
    with pytest.raises(SchemaError):
        validate_tracking(tr)


def test_duplicados_fallan(mock_dir):
    tr = load_tracking(mock_dir)
    with pytest.raises(SchemaError):
        validate_tracking(pd.concat([tr, tr.iloc[[0]]], ignore_index=True))


def test_fuera_de_cancha_falla(mock_dir):
    tr = load_tracking(mock_dir).copy()
    tr.loc[0, "x"] = 200.0
    with pytest.raises(SchemaError):
        validate_tracking(tr)


def test_evento_invalido_falla(mock_dir):
    ev = load_events(mock_dir).copy()
    ev.loc[0, "type"] = "baile"
    with pytest.raises(SchemaError):
        validate_events(ev)


def test_outcome_y_detail_dependen_del_tipo(mock_dir):
    ev = load_events(mock_dir)
    validate_events(ev)  # el mock trae un tiro con resultado y un córner con tipo de envío

    wrong_outcome = ev.copy()
    wrong_outcome.loc[wrong_outcome["type"] == "shot", "outcome"] = "inswing"
    with pytest.raises(SchemaError, match="outcome"):
        validate_events(wrong_outcome)

    wrong_type = ev.copy()
    wrong_type.loc[wrong_type["type"] == "foul", "detail"] = "short"  # una falta no admite detalle
    with pytest.raises(SchemaError, match="detail"):
        validate_events(wrong_type)


def test_evento_sin_video_falla(mock_dir):
    ev = load_events(mock_dir).copy()
    ev.loc[0, "video_id"] = ""
    with pytest.raises(SchemaError, match="video_id"):
        validate_events(ev)


def test_catalogo_ampliado_es_valido(mock_dir):
    ev = load_events(mock_dir).copy()
    ev.loc[ev["type"] == "throw_in", "type"] = "goal_kick"
    ev.loc[ev["type"] == "goal_kick", "outcome"] = "kept"
    ev.loc[ev["type"] == "goal_kick", "detail"] = "long"
    validate_events(ev)


def test_metricas_forma_equipo(mock_dir):
    tr = load_tracking(mock_dir)
    s = team_shape(tr, "own")
    assert (s["n_players"] == 11).all() and (s["length"] > 0).all() and (s["width"] > 0).all()
    assert heatmap(tr, "own").sum() == len(tr[tr["team"] == "own"])

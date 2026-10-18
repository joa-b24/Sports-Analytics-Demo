import pandas as pd
import pytest

from sportsan.mock.generate import generate
from sportsan.io import load_ball, load_events, load_tracking
from sportsan.metrics.team_shape import heatmap, team_shape
from sportsan.schema import SchemaError, validate_events, validate_passes, validate_tracking


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


def test_destino_de_centros_y_remates(mock_dir):
    ev = load_events(mock_dir).copy()
    for c in ("x_end", "y_end", "goal_y", "goal_z"):
        ev[c] = float("nan")
    # Un córner que cae en el punto de penal y un tiro a la escuadra derecha.
    ev.loc[ev["type"] == "corner", ["x_end", "y_end"]] = [94.0, 34.0]
    ev.loc[ev["type"] == "shot", ["goal_y", "goal_z"]] = [7.0, 2.3]
    validate_events(ev)
    # Sin las columnas nuevas (archivos de antes) también vale.
    validate_events(load_events(mock_dir))

    wrong_type = ev.copy()
    wrong_type.loc[wrong_type["type"] == "foul", ["goal_y", "goal_z"]] = [3.0, 1.0]
    with pytest.raises(SchemaError, match="goal_y"):
        validate_events(wrong_type)

    half = ev.copy()
    half.loc[half["type"] == "corner", "y_end"] = float("nan")
    with pytest.raises(SchemaError, match="juntos"):
        validate_events(half)

    far = ev.copy()
    far.loc[far["type"] == "shot", "goal_z"] = 20.0
    with pytest.raises(SchemaError, match="portería"):
        validate_events(far)


def test_destino_de_centros_fuera_de_lugar(mock_dir):
    ev = load_events(mock_dir).copy()
    ev["x_end"], ev["y_end"] = float("nan"), float("nan")
    out = ev.copy()
    out.loc[out["type"] == "corner", ["x_end", "y_end"]] = [150.0, 34.0]
    with pytest.raises(SchemaError, match="fuera de la cancha"):
        validate_events(out)
    wrong = ev.copy()
    wrong.loc[wrong["type"] == "shot", ["x_end", "y_end"]] = [100.0, 34.0]
    with pytest.raises(SchemaError, match="x_end"):
        validate_events(wrong)
    with pytest.raises(SchemaError, match="pareja"):
        validate_events(ev.drop(columns=["y_end"]))


def _passes():
    return pd.DataFrame([
        {"pass_id": "a", "match_id": "m", "video_id": "v1", "t_video": 10.0, "period": 1, "team": "own",
         "from_id": "Ana", "to_id": "Bea", "outcome": "complete"},
        {"pass_id": "b", "match_id": "m", "video_id": "v1", "t_video": 12.0, "period": 1, "team": "own",
         "from_id": "Bea", "to_id": None, "outcome": "incomplete"},
    ])


def test_pases_validos():
    validate_passes(_passes())


@pytest.mark.parametrize("change", [
    {"to_id": [None, None]},          # un completo sin destinataria
    {"to_id": ["Bea", "Cris"]},       # un incompleto con destinataria
    {"team": ["own", "ref"]},
    {"outcome": ["complete", "lost"]},
    {"pass_id": ["a", "a"]},
    {"period": [1, 3]},
    {"video_id": ["v1", ""]},
    {"from_id": ["Ana", None]},
    {"match_id": [None, "m"]},
    {"t_video": [10.0, -1.0]},
    {"t_video": [10.0, float("nan")]},
])
def test_pases_invalidos(change):
    df = _passes()
    for k, v in change.items():
        df[k] = v
    with pytest.raises(SchemaError):
        validate_passes(df)


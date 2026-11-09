import pandas as pd
import pytest

from sportsan.mock.generate import generate
from sportsan.io import load_ball, load_events, load_possession, load_tracking
from sportsan.metrics.team_shape import heatmap, team_shape
from sportsan.schema import SchemaError, validate_events, validate_passes, validate_possession, validate_tracking


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



def test_duelo_con_resultado_y_detalle_es_valido(mock_dir):
    ev = load_events(mock_dir).copy()
    ev.loc[ev["type"] == "throw_in", "type"] = "duel"
    ev.loc[ev["type"] == "duel", "outcome"] = "won"
    ev.loc[ev["type"] == "duel", "detail"] = "aerial"
    validate_events(ev)
    ev.loc[ev["type"] == "duel", "detail"] = "long"
    with pytest.raises(SchemaError):
        validate_events(ev)


def test_fuera_de_lugar_es_un_tipo_valido_sin_resultado(mock_dir):
    ev = load_events(mock_dir).copy()
    ev.loc[ev["type"] == "throw_in", "type"] = "offside"
    validate_events(ev)
    ev.loc[ev["type"] == "offside", "outcome"] = "won"
    with pytest.raises(SchemaError):
        validate_events(ev)


def test_tarjetas_atajadas_y_cambios(mock_dir):
    base = load_events(mock_dir).copy().reset_index(drop=True)
    base["player_in"] = None
    # Filas propias para cada regla, sin depender de qué traiga el mock.
    foul, shot, sub, other = 0, 1, 2, 3
    base.loc[foul, ["type", "outcome", "detail"]] = ["foul", None, "yellow"]
    base.loc[shot, ["type", "outcome", "detail"]] = ["shot", "on_target", "saved"]
    base.loc[sub, ["type", "outcome", "detail", "x", "y", "player_id", "player_in"]] = ["substitution", None, None, None, None, "Sale", "Entra"]
    base.loc[other, ["type", "outcome", "detail"]] = ["loss", None, None]
    validate_events(base)
    ok_red = base.copy()
    ok_red.loc[foul, "detail"] = "red"
    validate_events(ok_red)

    def fails(change):
        ev = base.copy()
        change(ev)
        with pytest.raises(SchemaError):
            validate_events(ev)

    fails(lambda ev: ev.loc.__setitem__((foul, "detail"), "blue"))           # tarjeta que no existe
    fails(lambda ev: ev.loc.__setitem__((foul, "detail"), "saved"))          # atajada en una falta
    fails(lambda ev: ev.loc.__setitem__((shot, "outcome"), "off_target"))    # atajado pero fuera
    fails(lambda ev: ev.loc.__setitem__((shot, "outcome"), None))            # atajado sin resultado
    fails(lambda ev: ev.loc.__setitem__((other, "player_in"), "Otra"))       # quien entra en otro tipo
    fails(lambda ev: ev.loc.__setitem__((sub, "x"), 50.0))                   # un cambio con posición


# ---- posesión derivada (possession_<video_id>.csv) ----
_POSS_CSV = (
    "video_id,segment_id,t_start,t_end,team,first_player,last_player,kind,flags\n"
    'v1,s01,10,12.5,own,Ana,#7,control,"ball_source=manual"\n'
    'v1,s01,12.5,14,none,,,loose,"ball_interp,ball_source=interp,flight"\n'
    'v1,s02,14,20,opp,#3,#3,contested,"player_interp,ball_source=mixed,joined_cut"\n'
)


def _poss(rows=None):
    base = [
        dict(video_id="v1", segment_id="s01", t_start=0.0, t_end=2.0, team="own", first_player="Ana",
             last_player="Ana", kind="control", flags="ball_source=manual"),
        dict(video_id="v1", segment_id="s01", t_start=2.0, t_end=3.5, team="none", first_player=None,
             last_player=None, kind="loose", flags="ball_interp,ball_source=interp"),
        dict(video_id="v2", segment_id="s09", t_start=1.0, t_end=2.0, team="opp", first_player="#3",
             last_player="#3", kind="unknown", flags=""),
    ]
    return pd.DataFrame(rows or base)


def test_possession_valid():
    assert len(validate_possession(_poss())) == 3


def test_possession_missing_column():
    with pytest.raises(SchemaError, match="faltan columnas"):
        validate_possession(_poss().drop(columns=["kind"]))


@pytest.mark.parametrize("column,value", [("team", "ref"), ("kind", "wild")])
def test_possession_invalid_enum(column, value):
    df = _poss()
    df.loc[0, column] = value
    with pytest.raises(SchemaError, match=column):
        validate_possession(df)


@pytest.mark.parametrize("t_end", [0.0, -1.0])
def test_possession_end_not_after_start(t_end):
    df = _poss()
    df.loc[0, "t_end"] = t_end
    with pytest.raises(SchemaError):
        validate_possession(df)


def test_possession_overlap_same_video_only():
    df = _poss()
    df.loc[1, "t_start"] = 1.5  # solapa con la fila 0 en v1
    with pytest.raises(SchemaError, match="solapados"):
        validate_possession(df)
    df = _poss()
    df.loc[2, "video_id"] = "v1"
    df.loc[2, "t_start"] = 1.0  # v1 otra vez: solapa
    with pytest.raises(SchemaError, match="solapados"):
        validate_possession(df)


def test_possession_load_csv_as_written_by_app(tmp_path):
    path = tmp_path / "possession_v1.csv"
    path.write_text(_POSS_CSV, encoding="utf-8")
    df = load_possession(path)
    assert list(df["team"]) == ["own", "none", "opp"]
    assert df.loc[1, "flags"] == "ball_interp,ball_source=interp,flight"
    assert pd.isna(df.loc[1, "first_player"])
    assert len(load_possession(tmp_path)) == 3

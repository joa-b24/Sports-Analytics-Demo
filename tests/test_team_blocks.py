import numpy as np
import pandas as pd

from sportsan.metrics.team_blocks import frame_shape, play_time, team_bins


def frame(f, t, team, xs, ys):
    return [{"segment_id": "s", "frame": f, "t_video": t, "team": team, "x": x, "y": y} for x, y in zip(xs, ys)]


def block(team, base_x):
    # Una portera a 5 m de su línea y 10 de campo entre base_x y base_x + 18, de banda a banda (10 a 58).
    xs = [5.0] + [base_x + 2 * i for i in range(10)]
    ys = [34.0] + list(np.linspace(10, 58, 10))
    return xs, ys


def test_forma_de_un_cuadro_con_direccion():
    xs, ys = block("own", 30.0)
    s = frame_shape(pd.DataFrame(frame(0, 100.0, "own", xs, ys)), "own", own_attacks_right=True)
    r = s.iloc[0]
    assert r["valid"] and r["keeper_dropped"] and r["n_visible"] == 10
    assert r["width"] == 48.0 and r["length"] == 18.0
    assert r["line_height"] == np.mean([30, 32, 34, 36])  # las 4 más retrasadas
    # Atacando hacia la izquierda, la propia portería está en x = 105: la "portera" en x = 5 ya no va sola atrás.
    r2 = frame_shape(pd.DataFrame(frame(0, 100.0, "own", xs, ys)), "own", own_attacks_right=False).iloc[0]
    assert not r2["keeper_dropped"] and r2["line_height"] == np.mean([105 - 48, 105 - 46, 105 - 44, 105 - 42])


def test_sin_direccion_no_hay_alturas_y_pocas_visibles_no_cuentan():
    xs, ys = block("opp", 60.0)
    r = frame_shape(pd.DataFrame(frame(0, 1.0, "opp", xs, ys)), "opp", own_attacks_right=None).iloc[0]
    assert r["valid"] and np.isnan(r["line_height"]) and np.isnan(r["block_height"]) and not r["keeper_dropped"]
    few = frame_shape(pd.DataFrame(frame(0, 1.0, "own", [10, 20, 30], [10, 20, 30])), "own", True).iloc[0]
    assert not few["valid"] and np.isnan(few["width"])
    # El rival defiende la portería contraria.
    rows = frame(0, 1.0, "opp", [100.0] + [70 + 2 * i for i in range(10)], [34.0] + list(np.linspace(10, 58, 10)))
    r3 = frame_shape(pd.DataFrame(rows), "opp", True).iloc[0]
    assert r3["keeper_dropped"] and r3["line_height"] == np.mean([105 - 88, 105 - 86, 105 - 84, 105 - 82])


def test_reloj_de_juego_y_tramos():
    segs = pd.DataFrame({"start_s": [100.0, 400.0, 700.0], "end_s": [400.0, 700.0, 1000.0], "tipo": ["juego", "pausa", "juego"]})
    assert np.allclose(play_time([100, 399, 500, 700, 760], segs), [0, 299, np.nan, 300, 360], equal_nan=True)

    rows = []
    for k, t in enumerate(np.arange(100, 1000, 10.0)):
        xs, ys = block("own", 30.0 if t < 400 else 50.0)
        rows += frame(k, t, "own", xs, ys)
    shape = frame_shape(pd.DataFrame(rows), "own", True)
    bins = team_bins(shape, segs, bin_min=5)
    # 10 minutos de juego: el primer tramo es el de antes de la pausa, el segundo el de después; la pausa no cuenta.
    assert list(bins["bin"]) == [0, 1]
    assert bins.loc[0, "line_height"] == 33.0 and bins.loc[1, "line_height"] == 53.0
    assert (bins["valid_share"] == 1.0).all()
    sparse = team_bins(shape.iloc[::12], segs, bin_min=5)
    assert sparse["width"].isna().all()  # menos de 10 cuadros válidos por tramo


# ---------------------------------------------------------------- casos límite y NaN (L4)
from sportsan.metrics.report import build
from sportsan.metrics.team_shape import heatmap, team_shape

COLS = ["segment_id", "frame", "t_video", "team", "track_id", "x", "y"]


def _rows(xs, ys, team="own", frame=0, t=1.0):
    return pd.DataFrame({"segment_id": "s", "frame": frame, "t_video": t, "team": team, "track_id": range(len(xs)), "x": xs, "y": ys})


def test_tracking_vacio_no_revienta():
    e = pd.DataFrame(columns=COLS)
    assert frame_shape(e, "own", True).empty and team_shape(e).empty
    assert heatmap(e).sum() == 0
    segs = pd.DataFrame({"start_s": [0.0], "end_s": [100.0], "tipo": ["juego"]})
    r = build(e, segs, True)["teams"]["own"]
    assert r["frames"] == 0 and r["valid_frames"] == 0 and r["keeper_dropped_share"] == 0.0
    assert team_bins(frame_shape(e, "own", True), segs).empty


def test_nan_en_posicion_no_se_rellena_ni_cuenta():
    xs = [30.0 + i for i in range(8)]
    d = _rows(xs, [10.0 + 5 * i for i in range(8)])
    d.loc[0, "x"] = np.nan
    r = frame_shape(d, "own", True).iloc[0]
    assert r["n_visible"] == 7 and r["valid"]
    d.loc[1, "y"] = np.nan
    r = frame_shape(d, "own", True).iloc[0]
    assert r["n_visible"] == 6 and not r["valid"] and np.isnan(r["width"]) and np.isnan(r["line_height"])


def test_track_repetido_en_un_cuadro_cuenta_una_vez():
    d = _rows([30.0 + i for i in range(6)], [10.0 + 5 * i for i in range(6)])
    d = pd.concat([d, d.iloc[[0]]], ignore_index=True)  # 7 cajas, 6 personas
    assert frame_shape(d, "own", True).iloc[0]["n_visible"] == 6


def test_portera_sola_y_umbral_exacto():
    # Hueco exactamente de 8 m: no se quita (se exige MÁS de GK_GAP_M).
    xs = [5.0, 13.0] + [20.0 + i for i in range(6)]
    r = frame_shape(_rows(xs, list(range(8))), "own", True).iloc[0]
    assert not r["keeper_dropped"] and r["n_visible"] == 8
    # Un poco más: se quita.
    xs[0] = 4.9
    assert frame_shape(_rows(xs, list(range(8))), "own", True).iloc[0]["keeper_dropped"]


def test_defensa_sola_sin_portera_se_confunde_con_portera():
    # Limitación conocida: si la portera no sale en cuadro y la defensa más retrasada está a más de 8 m de las demás, se
    # toma por portera y se quita. Documentada en el informe de L4; el test fija el comportamiento.
    xs = [20.0] + [40.0 + i for i in range(7)]
    r = frame_shape(_rows(xs, list(range(8))), "own", True).iloc[0]
    assert r["keeper_dropped"] and r["n_visible"] == 7


def test_equipo_desconocido_o_ausente():
    d = _rows([30.0 + i for i in range(8)], list(range(8)))
    assert frame_shape(d, "opp", True).empty


def test_min_visible_personalizado():
    d = _rows([30.0, 40.0, 50.0], [10.0, 20.0, 30.0])
    r = frame_shape(d, "own", None, min_visible=3).iloc[0]
    assert r["valid"] and r["width"] == 20.0 and r["length"] == 20.0 and np.isnan(r["block_height"])


def test_play_time_ignora_tramos_sin_fin_y_fuera_de_juego():
    segs = pd.DataFrame({"start_s": [0.0, 100.0, 200.0], "end_s": [50.0, np.nan, 300.0], "tipo": ["juego", "juego", "juego"]})
    out = play_time([10, 60, 150, 250, 300], segs)
    assert np.allclose(out, [10, np.nan, np.nan, 100, np.nan], equal_nan=True)
    assert play_time([], segs).size == 0
    assert np.isnan(play_time([5.0], pd.DataFrame({"start_s": [], "end_s": [], "tipo": []}))).all()


def test_t_video_nan_se_descarta_no_se_inventa():
    d = _rows([30.0 + i for i in range(8)], list(range(8)), t=np.nan)
    assert frame_shape(d, "own", True).empty


def test_tramo_parcial_y_contado_de_cuadros():
    segs = pd.DataFrame({"start_s": [0.0], "end_s": [400.0], "tipo": ["juego"]})
    rows = []
    for k, t in enumerate(np.arange(0.0, 400.0, 5.0)):
        xs, ys = block("own", 30.0)
        if k % 2:  # la mitad de los cuadros con pocas jugadoras a la vista
            xs, ys = xs[:4], ys[:4]
        rows.append(_rows(xs, ys, frame=k, t=t))
    shape = frame_shape(pd.concat(rows), "own", True)
    b = team_bins(shape, segs, 5)
    assert list(b["bin"]) == [0, 1]
    assert b.loc[0, "valid_share"] == 0.5 and b.loc[0, "frames"] == 60 and b.loc[0, "valid_frames"] == 30
    assert b.loc[1, "frames"] == 20 and b.loc[1, "valid_frames"] == 10  # tramo parcial: 100 s de 300


def test_heatmap_bordes():
    d = pd.DataFrame({"team": "own", "x": [105.0, 0.0, -1.0, 106.0, np.nan], "y": [68.0, 0.0, 5.0, 5.0, 5.0]})
    h = heatmap(d)
    assert h.sum() == 2 and h[0, 0] == 1 and h[-1, -1] == 1  # los de fuera y el NaN no cuentan
    assert heatmap(d, team="opp").sum() == 0


def test_team_shape_ancho_y_largo():
    r = team_shape(_rows([10.0, 40.0], [5.0, 25.0])).iloc[0]
    assert r["length"] == 30.0 and r["width"] == 20.0 and r["n_players"] == 2


def test_report_build_json_sin_nan():
    import json
    segs = pd.DataFrame({"start_s": [0.0], "end_s": [400.0], "tipo": ["juego"]})
    d = _rows([30.0 + i for i in range(3)], [1.0, 2.0, 3.0])
    out = build(d, segs, None)
    json.dumps(out, allow_nan=False)  # NaN -> null

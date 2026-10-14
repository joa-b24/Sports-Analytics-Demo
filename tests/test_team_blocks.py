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

"""Forma de cada equipo a partir del tracking, por cuadro y por tramos de tiempo de juego. Funciones puras.

Lo que se mide de un equipo en un cuadro, con sus jugadoras de campo que salen en cuadro:
- ancho: distancia entre las dos más abiertas (a lo ancho de la cancha);
- largo: distancia entre la más adelantada y la más retrasada;
- altura de la línea: distancia media de las 4 más retrasadas a su propia portería;
- altura del bloque: distancia media de todas a su propia portería;
- centroide.

No hace falta saber quién es cada jugadora, solo su equipo. Dos cautelas, del contrato ("Cámara de seguimiento
automático"):
- La cámara no ve toda la cancha: un cuadro con menos de `min_visible` jugadoras de campo de un equipo no cuenta (NaN).
  Aun así, lo que se mide describe a las que se ven, sesgado hacia donde está la jugada.
- La portera se quita si va sola, a más de `GK_GAP_M` de la siguiente hacia su portería. Sin saber hacia dónde ataca
  cada equipo no se puede, y las alturas quedan en NaN.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from ..schema import PITCH_LENGTH_M

MIN_VISIBLE = 7
GK_GAP_M = 8.0
LINE_PLAYERS = 4
# Un tramo de tiempo necesita al menos estos cuadros válidos para dar un valor.
MIN_FRAMES_PER_BIN = 10
COLUMNS = ["width", "length", "line_height", "block_height", "centroid_x", "centroid_y"]


def depth(x: np.ndarray, team: str, own_attacks_right: bool | None) -> np.ndarray | None:
    """Distancia de cada posición a la portería propia del equipo (el analizado, `own`, defiende x = 0 si ataca hacia
    la derecha). None si no se sabe hacia dónde ataca."""
    if own_attacks_right is None:
        return None
    defends_left = own_attacks_right if team == "own" else not own_attacks_right
    return x if defends_left else PITCH_LENGTH_M - x


def _one_frame(x: np.ndarray, y: np.ndarray, team: str, own_attacks_right: bool | None, min_visible: int) -> dict:
    d = depth(x, team, own_attacks_right)
    keeper = False
    if d is not None and len(d) >= 2:
        order = np.argsort(d)
        if d[order[1]] - d[order[0]] > GK_GAP_M:
            keep = order[1:]
            x, y, d, keeper = x[keep], y[keep], d[keep], True
    n = len(x)
    row = {"n_visible": n, "keeper_dropped": keeper, "valid": n >= min_visible}
    if not row["valid"]:
        return {**row, **{c: np.nan for c in COLUMNS}}
    row.update(width=float(y.max() - y.min()), centroid_x=float(x.mean()), centroid_y=float(y.mean()))
    if d is None:
        row.update(length=float(x.max() - x.min()), line_height=np.nan, block_height=np.nan)
    else:
        row.update(length=float(d.max() - d.min()), line_height=float(np.sort(d)[:LINE_PLAYERS].mean()), block_height=float(d.mean()))
    return row


def frame_shape(tracking: pd.DataFrame, team: str, own_attacks_right: bool | None, min_visible: int = MIN_VISIBLE) -> pd.DataFrame:
    """Una fila por cuadro procesado del equipo `team` (own u opp), con las medidas de arriba y si el cuadro cuenta."""
    d = tracking[(tracking["team"] == team)].dropna(subset=["x", "y"])
    rows = []
    for (seg, frame, t), g in d.groupby(["segment_id", "frame", "t_video"], sort=True):
        rows.append({"segment_id": seg, "frame": frame, "t_video": t, **_one_frame(g["x"].to_numpy(float), g["y"].to_numpy(float), team, own_attacks_right, min_visible)})
    cols = ["segment_id", "frame", "t_video", "n_visible", "keeper_dropped", "valid", *COLUMNS]
    return pd.DataFrame(rows, columns=cols)


def play_time(t_video: pd.Series | np.ndarray, segments: pd.DataFrame) -> np.ndarray:
    """Segundos de juego transcurridos hasta cada instante, contando solo los tramos `juego` de segments.csv
    (columnas start_s, end_s, tipo). NaN fuera de los tramos de juego."""
    t = np.asarray(t_video, dtype=float)
    out = np.full(len(t), np.nan)
    played = 0.0
    for r in segments[segments["tipo"] == "juego"].sort_values("start_s").itertuples():
        inside = (t >= r.start_s) & (t < r.end_s)
        out[inside] = played + (t[inside] - r.start_s)
        played += r.end_s - r.start_s
    return out


def team_bins(shape: pd.DataFrame, segments: pd.DataFrame, bin_min: float = 5.0, min_frames: int = MIN_FRAMES_PER_BIN) -> pd.DataFrame:
    """Medianas por tramo de `bin_min` minutos de juego. `valid_share` dice qué parte de los cuadros contó; con menos de
    `min_frames` cuadros válidos el tramo queda en NaN."""
    clock = play_time(shape["t_video"], segments)
    s = shape.assign(bin=np.floor(clock / (bin_min * 60)))
    s = s[s["bin"].notna()]
    out = []
    for b, g in s.groupby("bin"):
        ok = g[g["valid"]]
        row = {
            "bin": int(b),
            "from_min": float(b * bin_min),
            "to_min": float((b + 1) * bin_min),
            "frames": int(len(g)),
            "valid_frames": int(len(ok)),
            "valid_share": float(len(ok) / len(g)) if len(g) else 0.0,
        }
        for c in COLUMNS:
            row[c] = float(ok[c].median()) if len(ok) >= min_frames else np.nan
        out.append(row)
    return pd.DataFrame(out, columns=["bin", "from_min", "to_min", "frames", "valid_frames", "valid_share", *COLUMNS])

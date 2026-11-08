from __future__ import annotations

import numpy as np
import pandas as pd

from ..schema import PITCH_LENGTH_M, PITCH_WIDTH_M


def team_shape(tracking: pd.DataFrame, team: str = "own") -> pd.DataFrame:
    """Forma del equipo por frame: centroide, largo (eje x), ancho (eje y), nº de jugadoras con posición.

    Solo describe a quienes salen en cuadro con posición; quien está fuera de cuadro no cuenta, así que con pocas
    visibles el centroide, el largo y el ancho se sesgan hacia donde está la jugada. Incluye a la portera. Las filas
    sin `t_video` se descartan. Para una forma con mínimo de visibles y alturas de línea, ver `team_blocks`."""
    d = tracking[(tracking["team"] == team)].dropna(subset=["x", "y"])
    g = d.groupby(["segment_id", "frame", "t_video"])
    out = g.agg(
        centroid_x=("x", "mean"),
        centroid_y=("y", "mean"),
        x_min=("x", "min"), x_max=("x", "max"),
        y_min=("y", "min"), y_max=("y", "max"),
        n_players=("track_id", "nunique"),
    ).reset_index()
    out["length"] = out["x_max"] - out["x_min"]
    out["width"] = out["y_max"] - out["y_min"]
    return out.drop(columns=["x_min", "x_max", "y_min", "y_max"])


def heatmap(tracking: pd.DataFrame, team: str = "own", bins: tuple[int, int] = (21, 14)) -> np.ndarray:
    """Mapa de calor (histograma 2D) de posiciones del equipo. Devuelve matriz [bins_y, bins_x].

    Cuenta posiciones-cuadro, no tiempo en cuadro de la cancha: las zonas que la cámara no ve salen frías aunque el
    equipo haya estado ahí. Las posiciones fuera de la cancha (0-105, 0-68) se ignoran."""
    d = tracking[tracking["team"] == team].dropna(subset=["x", "y"])
    h, _, _ = np.histogram2d(
        d["y"], d["x"], bins=(bins[1], bins[0]),
        range=[[0, PITCH_WIDTH_M], [0, PITCH_LENGTH_M]],
    )
    return h

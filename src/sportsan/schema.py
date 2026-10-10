"""Contrato de datos. La fuente de verdad en prosa es docs/data_contract.md.

Si cambias una columna aquí, actualiza el documento y los tests en el mismo commit.
Coordenadas: metros, origen en la esquina superior izquierda de la cancha,
x a lo largo (0-105), y a lo ancho (0-68).
"""
from __future__ import annotations

import pandas as pd

PITCH_LENGTH_M = 105.0
PITCH_WIDTH_M = 68.0
MARGIN_M = 3.0  # tolerancia fuera de las líneas por ruido de homografía

TEAMS = ("own", "opp", "ref", "unk")
PERIODS = (1, 2)
EVENT_TYPES = (
    "shot", "goal", "loss", "recovery", "foul", "corner",
    "free_kick", "throw_in", "penalty", "key_pass", "other",
)

TRACKING_COLUMNS = [
    "match_id", "segment_id", "frame", "t_local", "t_video",
    "track_id", "team", "player_id", "x", "y", "conf",
]
BALL_COLUMNS = [
    "match_id", "segment_id", "frame", "t_local", "t_video",
    "x", "y", "conf", "interpolated",
]
# Opcionales (el pipeline de tracking las escribe; validate_* no las exige)
OPTIONAL_TRACKING_COLUMNS = ["px", "py"]            # posición en píxeles (pie de la jugadora)
OPTIONAL_BALL_COLUMNS = ["px", "py"]
CALIB_COLUMNS = [                                    # calib_<segmento>.parquet
    "segment_id", "frame", "t_video", "n_keypoints", "n_inliers", "ok", "reason",
    *[f"h{i}" for i in range(9)],                    # homografía px -> m, aplanada
    *[f"fov{i}" for i in range(8)],                  # esquinas de la imagen en la cancha (x1,y1,...,x4,y4)
]

EVENT_COLUMNS = [
    "event_id", "match_id", "t_video", "period", "type", "team",
    "player_id", "x", "y", "outcome", "note",
]


class SchemaError(ValueError):
    """El DataFrame no cumple el contrato de datos."""


def _require(df: pd.DataFrame, cols: list[str], name: str) -> None:
    missing = [c for c in cols if c not in df.columns]
    if missing:
        raise SchemaError(f"{name}: faltan columnas {missing}")


def _check_in_pitch(df: pd.DataFrame, name: str) -> None:
    xy = df[["x", "y"]].dropna()
    out = xy[
        (xy["x"] < -MARGIN_M) | (xy["x"] > PITCH_LENGTH_M + MARGIN_M)
        | (xy["y"] < -MARGIN_M) | (xy["y"] > PITCH_WIDTH_M + MARGIN_M)
    ]
    if len(out):
        raise SchemaError(
            f"{name}: {len(out)} filas fuera de la cancha "
            f"(x en [0, {PITCH_LENGTH_M}], y en [0, {PITCH_WIDTH_M}], margen {MARGIN_M} m)"
        )


def validate_tracking(df: pd.DataFrame) -> pd.DataFrame:
    _require(df, TRACKING_COLUMNS, "tracking")
    bad = set(df["team"].dropna().unique()) - set(TEAMS)
    if bad:
        raise SchemaError(f"tracking: valores de team inválidos {sorted(bad)}; permitidos {TEAMS}")
    if df.duplicated(["segment_id", "frame", "track_id"]).any():
        raise SchemaError("tracking: hay filas duplicadas por (segment_id, frame, track_id)")
    if (df["t_video"] < df["t_local"]).any():
        raise SchemaError("tracking: t_video debe ser >= t_local (t_video = inicio del segmento + t_local)")
    if not df["conf"].dropna().between(0, 1).all():
        raise SchemaError("tracking: conf debe estar en [0, 1]")
    _check_in_pitch(df, "tracking")
    return df


def validate_ball(df: pd.DataFrame) -> pd.DataFrame:
    _require(df, BALL_COLUMNS, "ball")
    if df.duplicated(["segment_id", "frame"]).any():
        raise SchemaError("ball: hay filas duplicadas por (segment_id, frame)")
    _check_in_pitch(df, "ball")
    return df


def validate_events(df: pd.DataFrame) -> pd.DataFrame:
    _require(df, EVENT_COLUMNS, "events")
    if df["event_id"].duplicated().any():
        raise SchemaError("events: event_id duplicado")
    if not df["type"].isin(EVENT_TYPES).all():
        raise SchemaError(f"events: type inválido; permitidos {EVENT_TYPES}")
    if not df["team"].isin(TEAMS).all():
        raise SchemaError(f"events: team inválido; permitidos {TEAMS}")
    if not df["period"].isin(PERIODS).all():
        raise SchemaError(f"events: period inválido; permitidos {PERIODS}")
    if (df["t_video"] < 0).any():
        raise SchemaError("events: t_video no puede ser negativo")
    _check_in_pitch(df, "events")
    return df

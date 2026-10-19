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
    # Catálogo ampliado (2026-10-11, docs/preguntas_cuerpo_tecnico.md)
    "final_third_entry", "box_entry", "goal_kick", "cross",
    # Opcional (2026-10-17): solo en los partidos donde se quiere el mapa de duelos
    "duel",
    # 2026-10-19: fuera de lugar, con el equipo que lo comete (el de la jugadora adelantada)
    "offside",
)
# Valores permitidos de `outcome` y `detail` por tipo de evento. Los dos son opcionales (nulos = no se anotó);
# un tipo que no aparece aquí no admite ese campo.
EVENT_OUTCOMES = {
    "shot": ("on_target", "off_target", "blocked"),
    "corner": ("shot", "cleared", "play_on"),
    "free_kick": ("shot", "cleared", "play_on"),
    "cross": ("shot", "cleared", "play_on"),
    "goal_kick": ("kept", "lost"),
    "duel": ("won", "lost"),                 # del equipo del evento
}
EVENT_DETAILS = {
    "corner": ("inswing", "outswing", "short"),
    "goal_kick": ("short", "long"),
    "recovery": ("forward", "backward"),      # primer pase tras recuperar
    "duel": ("aerial", "ground"),
}

# Dónde acabó la acción (2026-10-14). Columnas opcionales: si faltan o van vacías, no se anotó.
# x_end, y_end: dónde cayó el balón de un centro o un córner, en la cancha (mismo sistema que x, y).
# goal_y, goal_z: dónde cruzó la línea de gol un remate, visto de frente desde quien remata: goal_y en metros desde el
# poste izquierdo (0 a 7.32 entre los postes), goal_z la altura (0 a 2.44 bajo el larguero). Un tiro fuera cae fuera de
# esos rangos.
END_TYPES = ("cross", "corner")
GOAL_TYPES = ("shot", "goal", "free_kick", "penalty")
GOAL_WIDTH_M = 7.32
GOAL_HEIGHT_M = 2.44
GOAL_MARGIN_M = 5.0  # hasta dónde se admite un tiro fuera alrededor de la portería
OPTIONAL_EVENT_COLUMNS = ["x_end", "y_end", "goal_y", "goal_z"]

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
    "event_id", "match_id", "video_id", "t_video", "period", "type", "team",
    "player_id", "x", "y", "outcome", "detail", "note",
]

# Pases etiquetados a mano (pasada 4 del etiquetado, 2026-10-16): quién se la pasa a quién, para la red de pases.
PASS_COLUMNS = ["pass_id", "match_id", "video_id", "t_video", "period", "team", "from_id", "to_id", "outcome"]
PASS_TEAMS = ("own", "opp")
PASS_OUTCOMES = ("complete", "incomplete")


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


def validate_passes(df: pd.DataFrame) -> pd.DataFrame:
    _require(df, PASS_COLUMNS, "passes")
    if df["pass_id"].duplicated().any():
        raise SchemaError("passes: pass_id duplicado")
    for column in ("pass_id", "match_id", "video_id", "from_id"):
        if df[column].isna().any() or (df[column].astype(str).str.strip() == "").any():
            raise SchemaError(f"passes: {column} no puede ir vacío")
    if df["t_video"].isna().any():
        raise SchemaError("passes: t_video no puede ir vacío")
    if not df["team"].isin(PASS_TEAMS).all():
        raise SchemaError(f"passes: team inválido; permitidos {PASS_TEAMS}")
    if not df["period"].isin(PERIODS).all():
        raise SchemaError(f"passes: period inválido; permitidos {PERIODS}")
    if not df["outcome"].isin(PASS_OUTCOMES).all():
        raise SchemaError(f"passes: outcome inválido; permitidos {PASS_OUTCOMES}")
    complete = df["outcome"] == "complete"
    if df.loc[complete, "to_id"].isna().any() or df.loc[~complete, "to_id"].notna().any():
        raise SchemaError("passes: to_id va solo en los completos (un pase incompleto no llega a nadie del equipo)")
    if (df["t_video"] < 0).any():
        raise SchemaError("passes: t_video no puede ser negativo")
    return df


def validate_events(df: pd.DataFrame) -> pd.DataFrame:
    _require(df, EVENT_COLUMNS, "events")
    if df["event_id"].duplicated().any():
        raise SchemaError("events: event_id duplicado")
    if df["video_id"].isna().any() or (df["video_id"].astype(str).str.strip() == "").any():
        raise SchemaError("events: video_id vacío (un partido de un solo video usa 'v1')")
    if not df["type"].isin(EVENT_TYPES).all():
        raise SchemaError(f"events: type inválido; permitidos {EVENT_TYPES}")
    if not df["team"].isin(TEAMS).all():
        raise SchemaError(f"events: team inválido; permitidos {TEAMS}")
    if not df["period"].isin(PERIODS).all():
        raise SchemaError(f"events: period inválido; permitidos {PERIODS}")
    if (df["t_video"] < 0).any():
        raise SchemaError("events: t_video no puede ser negativo")
    for column, allowed in (("outcome", EVENT_OUTCOMES), ("detail", EVENT_DETAILS)):
        filled = df[df[column].notna()]
        bad = [(t, v) for t, v in zip(filled["type"], filled[column]) if v not in allowed.get(t, ())]
        if bad:
            raise SchemaError(f"events: {column} inválido para su tipo: {sorted(set(bad))}; permitidos {allowed}")
    _check_in_pitch(df, "events")
    for columns, types in ((("x_end", "y_end"), END_TYPES), (("goal_y", "goal_z"), GOAL_TYPES)):
        present = [c for c in columns if c in df.columns]
        if len(present) == 1:
            raise SchemaError(f"events: {present[0]} sin su pareja ({' y '.join(columns)} van juntas)")
        if not present:
            continue
        filled = df[df[columns[0]].notna() | df[columns[1]].notna()]
        if filled[list(columns)].isna().any().any():
            raise SchemaError(f"events: {columns[0]} y {columns[1]} van juntos (uno sin el otro)")
        wrong = sorted(set(filled["type"]) - set(types))
        if wrong:
            raise SchemaError(f"events: {columns[0]}/{columns[1]} solo para {types}; aparecen en {wrong}")
    if all(c in df.columns for c in ("x_end", "y_end")):
        _check_in_pitch(df[["x_end", "y_end"]].rename(columns={"x_end": "x", "y_end": "y"}), "events (destino)")
    if all(c in df.columns for c in ("goal_y", "goal_z")):
        g = df[["goal_y", "goal_z"]].dropna()
        out = g[(g["goal_y"] < -GOAL_MARGIN_M) | (g["goal_y"] > GOAL_WIDTH_M + GOAL_MARGIN_M)
                | (g["goal_z"] < 0) | (g["goal_z"] > GOAL_HEIGHT_M + GOAL_MARGIN_M)]
        if len(out):
            raise SchemaError(f"events: {len(out)} remates fuera del marco admitido alrededor de la portería")
    return df

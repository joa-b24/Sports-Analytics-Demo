"""Carga de tablas del contrato (un archivo parquet o una carpeta de parquets)."""
from __future__ import annotations

from pathlib import Path

import pandas as pd

from .schema import validate_ball, validate_events, validate_possession, validate_tracking


def _read(path: str | Path, pattern: str) -> pd.DataFrame:
    path = Path(path)
    if path.is_dir():
        files = sorted(path.glob(pattern))
        if not files:
            raise FileNotFoundError(f"No hay archivos {pattern} en {path}")
        return pd.concat([pd.read_parquet(f) for f in files], ignore_index=True)
    return pd.read_parquet(path)


def load_tracking(path: str | Path) -> pd.DataFrame:
    return validate_tracking(_read(path, "tracking*.parquet"))


def load_ball(path: str | Path) -> pd.DataFrame:
    return validate_ball(_read(path, "ball*.parquet"))


def load_events(path: str | Path) -> pd.DataFrame:
    return validate_events(_read(path, "events*.parquet"))


def load_possession(path: str | Path) -> pd.DataFrame:
    """possession_<video_id>.csv (o una carpeta con varios) escrito por la app."""
    path = Path(path)
    files = sorted(path.glob("possession_*.csv")) if path.is_dir() else [path]
    if not files:
        raise FileNotFoundError(f"No hay archivos possession_*.csv en {path}")
    df = pd.concat(
        [pd.read_csv(f, dtype={"video_id": str, "segment_id": str, "first_player": str, "last_player": str, "flags": str}) for f in files],
        ignore_index=True,
    )
    return validate_possession(df)

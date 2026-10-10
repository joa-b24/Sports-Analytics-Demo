"""Carga de tablas del contrato (un archivo parquet o una carpeta de parquets)."""
from __future__ import annotations

from pathlib import Path

import pandas as pd

from .schema import validate_ball, validate_events, validate_tracking


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

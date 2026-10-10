"""Conversión entre tiempo de segmento y tiempo del video original (YouTube).

Regla: t_video = inicio_del_segmento + frame / video_fps.
Todo lo que se muestre al usuario (eventos, jugadas) usa t_video.
"""
from __future__ import annotations

import csv
import warnings
from pathlib import Path

import pandas as pd


def parse_hms(value) -> float:
    """'HH:MM:SS', 'MM:SS', 'SS' (con decimales opcionales) o número -> segundos."""
    if isinstance(value, (int, float)):
        return float(value)
    parts = str(value).strip().split(":")
    if not 1 <= len(parts) <= 3:
        raise ValueError(f"Tiempo inválido: {value!r}")
    seconds = 0.0
    for p in parts:
        seconds = seconds * 60 + float(p)
    return seconds


SEGMENT_COLUMNS = ("segment_id", "start", "end", "tipo")


def load_segments(path: str | Path) -> pd.DataFrame:
    """Lee segments.csv y agrega start_s, end_s, duration_s.

    Tolerante con lo que suele pasar al editar el CSV a mano o en Excel: BOM, separador `;` o tab,
    columnas extra (notas) y valores sobrantes al final de una fila (se ignoran con un aviso).
    """
    text = Path(path).read_text(encoding="utf-8-sig")
    lines = [ln for ln in text.splitlines()]
    if not lines:
        raise ValueError("segments.csv está vacío")
    delim = max(",;\t", key=lines[0].count)
    rows = list(csv.reader(lines, delimiter=delim))
    header = [h.strip() for h in rows[0]]
    missing = [c for c in SEGMENT_COLUMNS if c not in header]
    if missing:
        raise ValueError(f"segments.csv: faltan las columnas {missing}; encabezado leído: {header}")
    idx = [header.index(c) for c in SEGMENT_COLUMNS]

    data = []
    for n, row in enumerate(rows[1:], start=2):
        if not any(cell.strip() for cell in row):
            continue  # línea en blanco
        if len(row) <= max(idx):
            raise ValueError(f"segments.csv línea {n}: faltan valores (tiene {len(row)}): {row}")
        if len(row) > len(header):
            warnings.warn(f"segments.csv línea {n}: tiene {len(row)} valores y el encabezado {len(header)}; "
                          f"se ignoran los sobrantes: {row[len(header):]}", stacklevel=2)
        data.append({c: row[i].strip() for c, i in zip(SEGMENT_COLUMNS, idx)})

    df = pd.DataFrame(data, columns=list(SEGMENT_COLUMNS))
    df["start_s"] = df["start"].map(parse_hms)
    df["end_s"] = df["end"].map(parse_hms)
    df["duration_s"] = df["end_s"] - df["start_s"]
    if (df["duration_s"] <= 0).any():
        bad = df.loc[df["duration_s"] <= 0, "segment_id"].tolist()
        raise ValueError(f"segments.csv: end <= start en {bad}")
    return df


def frame_to_video_time(segment_start_s: float, frame: int, fps: float) -> float:
    return segment_start_s + frame / fps


def youtube_watch_url(video_id: str, t_s: float = 0) -> str:
    return f"https://www.youtube.com/watch?v={video_id}&t={int(t_s)}s"

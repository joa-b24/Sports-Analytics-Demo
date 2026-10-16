"""Volver a unir las cajas de una parte ya procesada, sin volver a detectar (lo lento).

Lee un `tracks_<video>_<inicio>_<fin>.json` y reconstruye lo que `process` tenía al cerrar la parte: por cuadro, las
cajas del seguidor y las sueltas, su color y su posición en metros reales de la sede (desde la calibración `H` del
cuadro y el pie de la caja). Sobre eso aplica la unión actual (`process.propose_identities`).

Sirve para medir con `sportsan.tracking.evaluate --method legacy` (o un cambio futuro a la unión) contra etiquetas hechas sobre el mismo archivo:
la clave de cada caja (cuadro, track original) no cambia.
"""
from __future__ import annotations

import numpy as np

from ..schema import PITCH_LENGTH_M, PITCH_WIDTH_M
from .process import EDGE_PX, on_pitch, propose_identities, to_meters
from .team import JERSEY_KEYS, hex_to_lab

Key = tuple[int, int]


def rebuild(tracks: dict) -> tuple[list[int], list[list[dict]], list[np.ndarray], list[np.ndarray]]:
    """Cuadros, cajas ({track_id, lab, edge}), posiciones en metros reales y si cada caja está en la cancha."""
    w, h = tracks.get("image_w", 1920), tracks.get("image_h", 1080)
    venue = tracks.get("venue") or {}
    length, width = float(venue.get("length_m") or PITCH_LENGTH_M), float(venue.get("width_m") or PITCH_WIDTH_M)
    frames, rows, meters, insides = [], [], [], []
    for fr in tracks["frames"]:
        boxes = fr["boxes"]
        H = np.asarray(fr["H"], dtype=float).reshape(3, 3) if fr.get("H") else None
        feet = np.array([[(b[1] + b[3]) / 2, b[4]] for b in boxes], dtype=float).reshape(-1, 2)
        m = to_meters(H, feet)
        frames.append(fr["frame"])
        rows.append([
            {"track_id": b[0], "lab": [b[6], b[7], b[8]],
             "edge": bool(b[1] <= EDGE_PX or b[3] >= w - EDGE_PX or b[4] >= h - EDGE_PX)}
            for b in boxes
        ])
        meters.append(m)
        insides.append(on_pitch(m * np.array([PITCH_LENGTH_M / length, PITCH_WIDTH_M / width])))
    return frames, rows, meters, insides


def match_refs(tracks: dict) -> dict[str, np.ndarray]:
    """Colores de uniforme del partido y video del archivo (match.yaml), o ninguno si no se encuentran."""
    try:
        from ..config import load_config

        colors = load_config(match=tracks["match_id"], video=tracks["video_id"]).get("jersey_colors") or {}
    except Exception:  # noqa: BLE001  (sin match.yaml se mide igual, sin equipos)
        return {}
    return {k: hex_to_lab(v) for k, v in colors.items() if k in JERSEY_KEYS and v}


def identities(tracks: dict, refs: dict[str, np.ndarray] | None = None) -> dict[Key, int | None]:
    """(cuadro, track) -> identidad propuesta con la unión actual; None para los duplicados que descarta."""
    frames, rows, meters, insides = rebuild(tracks)
    fps = float(tracks["fps"])
    prop = propose_identities(frames, rows, meters, insides, match_refs(tracks) if refs is None else refs, fps)
    out: dict[Key, int | None] = {(f, r["track_id"]): None for f, row in zip(frames, rows) for r in row}
    for f, row in zip(frames, prop["rows"]):
        for r in row:
            out[(f, r["track_id"])] = prop["ident_box"](f, r["track_id"])
    return out


def legacy_identities(tracks: dict, refs: dict[str, np.ndarray] | None = None) -> dict[Key, int | None]:
    return identities(tracks, refs)

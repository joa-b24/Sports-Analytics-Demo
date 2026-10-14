"""Forma de los equipos de un video a partir de su tracking, para la pestaña Análisis de la app.

Uso (desde la raíz del repo):
    python -m sportsan.metrics.report --match partido_2026_09_25
    python -m sportsan.metrics.report --match partido_2026_09_25 --own-attacks right

Lee las partes `tracking_<video>_*.parquet` (sin corregir: solo hace falta el equipo de cada persona, no quién es),
segments.csv para el tiempo de juego y, de match.yaml, hacia dónde ataca el equipo analizado en ese video
(`own_attacks: right` o `left`, dentro del video; `right` = hacia x = 105 en la cancha de la calibración).
Escribe `tracking/team_metrics_<video>.json`. Las funciones de cálculo están en metrics/team_blocks.py.
"""
from __future__ import annotations

import argparse
import json
import math

import pandas as pd

from ..config import load_config, project_root
from ..schema import validate_tracking
from ..timebase import load_segments
from .team_blocks import COLUMNS, MIN_VISIBLE, frame_shape, team_bins

BINS_MIN = (5, 10)


def _clean(v):
    return None if isinstance(v, float) and math.isnan(v) else v


def build(tracking: pd.DataFrame, segments: pd.DataFrame, own_attacks_right: bool | None) -> dict:
    """Resumen por equipo y por tramos de 5 y 10 min de juego (NaN -> null)."""
    out: dict = {"teams": {}}
    for team in ("own", "opp"):
        shape = frame_shape(tracking, team, own_attacks_right)
        out["teams"][team] = {
            "frames": int(len(shape)),
            "valid_frames": int(shape["valid"].sum()) if len(shape) else 0,
            "keeper_dropped_share": float(shape["keeper_dropped"].mean()) if len(shape) else 0.0,
            "bins": {str(b): [{k: _clean(v) for k, v in r.items()} for r in team_bins(shape, segments, b).to_dict("records")] for b in BINS_MIN},
        }
    return out


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="Forma de los equipos (ancho, largo, altura de la línea y del bloque) por tramos de tiempo de juego")
    ap.add_argument("--match")
    ap.add_argument("--video")
    ap.add_argument("--own-attacks", choices=["right", "left"], help="hacia dónde ataca el equipo analizado en este video (si no, own_attacks de match.yaml)")
    args = ap.parse_args(argv)

    cfg = load_config(match=args.match, video=args.video)
    root = project_root()
    tdir = root / cfg["paths"]["tracking_dir"]
    parts = sorted(tdir.glob(f"tracking_{cfg['video_id']}_*.parquet"))
    if not parts:
        raise SystemExit(f"No hay tracking_{cfg['video_id']}_*.parquet en {tdir}. Corre antes sportsan.tracking.process.")
    tracking = pd.concat([validate_tracking(pd.read_parquet(p)) for p in parts], ignore_index=True)
    seg_file = root / cfg["paths"]["segments_csv"]
    if not seg_file.exists():
        raise SystemExit(f"Falta {seg_file}: sin tramos no hay tiempo de juego.")
    segments = load_segments(seg_file, cfg["video_id"])
    video = next(v for v in cfg["videos"] if v["video_id"] == cfg["video_id"])
    attacks = args.own_attacks or video.get("own_attacks") or cfg.get("own_attacks")
    right = {"right": True, "left": False}.get(str(attacks)) if attacks else None

    teams_found = tracking["team"].value_counts().to_dict()
    result = {
        "schema_version": 1,
        "kind": "team_metrics",
        "match_id": cfg["match_id"],
        "video_id": cfg["video_id"],
        "source": "tracking sin corregir",
        "parts": len(parts),
        "own_attacks": attacks,
        "min_visible": MIN_VISIBLE,
        "measures": COLUMNS,
        **build(tracking, segments, right),
    }
    out = tdir / f"team_metrics_{cfg['video_id']}.json"
    out.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{cfg['match_id']} {cfg['video_id']}: {len(parts)} parte(s), personas por equipo en las filas: {teams_found}")
    for team, r in result["teams"].items():
        share = r["valid_frames"] / r["frames"] * 100 if r["frames"] else 0
        print(f"  {team}: {r['valid_frames']} de {r['frames']} cuadros con al menos {MIN_VISIBLE} jugadoras de campo a la vista ({share:.0f} %)")
    if right is None:
        print("  Sin own_attacks en match.yaml (ni --own-attacks): no hay alturas de línea ni de bloque, solo ancho, largo y centroide.")
    if teams_found.get("own", 0) == 0:
        print("  Ojo: ninguna persona tiene equipo. ¿Se procesó sin jersey_colors?")
    print(f"Escrito {out}")


if __name__ == "__main__":
    main()

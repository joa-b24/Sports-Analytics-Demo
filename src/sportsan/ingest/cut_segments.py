"""Corta del video original los segmentos marcados como 'juego' en segments.csv.

Uso (desde la raíz del repo):
    python -m sportsan.ingest.cut_segments                    # corta los que falten del partido por defecto
    python -m sportsan.ingest.cut_segments --match <match_id>  # otro partido
    python -m sportsan.ingest.cut_segments --force            # recorta todo otra vez
No modifica el video original ni segments.csv.
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
from pathlib import Path

from ..config import load_config, project_root
from ..timebase import load_segments


def find_ffmpeg() -> str:
    exe = os.environ.get("FFMPEG_PATH") or shutil.which("ffmpeg")
    if not exe:
        raise SystemExit(
            "No encuentro ffmpeg. Instálalo y reabre la terminal, o define la variable "
            "de entorno FFMPEG_PATH con la ruta completa a ffmpeg.exe."
        )
    return exe


def cut_segments(config_path: str | None = None, tipo: str = "juego", force: bool = False,
                 match: str | None = None) -> None:
    cfg = load_config(config_path, match)
    root = project_root()
    src = root / cfg["paths"]["raw_video"]
    out_dir = root / cfg["paths"]["segments_dir"]
    out_dir.mkdir(parents=True, exist_ok=True)
    segments = load_segments(root / cfg["paths"]["segments_csv"])
    ffmpeg = find_ffmpeg()

    for row in segments[segments["tipo"] == tipo].itertuples():
        out = out_dir / f"{row.segment_id}.mp4"
        if out.exists() and not force:
            print(f"ya existe, salto: {out.name}")
            continue
        subprocess.run(
            [ffmpeg, "-y", "-ss", row.start, "-to", row.end, "-i", str(src),
             "-c:v", "libx264", "-crf", "18", "-an", str(out)],
            check=True,
        )
        print(f"listo: {out.name}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=None)
    ap.add_argument("--match", default=None, help="match_id (carpeta en matches/)")
    ap.add_argument("--tipo", default="juego")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    cut_segments(a.config, a.tipo, a.force, a.match)

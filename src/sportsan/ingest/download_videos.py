"""Baja los videos registrados en matches/videos.csv que todavía no estén en su carpeta.

Uso (desde la raíz del repo, con .venv activado):
    python -m sportsan.ingest.download_videos              # todos los que falten
    python -m sportsan.ingest.download_videos --list       # solo dice qué hay y qué falta
    python -m sportsan.ingest.download_videos --match partido_ccm_vs_up

matches/videos.csv tiene una fila por video (un partido puede venir en varios):
    match_id     carpeta del partido en matches/ (convención aaaa_mm_dd_<local>_vs_<visitante>)
    kind         own (nuestro), rival o reference
    date         fecha del partido (AAAA-MM-DD), si se sabe
    own_team     equipo analizado (en un partido de rival, el rival que se estudia)
    other_team   su contrario
    video_id     v1, v2, v3... en el orden en que se juega
    period       1 o 2 (tiempo del partido), si se sabe
    label        qué parte es: "1.er tiempo", "Parte 2"...
    url          enlace de YouTube; una fila sin enlace se salta
    note         libre

Por cada video que falta: lo baja a matches/<match_id>/video/<video_id>.mp4 (1080p, solo imagen), mide su fps exacto
con ffprobe y lo añade a la lista `videos` de match.yaml si no estaba (crea match.yaml si el partido es nuevo).
No toca un video que ya existe ni lo que ya diga match.yaml de él.
"""
from __future__ import annotations

import argparse
import csv
import re
import shutil
import subprocess
import sys
from fractions import Fraction
from pathlib import Path

from ..config import MATCHES_DIR, project_root

COLUMNS = ["match_id", "kind", "date", "own_team", "other_team", "video_id", "period", "label", "url", "note"]
# 1080p solo imagen en mp4; si YouTube no lo ofrece, el mejor mp4 hasta 1080p.
FORMAT = "137/bestvideo[height<=1080][ext=mp4]"
# Sin estas opciones la descarga falla en esta computadora (certificados y reto de JavaScript de YouTube).
YTDLP_OPTS = ["--compat-options", "no-certifi", "--js-runtimes", "node", "--remote-components", "ejs:github"]


def youtube_id(url: str) -> str:
    """Id de 11 caracteres de un enlace de YouTube ("" si no lo es)."""
    m = re.search(r"(?:v=|youtu\.be/|shorts/|embed/)([\w-]{11})", url or "")
    return m.group(1) if m else ""


def read_registry(path: Path) -> list[dict]:
    with open(path, encoding="utf-8", newline="") as f:
        rows = [{k: (v or "").strip() for k, v in r.items()} for r in csv.DictReader(f)]
    missing = [c for c in COLUMNS if rows and c not in rows[0]]
    if missing:
        raise SystemExit(f"{path}: faltan columnas {missing}")
    return rows


def video_entry(row: dict, fps: float | None) -> str:
    """Bloque YAML de un video para la lista `videos` de match.yaml."""
    lines = [f"  - video_id: {row['video_id']}"]
    if row.get("period"):
        lines.append(f"    period: {row['period']}")
    if row.get("label"):
        lines.append(f'    label: "{row["label"]}"')
    lines.append(f'    youtube_id: "{youtube_id(row["url"])}"')
    lines.append(f"    file: video/{row['video_id']}.mp4")
    lines.append(f"    fps: {fps:.8g}" if fps else "    fps: REEMPLAZAR          # no se pudo medir: ffprobe")
    return "\n".join(lines) + "\n"


def add_video_to_yaml(text: str, row: dict, fps: float | None) -> str:
    """Añade el video al final de la lista `videos` (antes de la siguiente clave del archivo). Si ya está, no cambia nada."""
    if re.search(rf"^\s*-\s*video_id:\s*{re.escape(row['video_id'])}\s*$", text, re.M):
        return text
    lines = text.splitlines(keepends=True)
    start = next((i for i, line in enumerate(lines) if re.match(r"^videos:\s*(#.*)?$", line)), None)
    block = video_entry(row, fps)
    if start is None:
        return text.rstrip("\n") + "\n\nvideos:\n" + block
    end = start + 1
    last_item = start
    while end < len(lines) and (lines[end].startswith((" ", "\t", "#")) or not lines[end].strip()):
        if lines[end].strip() and not lines[end].lstrip().startswith("#"):
            last_item = end
        end += 1
    return "".join(lines[: last_item + 1] + [block] + lines[last_item + 1 :])


def new_match_yaml(row: dict) -> str:
    q = lambda v: f'"{v}"' if v else '"REEMPLAZAR"'  # noqa: E731
    return (
        f"match_id: {row['match_id']}\n"
        f"kind: {row['kind'] or 'own'}                       # own = partido nuestro; rival = scouting; reference = referencia\n"
        f"date: {q(row['date'])}\n"
        f"own_team_name: {q(row['own_team'])}\n"
        f"other_team_name: {q(row['other_team'])}\n"
        "analysis_stride: 3\n\n"
        "venue:\n"
        '  name: "REEMPLAZAR"\n\n'
        "# Un partido puede venir en varios videos. t_video es el tiempo dentro de cada video.\n"
        "videos:\n"
    )


def measure_fps(video: Path) -> float | None:
    exe = shutil.which("ffprobe")
    if not exe:
        return None
    r = subprocess.run([exe, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", str(video)],
                       capture_output=True, text=True)
    try:
        return float(Fraction(r.stdout.strip()))
    except (ValueError, ZeroDivisionError):
        return None


def ytdlp_cmd() -> list[str]:
    """yt-dlp del entorno activo, o el del Python del sistema."""
    for exe in (sys.executable, shutil.which("python"), shutil.which("py")):
        if exe and subprocess.run([exe, "-m", "yt_dlp", "--version"], capture_output=True).returncode == 0:
            return [exe, "-m", "yt_dlp"]
    raise SystemExit("No encuentro yt-dlp. Instálalo con: pip install yt-dlp")


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="Baja los videos de matches/videos.csv que falten")
    ap.add_argument("--match", help="solo este partido")
    ap.add_argument("--list", action="store_true", help="solo dice qué hay y qué falta")
    args = ap.parse_args(argv)

    root = project_root()
    registry = root / MATCHES_DIR / "videos.csv"
    rows = [r for r in read_registry(registry) if not args.match or r["match_id"] == args.match]
    todo = []
    for r in rows:
        folder = root / MATCHES_DIR / r["match_id"]
        target = folder / "video" / f"{r['video_id']}.mp4"
        state = "descargado" if target.exists() else ("falta" if youtube_id(r["url"]) else "sin enlace")
        print(f"  {r['match_id']:<28} {r['video_id']:<3} {r['label'] or '-':<14} {state}")
        if state == "falta":
            todo.append((r, folder, target))
    if args.list or not todo:
        print(f"{len(todo)} por bajar." if todo else "Nada por bajar.")
        return

    cmd = ytdlp_cmd()
    for n, (r, folder, target) in enumerate(todo, 1):
        print(f"\n[{n}/{len(todo)}] {r['match_id']} {r['video_id']} ({r['label']}) <- {r['url']}")
        (folder / "video").mkdir(parents=True, exist_ok=True)
        out = folder / "video" / f"{r['video_id']}.%(ext)s"
        done = subprocess.run([*cmd, *YTDLP_OPTS, "-f", FORMAT, "--merge-output-format", "mp4", "-o", str(out), r["url"]])
        if done.returncode != 0 or not target.exists():
            print(f"  No se pudo bajar {r['video_id']}; sigo con los demás.")
            continue
        fps = measure_fps(target)
        yaml_path = folder / "match.yaml"
        text = yaml_path.read_text(encoding="utf-8") if yaml_path.exists() else new_match_yaml(r)
        yaml_path.write_text(add_video_to_yaml(text, r, fps), encoding="utf-8")
        print(f"  Listo: {target.relative_to(root)} · {fps:.3f} cuadros/s" if fps else f"  Listo: {target.relative_to(root)} (fps sin medir)")
    print("\nSigue: en la app, cada video del partido con su enlace; luego Tramos y Calibración de cada uno.")


if __name__ == "__main__":
    main()

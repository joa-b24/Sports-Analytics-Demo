"""Corta los clips del informe de un partido (clips_<match_id>.json, exportado desde la app: Informe → «Exportar lista de
clips»). Un clip con `edit_id` y su `edits/edit_<id>.json` sale con sus dibujos y pausas (sportsan.clips.render); los
demás se cortan del video tal cual.

Uso (desde la raíz del repo):
    python -m sportsan.clips.cut_clips --match <carpeta del partido> [--profile charla|whatsapp] [--force]

Escribe en matches/<id>/clips/: <clip_id>_<perfil>.mp4 (o <edit_id>_<perfil>.mp4 si está editado). Lo que ya existe se
salta salvo con --force. Nunca modifica el video original.
"""
from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path

from ..config import project_root
from ..ingest.cut_segments import find_ffmpeg
from .render import PROFILES, find_video, render_edit


def plan_clips(clips: list[dict], folder: Path, profile: str) -> list[dict]:
    """Qué hacer con cada clip: `render` (tiene edición guardada) o `cut` (tramo sin dibujos), y dónde sale."""
    out = []
    for c in clips:
        edit = folder / "edits" / f"edit_{c['edit_id']}.json" if c.get("edit_id") else None
        if edit is not None and edit.exists():
            out.append({"action": "render", "clip": c, "edit": edit, "out": folder / "clips" / f"{c['edit_id']}_{profile}.mp4"})
        else:
            out.append({"action": "cut", "clip": c, "missing_edit": c.get("edit_id"), "out": folder / "clips" / f"{c['clip_id']}_{profile}.mp4"})
    return out


def cut_args(ffmpeg: str, video: Path, t0: float, t1: float, profile: str, out: Path) -> list[str]:
    """Un tramo del video original, recodificado con el perfil (sin audio; nunca más alto que el original)."""
    p = PROFILES[profile]
    return [
        ffmpeg, "-y", "-loglevel", "error", "-ss", f"{t0:.3f}", "-to", f"{t1:.3f}", "-i", str(video),
        "-an", "-vf", f"scale=-2:'min({p['height']},ih)'", "-c:v", "libx264", *p["codec"],
        "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(out),
    ]


def cut_clips(match: str, profile: str = "charla", force: bool = False) -> list[Path]:
    folder = project_root() / "matches" / match
    lists = sorted(folder.glob("clips_*.json"))
    if not lists:
        raise SystemExit(f"No hay clips_*.json en {folder}. Expórtalo desde la app: Informe → «Exportar lista de clips».")
    clips = [c for f in lists for c in json.loads(f.read_text(encoding="utf-8")).get("clips", [])]
    done = []
    for step in plan_clips(clips, folder, profile):
        out: Path = step["out"]
        if out.exists() and not force:
            print(f"ya existe, salto: {out.name}")
            done.append(out)
            continue
        if step["action"] == "render":
            done.append(render_edit(step["edit"], profile, force))
            continue
        if step["missing_edit"]:
            print(f"aviso: {step['clip']['clip_id']} tiene la edición {step['missing_edit']}, pero no está guardada en edits/; sale sin dibujos")
        c = step["clip"]
        out.parent.mkdir(parents=True, exist_ok=True)
        part = out.with_name(out.stem + ".part.mp4")
        subprocess.run(cut_args(find_ffmpeg(), find_video(folder, c["video_id"]), c["t_start"], c["t_end"], profile, part), check=True)
        part.replace(out)
        print(f"listo: {out.name}")
        done.append(out)
    return done


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="Corta los clips del informe de un partido (los editados, con sus dibujos).")
    ap.add_argument("--match", required=True, help="carpeta del partido en matches/")
    ap.add_argument("--profile", choices=sorted(PROFILES), default="charla")
    ap.add_argument("--force", action="store_true", help="vuelve a escribir aunque ya exista")
    a = ap.parse_args(argv)
    cut_clips(a.match, a.profile, a.force)


if __name__ == "__main__":
    main()

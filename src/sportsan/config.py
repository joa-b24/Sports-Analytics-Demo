"""Configuración: global (config/project.yaml) + la de cada partido (matches/<match_id>/match.yaml).

Cada partido vive en su carpeta:
    matches/<match_id>/match.yaml      datos del partido, sede y videos
    matches/<match_id>/segments.csv    tramos de juego
    matches/<match_id>/video/          video original (no se versiona)
    matches/<match_id>/segments/       segmentos cortados (no se versiona)
    matches/<match_id>/tracking/       parquets de tracking, balón y calibración
    matches/<match_id>/events/         parquets de eventos
"""
from __future__ import annotations

import os
from pathlib import Path

import yaml

MATCHES_DIR = "matches"


def project_root() -> Path:
    """Raíz del repo (la carpeta que contiene config/)."""
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "config" / "project.yaml").exists():
            return parent
    return Path.cwd()


def _read_yaml(path: Path) -> dict:
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def list_matches() -> list[str]:
    """match_id de todas las carpetas de matches/ que tienen match.yaml."""
    base = project_root() / MATCHES_DIR
    return sorted(p.parent.name for p in base.glob("*/match.yaml"))


def load_config(path: str | Path | None = None, match: str | None = None, video: str | None = None) -> dict:
    """Config global fusionada con la del partido, con las rutas ya resueltas (relativas a la raíz).

    match: match_id. Si no se da, se usa la variable de entorno SPORTSAN_MATCH y luego
           `default_match` de config/project.yaml.
    video: video_id dentro del partido (un partido puede venir en varios videos). Por defecto, el primero.
    """
    root = project_root()
    cfg = _read_yaml(Path(path) if path else root / "config" / "project.yaml")
    match_id = match or os.environ.get("SPORTSAN_MATCH") or cfg.get("default_match")
    if not match_id:
        raise ValueError("No hay partido: pasa match=..., define SPORTSAN_MATCH o `default_match` en config/project.yaml")

    rel = Path(MATCHES_DIR) / match_id
    match_file = root / rel / "match.yaml"
    if not match_file.exists():
        raise FileNotFoundError(f"No existe {match_file}. Partidos disponibles: {list_matches()}")
    m = _read_yaml(match_file)
    if m.get("match_id") != match_id:
        raise ValueError(f"{match_file}: match_id es {m.get('match_id')!r} y la carpeta se llama {match_id!r}")

    videos = m.get("videos") or []
    if not videos:
        raise ValueError(f"{match_file}: falta la lista `videos`")
    by_id = {v["video_id"]: v for v in videos}
    if video is not None and video not in by_id:
        raise ValueError(f"{match_file}: no hay video {video!r}; disponibles: {list(by_id)}")
    v = by_id[video] if video is not None else videos[0]

    cfg.update(m)
    cfg["video_id"] = v["video_id"]
    cfg["video_fps"] = v["fps"]
    cfg["youtube_id"] = v.get("youtube_id")
    # Colores de uniforme: los del video (cada video puede tener los suyos) o, si no, los del partido.
    # Si el video no trae los suyos, los del partido o, si no, los de otro video del mismo partido (mismo día, mismos
    # uniformes).
    cfg["jersey_colors"] = v.get("jersey_colors") or m.get("jersey_colors") or next((o["jersey_colors"] for o in videos if o.get("jersey_colors")), {})
    cfg["paths"] = {
        "match_dir": rel.as_posix(),
        "raw_video": (rel / v["file"]).as_posix(),
        "segments_csv": (rel / "segments.csv").as_posix(),
        "segments_dir": (rel / "segments").as_posix(),
        "tracking_dir": (rel / "tracking").as_posix(),
        "events_dir": (rel / "events").as_posix(),
        "mock_dir": (cfg.get("paths") or {}).get("mock_dir", "data/mock"),
    }
    return cfg

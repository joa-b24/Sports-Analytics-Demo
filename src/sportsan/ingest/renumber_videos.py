"""Renumera los videos de un partido (v1, v2, ...) para que sigan el orden cronológico, sin perder nada.

Caso típico: se empezó con el segundo tiempo como v1 y después se añade el primero; el primero debe ser v1 y el segundo v2.
Se cambia el mapa v1=v2,v2=v1 (un intercambio es su propio inverso: repetirlo lo deshace).

Uso (desde la raíz del repo; mejor desde el engrane del partido en la app, que además cambia lo que guarda el navegador):
    python -m sportsan.ingest.renumber_videos <carpeta_del_partido> --map v1=v2,v2=v1 [--dry-run]

Cambia dentro de matches/<carpeta>/:
  - los nombres de archivo que llevan el id del video como una palabra (video/v1.mp4, tracking/tracks_v1_0_900.json,
    anchors_<partido>_v1.json, library_v1.npz...), en dos tiempos para que no choquen;
  - el id dentro de los .json (llaves video_id / video / video_ids y los nombres de archivo que citan), de segments.csv,
    de match.yaml (video_id y file: video/vN.ext) y de los .parquet con columna video_id;
  - las filas de este partido en matches/videos.csv.
No toca el contenido del video ni los .npz (solo su nombre). Escribe matches/<carpeta>/renumber_videos.log.json con el mapa y
su inverso. Antes de cambiar nada comprueba que ningún archivo nuevo pise a otro.
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import re
from datetime import datetime
from pathlib import Path

from ..config import MATCHES_DIR, project_root

ID_RE = re.compile(r"^v\d+$")
# Un id de video como palabra dentro de un nombre de archivo o ruta: tracks_v1_0_9.json, video/v1.mp4, anchors_x_v2.json.
TOKEN = re.compile(r"(?<![A-Za-z0-9])v(\d+)(?![A-Za-z0-9])")
VIDEO_KEYS = {"video_id", "video", "videos", "video_ids"}
SKIP_DIRS = {".git", "__pycache__"}


def parse_map(text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for part in text.split(","):
        a, _, b = part.strip().partition("=")
        if not (ID_RE.match(a) and ID_RE.match(b)):
            raise ValueError(f"Mapa no válido: {part!r} (usa v1=v2,v2=v1)")
        if a in out:
            raise ValueError(f"{a} aparece dos veces en el mapa")
        out[a] = b
    out = {a: b for a, b in out.items() if a != b}
    if len(set(out.values())) != len(out):
        raise ValueError("Dos videos irían al mismo id")
    if not out:
        raise ValueError("El mapa no cambia nada")
    return out


def inverse(m: dict[str, str]) -> dict[str, str]:
    return {b: a for a, b in m.items()}


def map_name(name: str, m: dict[str, str]) -> str:
    """El nombre con los ids del mapa cambiados (todos a la vez, nunca en cadena)."""
    return TOKEN.sub(lambda t: m.get(f"v{t.group(1)}", t.group(0)), name)


def map_json(node, m: dict[str, str]):
    """Cambia los ids de video de un .json: llaves video_id / video / videos y los nombres de archivo que citan."""
    if isinstance(node, dict):
        out = {}
        for k, v in node.items():
            if k in VIDEO_KEYS:
                out[k] = _map_value(v, m)
            else:
                out[k] = map_json(v, m)
        return out
    if isinstance(node, list):
        return [map_json(x, m) for x in node]
    if isinstance(node, str) and re.fullmatch(r"[\w./-]+", node) and TOKEN.search(node) and ("_" in node or "/" in node or "." in node):
        return map_name(node, m)
    return node


def _map_value(v, m):
    if isinstance(v, str):
        return m.get(v, v) if ID_RE.match(v) else map_name(v, m)
    if isinstance(v, list):
        return [_map_value(x, m) for x in v]
    return map_json(v, m)


def map_yaml(text: str, m: dict[str, str]) -> str:
    def id_line(mo):
        return mo.group(1) + m.get(mo.group(2), mo.group(2)) + mo.group(3)

    text = re.sub(r"^(\s*-\s*video_id:\s*[\"']?)(v\d+)([\"']?)", id_line, text, flags=re.M)
    text = re.sub(r"^(\s+file:\s*[\"']?video/)(v\d+)(\.\w+[\"']?)", id_line, text, flags=re.M)
    return text


def map_csv(text: str, m: dict[str, str], only_match: str | None = None) -> str:
    """Cambia la columna video_id. Con only_match (videos.csv) solo las filas de ese partido."""
    rows = list(csv.reader(io.StringIO(text)))
    if not rows or "video_id" not in rows[0]:
        return text
    i = rows[0].index("video_id")
    for r in rows[1:]:
        if len(r) > i and (only_match is None or r[0] == only_match):
            r[i] = m.get(r[i], r[i])
    buf = io.StringIO()
    csv.writer(buf, lineterminator="\n").writerows(rows)
    return buf.getvalue()


def files_of(folder: Path) -> list[Path]:
    return sorted(p for p in folder.rglob("*") if p.is_file() and not (set(p.relative_to(folder).parts) & SKIP_DIRS))


def plan(folder: Path, m: dict[str, str]) -> list[tuple[Path, Path]]:
    """Qué archivo pasa a qué nombre; falla si un destino ya existe y no se está moviendo él mismo."""
    moves = [(p, p.with_name(map_name(p.name, m))) for p in files_of(folder)]
    moves = [(a, b) for a, b in moves if a != b]
    moving = {a for a, _ in moves}
    seen: set[Path] = set()
    for a, b in moves:
        if b in seen:
            raise FileExistsError(f"Dos archivos irían a {b.name}")
        seen.add(b)
        if b.exists() and b not in moving:
            raise FileExistsError(f"Ya existe {b.relative_to(folder).as_posix()} y no es parte del cambio")
    return moves


def renumber(root: Path, folder_name: str, m: dict[str, str], dry_run: bool = False) -> list[str]:
    folder = root / MATCHES_DIR / folder_name
    if not (folder / "match.yaml").exists():
        raise FileNotFoundError(f"No existe {folder / 'match.yaml'}")
    moves = plan(folder, m)
    report = [f"{a.relative_to(folder).as_posix()} -> {b.name}" for a, b in moves]
    if dry_run:
        return report + ["(además: id dentro de match.yaml, segments.csv, .json y .parquet con video_id; filas de videos.csv)"]
    # 1. Contenido, con los nombres viejos todavía en su sitio.
    yaml_path = folder / "match.yaml"
    yaml_path.write_text(map_yaml(yaml_path.read_text(encoding="utf-8"), m), encoding="utf-8")
    report.append("match.yaml")
    for p in files_of(folder):
        if p.suffix == ".json":
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, UnicodeDecodeError):
                continue
            new = map_json(data, m)
            if new != data:
                p.write_text(json.dumps(new, ensure_ascii=False) if p.stat().st_size > 200_000 else json.dumps(new, ensure_ascii=False, indent=1), encoding="utf-8")
                report.append(f"{p.relative_to(folder).as_posix()} (contenido)")
        elif p.suffix == ".csv":
            text = p.read_text(encoding="utf-8")
            new = map_csv(text, m)
            if new != text:
                p.write_text(new, encoding="utf-8")
                report.append(f"{p.relative_to(folder).as_posix()} (contenido)")
        elif p.suffix == ".parquet":
            import pandas as pd

            df = pd.read_parquet(p)
            if "video_id" in df.columns and df["video_id"].isin(list(m)).any():
                df["video_id"] = df["video_id"].map(lambda v: m.get(v, v))
                df.to_parquet(p, index=False)
                report.append(f"{p.relative_to(folder).as_posix()} (contenido)")
    csv_path = root / MATCHES_DIR / "videos.csv"
    if csv_path.exists():
        text = csv_path.read_text(encoding="utf-8")
        new = map_csv(text, m, only_match=folder_name)
        if new != text:
            csv_path.write_text(new, encoding="utf-8")
            report.append("videos.csv")
    # 2. Nombres, en dos tiempos (primero a un nombre temporal) para que v1 -> v2 y v2 -> v1 no choquen.
    moves = [(a, b) for a, b in moves if a.exists()]
    temps = []
    for a, b in moves:
        t = a.with_name(a.name + ".renumber_tmp")
        a.rename(t)
        temps.append((t, b))
    for t, b in temps:
        t.rename(b)
    log = {"at": datetime.now().isoformat(timespec="seconds"), "map": m, "undo": inverse(m)}
    (folder / "renumber_videos.log.json").write_text(json.dumps(log, ensure_ascii=False, indent=1), encoding="utf-8")
    report.append("renumber_videos.log.json")
    return report


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="Renumera los videos de un partido (v1, v2...) sin perder nada")
    ap.add_argument("match", help="carpeta del partido dentro de matches/")
    ap.add_argument("--map", required=True, help="por ejemplo v1=v2,v2=v1")
    ap.add_argument("--dry-run", action="store_true", help="solo dice qué cambiaría")
    args = ap.parse_args(argv)
    try:
        done = renumber(project_root(), args.match, parse_map(args.map), args.dry_run)
    except (ValueError, FileNotFoundError, FileExistsError, PermissionError) as e:
        raise SystemExit(str(e)) from e
    print(("Cambiaría:" if args.dry_run else "Cambiado:") + "\n  " + "\n  ".join(done))


if __name__ == "__main__":
    main()

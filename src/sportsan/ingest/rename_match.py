"""Renombra la carpeta de un partido según la convención, y su match_id dentro de los archivos.

Convención: aaaa_mm_dd_<local>_vs_<visitante>, en minúsculas, sin acentos ni espacios (letras, números y _).
La fecha es la del partido. Ejemplos: 2026_09_25_up_vs_anahuac, 2011_05_28_barcelona_vs_manchester_united.

Uso (desde la raíz del repo):
    python -m sportsan.ingest.rename_match partido_ccm_vs_up 2026_10_11_ccm_vs_up
    python -m sportsan.ingest.rename_match partido_ccm_vs_up 2026_10_11_ccm_vs_up --dry-run

Cambia: el nombre de la carpeta, `match_id` en match.yaml y en los .json/.parquet (tracking/, edits/, report_, clips_),
los nombres de archivo que llevan el match_id (anchors_<id>_v1.json, report_<id>.json...) y sus filas de
matches/videos.csv. No toca el video. Desde la app (engrane del partido, Carpeta, Renombrar) además pasan al nombre
nuevo la carpeta del partido, las correcciones de tracks, las anclas y las preferencias guardadas en el navegador; desde
la terminal queda anotado en matches/renames.json y la app lo aplica al abrirse.
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from ..config import MATCHES_DIR, project_root

FOLDER_RE = re.compile(r"^\d{4}_\d{2}_\d{2}_[a-z0-9]+(?:_[a-z0-9]+)*_vs_[a-z0-9]+(?:_[a-z0-9]+)*$")


def valid_folder(name: str) -> bool:
    """¿Sigue la convención aaaa_mm_dd_<local>_vs_<visitante>? Comprueba también que la fecha exista."""
    if not FOLDER_RE.match(name):
        return False
    y, m, d = (int(x) for x in name.split("_")[:3])
    from datetime import date

    try:
        date(y, m, d)
    except ValueError:
        return False
    return True


def rename_in_yaml(text: str, old: str, new: str) -> str:
    """Cambia la línea `match_id:` de match.yaml, conservando su comentario."""
    out, n = re.subn(rf"^(match_id:\s*[\"']?){re.escape(old)}([\"']?)", rf"\g<1>{new}\g<2>", text, count=1, flags=re.M)
    if n != 1:
        raise ValueError(f"match.yaml no tiene match_id: {old}")
    return out


def _files_with(folder: Path, old: str) -> list[Path]:
    """Archivos del partido (fuera de video/) cuyo nombre lleva el match_id: anchors_<id>_v1.json, report_<id>.json..."""
    return sorted(p for p in folder.rglob("*") if p.is_file() and p.relative_to(folder).parts[0] != "video" and f"_{old}" in p.name)


def _jsons(folder: Path) -> list[Path]:
    """Los .json del partido que pueden llevar match_id: tracking/, edits/ y los de la raíz (report_, clips_)."""
    out = [p for sub in ("tracking", "edits") if (folder / sub).exists() for p in sorted((folder / sub).glob("*.json"))]
    return out + sorted(folder.glob("*.json"))


def rename(root: Path, old: str, new: str, dry_run: bool = False) -> list[str]:
    """Hace el cambio y devuelve la lista de lo que tocó (o tocaría, con dry_run).

    Orden: primero la carpeta (si el video está abierto en otro programa, Windows no deja y no se ha tocado nada);
    después, dentro de la carpeta nueva, `match_id` de match.yaml y de los .json/.parquet, los nombres de archivo que
    llevan el match_id viejo y las filas de matches/videos.csv.
    """
    if not valid_folder(new):
        raise ValueError(f"{new!r} no sigue la convención aaaa_mm_dd_<local>_vs_<visitante> (minúsculas, sin acentos ni espacios)")
    src, dst = root / MATCHES_DIR / old, root / MATCHES_DIR / new
    if not (src / "match.yaml").exists():
        raise FileNotFoundError(f"No existe {src / 'match.yaml'}")
    if dst.exists():
        raise FileExistsError(f"Ya existe {dst}")
    yaml_new = rename_in_yaml((src / "match.yaml").read_text(encoding="utf-8"), old, new)
    csv_path = root / MATCHES_DIR / "videos.csv"
    csv_rows = csv_path.read_text(encoding="utf-8").splitlines(keepends=True) if csv_path.exists() else []
    csv_hits = sum(1 for line in csv_rows if line.split(",", 1)[0] == old)
    project = root / "config" / "project.yaml"
    project_text = project.read_text(encoding="utf-8") if project.exists() else ""
    default_re = re.compile(rf"^(default_match:\s*[\"']?){re.escape(old)}(?=[\"']?(\s|$))", re.M)
    is_default = bool(default_re.search(project_text))
    if dry_run:
        return (
            [f"carpeta -> {new}", "match.yaml"]
            + [f"{p.relative_to(src).as_posix()} (match_id)" for p in _jsons(src)]
            + [f"{p.relative_to(src).as_posix()} -> {p.name.replace(f'_{old}', f'_{new}')}" for p in _files_with(src, old)]
            + ([f"videos.csv ({csv_hits} fila(s))"] if csv_hits else [])
            + (["config/project.yaml (default_match)"] if is_default else [])
        )
    try:
        src.rename(dst)
    except PermissionError as e:
        raise PermissionError(f"No se pudo renombrar la carpeta (¿el video está abierto en otro programa?): {e}") from e
    done = [f"carpeta -> {new}"]
    (dst / "match.yaml").write_text(yaml_new, encoding="utf-8")
    done.append("match.yaml")
    for p in _jsons(dst):
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            continue
        if isinstance(data, dict) and data.get("match_id") == old:
            data["match_id"] = new
            p.write_text(json.dumps(data, ensure_ascii=False) if p.stat().st_size > 200_000 else json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
            done.append(p.relative_to(dst).as_posix())
    parquets = sorted((dst / "tracking").glob("*.parquet")) if (dst / "tracking").exists() else []
    if parquets:
        import pandas as pd

        from ..schema import validate_tracking

        for p in parquets:
            df = pd.read_parquet(p)
            if "match_id" in df.columns and (df["match_id"] == old).any():
                df["match_id"] = df["match_id"].replace(old, new)
                if p.name.startswith("tracking_"):
                    validate_tracking(df)
                df.to_parquet(p, index=False)
                done.append(p.relative_to(dst).as_posix())
    for p in _files_with(dst, old):
        target = p.with_name(p.name.replace(f"_{old}", f"_{new}"))
        if not target.exists():
            p.rename(target)
            done.append(f"{p.relative_to(dst).as_posix()} -> {target.name}")
    if csv_hits:
        csv_path.write_text("".join(new + line[len(old):] if line.split(",", 1)[0] == old else line for line in csv_rows), encoding="utf-8")
        done.append(f"videos.csv ({csv_hits} fila(s))")
    if is_default:
        project.write_text(default_re.sub(rf"\g<1>{new}", project_text, count=1), encoding="utf-8")
        done.append("config/project.yaml (default_match)")
    # Registro para la app: al abrirse pasa al nombre nuevo lo que el navegador guarda con el viejo (correcciones,
    # anclas, preferencias). Repetirlo no cambia nada.
    log = root / MATCHES_DIR / "renames.json"
    try:
        entries = json.loads(log.read_text(encoding="utf-8")) if log.exists() else []
    except json.JSONDecodeError:
        entries = []
    from datetime import datetime

    entries.append({"from": old, "to": new, "at": datetime.now().isoformat(timespec="seconds")})
    log.write_text(json.dumps(entries, ensure_ascii=False, indent=1), encoding="utf-8")
    done.append("matches/renames.json")
    return done


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="Renombra la carpeta de un partido según la convención aaaa_mm_dd_<local>_vs_<visitante>")
    ap.add_argument("old")
    ap.add_argument("new")
    ap.add_argument("--dry-run", action="store_true", help="solo dice qué cambiaría")
    args = ap.parse_args(argv)
    try:
        done = rename(project_root(), args.old, args.new, args.dry_run)
    except (ValueError, FileNotFoundError, FileExistsError, PermissionError) as e:
        raise SystemExit(str(e)) from e
    print(("Cambiaría:" if args.dry_run else "Cambiado:") + "\n  " + "\n  ".join(done))
    if not args.dry_run:
        print("La app pasa al nombre nuevo sus correcciones, anclas y preferencias la próxima vez que se abra (matches/renames.json).")


if __name__ == "__main__":
    main()

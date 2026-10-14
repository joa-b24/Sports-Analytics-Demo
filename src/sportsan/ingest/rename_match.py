"""Renombra la carpeta de un partido según la convención, y su match_id dentro de los archivos.

Convención: aaaa_mm_dd_<local>_vs_<visitante>, en minúsculas, sin acentos ni espacios (letras, números y _).
La fecha es la del partido. Ejemplos: 2026_09_25_up_vs_anahuac, 2011_05_28_barcelona_vs_manchester_united.

Uso (desde la raíz del repo):
    python -m sportsan.ingest.rename_match partido_ccm_vs_up 2026_10_11_ccm_vs_up
    python -m sportsan.ingest.rename_match partido_ccm_vs_up 2026_10_11_ccm_vs_up --dry-run

Cambia: el nombre de la carpeta, `match_id` en match.yaml y `match_id` en los .json y .parquet de tracking/.
No toca el video. En la app hay que escribir la carpeta nueva en el partido (editar datos); las correcciones de tracks
hechas con el nombre viejo se quedan con él (están guardadas por match_id).
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


def rename(root: Path, old: str, new: str, dry_run: bool = False) -> list[str]:
    """Hace el cambio y devuelve la lista de lo que tocó (o tocaría, con dry_run)."""
    if not valid_folder(new):
        raise ValueError(f"{new!r} no sigue la convención aaaa_mm_dd_<local>_vs_<visitante> (minúsculas, sin acentos ni espacios)")
    src, dst = root / MATCHES_DIR / old, root / MATCHES_DIR / new
    if not (src / "match.yaml").exists():
        raise FileNotFoundError(f"No existe {src / 'match.yaml'}")
    if dst.exists():
        raise FileExistsError(f"Ya existe {dst}")
    done: list[str] = []
    yaml_path = src / "match.yaml"
    yaml_new = rename_in_yaml(yaml_path.read_text(encoding="utf-8"), old, new)
    done.append("match.yaml")
    jsons = sorted((src / "tracking").glob("*.json")) if (src / "tracking").exists() else []
    parquets = sorted((src / "tracking").glob("*.parquet")) if (src / "tracking").exists() else []
    if dry_run:
        return done + [f"tracking/{p.name}" for p in jsons + parquets] + [f"carpeta -> {new}"]
    yaml_path.write_text(yaml_new, encoding="utf-8")
    for p in jsons:
        data = json.loads(p.read_text(encoding="utf-8"))
        if isinstance(data, dict) and data.get("match_id") == old:
            data["match_id"] = new
            p.write_text(json.dumps(data, ensure_ascii=False) if p.stat().st_size > 200_000 else json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
            done.append(f"tracking/{p.name}")
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
                done.append(f"tracking/{p.name}")
    src.rename(dst)
    done.append(f"carpeta -> {new}")
    return done


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="Renombra la carpeta de un partido según la convención aaaa_mm_dd_<local>_vs_<visitante>")
    ap.add_argument("old")
    ap.add_argument("new")
    ap.add_argument("--dry-run", action="store_true", help="solo dice qué cambiaría")
    args = ap.parse_args(argv)
    try:
        done = rename(project_root(), args.old, args.new, args.dry_run)
    except (ValueError, FileNotFoundError, FileExistsError) as e:
        raise SystemExit(str(e)) from e
    print(("Cambiaría:" if args.dry_run else "Cambiado:") + "\n  " + "\n  ".join(done))
    if not args.dry_run:
        print(f"En la app: abre el partido, «editar datos» y escribe la carpeta {args.new}.")


if __name__ == "__main__":
    main()

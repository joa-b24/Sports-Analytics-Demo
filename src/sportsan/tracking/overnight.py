"""Todo el tracking pendiente de una sola vez (para dejarlo corriendo de noche).

Recorre matches/videos.csv y, por cada video descargado, hace lo que le falte en este orden:
1. propagación de las anclas del barrido (si no hay biblioteca): necesita `tracking/anchors_<partido>_<video>.json`,
   que la app guarda al exportar las anclas desde la pestaña Calibración;
2. biblioteca de calibración (`library_<video>.npz`) a partir de esa propagación;
3. detección + calibración de los tramos de juego del video (`process`), reanudable por partes.

Un video al que le falte algo (tramos en segments.csv, anclas) se salta con un aviso, y si un paso falla sigue con el
siguiente video. Los partidos nuestros van primero, los de rivales y referencia después.

Uso (desde la raíz del repo, con .venv activado):
    python -m sportsan.tracking.overnight --plan      # qué haría y cuánto tardaría, sin hacer nada
    python -m sportsan.tracking.overnight             # hacerlo
    python -m sportsan.tracking.overnight --match partido_ccm_vs_up
    python -m sportsan.tracking.overnight --jobs 2        # opcional: 2 videos a la vez (tope seguro por hilos y memoria)
    python -m sportsan.tracking.overnight --workers 2     # opcional: 2 partes a la vez dentro de cada video
Sin --jobs ni --workers (1 y 1) todo corre en serie, como siempre. El progreso (% y ETA) se escribe también en
matches/overnight_progress.log. Ver tracking/parallel.py para el tope.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

from ..config import MATCHES_DIR, load_config, project_root
from ..ingest.download_videos import registry_with_yaml
from ..timebase import load_segments

# Segundos de cálculo por segundo de juego, a 1 de cada 3 cuadros en esta laptop (medido: 35.6 min en 2 h 04 min).
COST_PER_PLAY_S = 3.5
KIND_ORDER = {"own": 0, "rival": 1, "reference": 2}


@dataclass
class VideoPlan:
    match_id: str
    video_id: str
    steps: list[str] = field(default_factory=list)   # propagate, library, process
    missing: str | None = None                        # por qué no se puede, si falta algo
    play_s: float = 0.0
    done_s: float = 0.0                               # juego ya procesado (partes hechas)
    anchors: Path | None = None
    stride: int = 3
    fps: float = 30.0

    def estimate_s(self) -> float:
        if self.missing or "process" not in self.steps:
            return 0.0
        # El costo va con los cuadros procesados por segundo de juego: fps / stride (10 en la medición).
        rate = (self.fps / self.stride) / 10.0
        return max(0.0, self.play_s - self.done_s) * COST_PER_PLAY_S * rate + (300 if "library" in self.steps else 0)


def plan_video(root: Path, match_id: str, video_id: str) -> VideoPlan:
    """Qué le falta a un video. No ejecuta nada."""
    p = VideoPlan(match_id, video_id)
    try:
        cfg = load_config(match=match_id, video=video_id)
    except FileNotFoundError as e:
        p.missing = f"configuración: {e}"
        return p
    except ValueError as e:
        p.missing = "video sin descargar (python -m sportsan.ingest.download_videos)" if "no hay video" in str(e) else f"configuración: {e}"
        return p
    p.stride = int(cfg.get("analysis_stride") or 3)
    p.fps = float(cfg.get("video_fps") or 30.0)
    tdir = root / cfg["paths"]["tracking_dir"]
    if not (root / cfg["paths"]["raw_video"]).exists():
        p.missing = "video sin descargar"
        return p
    seg_file = root / cfg["paths"]["segments_csv"]
    segs = load_segments(seg_file, video_id) if seg_file.exists() else None
    play = segs[segs["tipo"] == "juego"] if segs is not None else None
    if play is None or play.empty:
        p.missing = "faltan los tramos de juego de este video en segments.csv (pestaña Tramos)"
        return p
    p.play_s = float((play["end_s"] - play["start_s"]).sum())
    if not (tdir / f"library_{video_id}.npz").exists():
        anchors = tdir / f"anchors_{match_id}_{video_id}.json"
        if not anchors.exists():
            p.missing = f"faltan las anclas del barrido ({anchors.name}; pestaña Calibración -> Exportar anclas)"
            return p
        p.anchors = anchors
        p.steps += ["propagate", "library"]
    index = tdir / f"tracks_{video_id}_index.json"
    if index.exists():
        chunks = json.loads(index.read_text(encoding="utf-8")).get("chunks", [])
        p.done_s = sum(c["end_s"] - c["start_s"] for c in chunks if "calibrated_share" in c and (tdir / c["file"]).exists())
    if p.play_s - p.done_s > 1 or "library" in p.steps:
        p.steps.append("process")
    return p


def newest(folder: Path, pattern: str) -> Path | None:
    files = sorted(folder.glob(pattern), key=lambda f: f.stat().st_mtime)
    return files[-1] if files else None


def fmt(seconds: float) -> str:
    m = int(round(seconds / 60))
    return f"{m // 60} h {m % 60:02d} min" if m >= 60 else f"{m} min"


def run(cmd: list[str], prefix: str = "") -> bool:
    """Corre un paso. Con `prefix` (varios videos a la vez) cada línea de su salida lleva la etiqueta del video."""
    print(f"    {prefix}$ " + " ".join(cmd[2:]), flush=True)
    if not prefix:
        return subprocess.run(cmd).returncode == 0
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace", bufsize=1)
    for line in proc.stdout:
        print(f"    {prefix}{line.rstrip()}", flush=True)
    return proc.wait() == 0


def run_video(p: "VideoPlan", root: Path, workers: int, prefix: str = "") -> bool:
    """Los pasos pendientes de un video, en orden. Con `workers` > 1, `process` reparte las partes en procesos."""
    py = [sys.executable, "-m"]
    print(f"\n== {p.match_id} {p.video_id} ({time.strftime('%H:%M')}) ==", flush=True)
    tdir = root / MATCHES_DIR / p.match_id / "tracking"
    ok = True
    if "propagate" in p.steps:
        ok = run([*py, "sportsan.tracking.propagate", "--anchors", str(p.anchors)], prefix)
        calib = newest(tdir, f"calib_{p.video_id}_*.json") if ok else None
        ok = ok and calib is not None and run([*py, "sportsan.tracking.library", "build", "--track", str(calib)], prefix)
    if "process" in p.steps:
        cmd = [*py, "sportsan.tracking.process", "--match", p.match_id, "--video", p.video_id]
        if workers > 1:
            cmd += ["--workers", str(workers)]
        ok = ok and run(cmd, prefix)
    return ok


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="Propagación, biblioteca y tracking de todos los videos que falten")
    ap.add_argument("--match", help="solo este partido")
    ap.add_argument("--plan", action="store_true", help="solo dice qué haría y cuánto tardaría")
    ap.add_argument("--jobs", type=int, default=1, help="videos a la vez (1 = en serie, como siempre); se recorta a un tope seguro")
    ap.add_argument("--workers", type=int, default=1, help="partes a la vez dentro de cada video (1 = como siempre); se recorta a un tope seguro")
    args = ap.parse_args(argv)

    root = project_root()
    rows = [r for r in registry_with_yaml(root) if not args.match or r["match_id"] == args.match]
    rows.sort(key=lambda r: (KIND_ORDER.get(r["kind"], 3), r["match_id"], r["video_id"]))
    plans = [plan_video(root, r["match_id"], r["video_id"]) for r in rows]
    total = sum(p.estimate_s() for p in plans)
    print("Plan:")
    for p in plans:
        if p.missing:
            what = f"se salta: {p.missing}"
        elif not p.steps:
            what = f"listo ({fmt(p.play_s)} de juego ya procesados)"
        else:
            what = f"{' -> '.join(p.steps)} · {fmt(p.play_s - p.done_s)} de juego por procesar · ~{fmt(p.estimate_s())}"
        print(f"  {p.match_id:<28} {p.video_id:<3} {what}")
    print(f"Estimado: ~{fmt(total)} (la parte de detección; las partes ya hechas se saltan y lo acortan).")
    if args.plan:
        return

    from .parallel import ProgressLog, safe_workers

    todo = [p for p in plans if not p.missing and p.steps]
    jobs, workers = max(1, args.jobs), max(1, args.workers)
    if jobs * workers > 1:
        total_procs = safe_workers(jobs * workers)
        jobs = min(jobs, total_procs, max(1, len(todo)))
        workers = max(1, total_procs // jobs)
        print(f"Paralelo: {jobs} video(s) a la vez x {workers} proceso(s) de partes.", flush=True)
    log = ProgressLog("overnight", max(1.0, sum(max(p.estimate_s(), 1.0) for p in todo)), root / MATCHES_DIR / "overnight_progress.log")
    t0 = time.time()

    def one(p: VideoPlan) -> str:
        ok = run_video(p, root, workers, f"[{p.match_id} {p.video_id}] " if jobs > 1 else "")
        log.step(max(p.estimate_s(), 1.0), f"{p.match_id} {p.video_id}: {'listo' if ok else 'FALLÓ'}")
        return f"{p.match_id} {p.video_id}: {'listo' if ok else 'FALLÓ (ver arriba)'}"

    if jobs > 1:
        from concurrent.futures import ThreadPoolExecutor

        with ThreadPoolExecutor(max_workers=jobs) as ex:
            done = list(ex.map(one, todo))
    else:
        done = [one(p) for p in todo]
    print(f"\nTerminado en {fmt(time.time() - t0)}:")
    for line in done:
        print(f"  {line}")


if __name__ == "__main__":
    main()

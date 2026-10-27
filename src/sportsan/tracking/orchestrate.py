"""Orquestadores de línea de comandos de los dos comandos generales del tracking (la app los lanza con un panel).

    python -m sportsan.tracking.pipeline tracking  --match <id> [--video v1] [--quick] [--plan] [--resume] [--band-margin M]
    python -m sportsan.tracking.pipeline fill-ball --match <id> [--video v1] [--model weights/ball_model_...pt] [--plan] [--resume]

(`pipeline.py` es el módulo del pipeline antiguo; solo delega aquí cuando se ejecuta con `-m`, antes de importar nada pesado.)

`tracking`, por video y en este orden: propagación de anclas (A3) -> biblioteca de calibración -> process (detección,
calibración y su suavizado, equipos, tracks_*.json) -> identificación de tracklets y sugerencias de anclas
(suggest_<parte>.json) para todos los tramos de juego.
  --quick  no corre completo: procesa ~60 s al inicio del primer tramo de juego del video con los mismos pasos y deja el
           informe en tracking/revision/quick/ (summary.json, check.txt, calib_*.json de `library check`, parte de prueba).
           No escribe nada fuera de esa carpeta salvo lo que ya son pasos compartidos (propagación y biblioteca).
  --resume salta lo que ya está hecho y es más nuevo que sus entradas (sin él, las sugerencias y el informe quick se
           recalculan; la biblioteca solo se reconstruye si falta o es más vieja que las anclas; process nunca vuelve a
           hacer una parte que existe, salvo con --force).
  Nunca toca tracks_fixed_* ni revisiones de la analista. Las partes con anclas o tracks_fixed no se sugieren ni se
  reprocesan sin --force.

`fill-ball`, por cada parte con anclas de la analista (tracking/auto/anchors_<parte>.json): relleno completo (variante
exp, tramos -> links_<parte>_exp_tramos.json) y luego el balón automático (ball run --accept 0.95; no pisa ball_auto_*
sin --force).

Los dos escriben, en tracking/revision/:
  progreso_pipeline_<comando>.log   líneas "HH:MM:SS fase n/N pct% ETA Ns (total Ns)" (mismo formato que `ball run`)
  pipeline_<comando>.json           {state: idle|running|done|error, stage, video, part, pct, eta_s, started, message, ...}
Códigos de salida: 0 bien, 1 falló una etapa, 2 precondición o uso, 3 terminó pero omitió etapas, 130 Ctrl+C (reanudable).
"""
from __future__ import annotations

import argparse
import contextlib
import io
import json
import os
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from .. import config
from ..timebase import load_segments
from .ball import MODEL_NAME, progress_line
from .detect import Chunk, plan_chunks
from .overnight import COST_PER_PLAY_S

EXIT_OK, EXIT_FAILED, EXIT_PRECONDITION, EXIT_PARTIAL, EXIT_INTERRUPTED = 0, 1, 2, 3, 130

# Costos aproximados (s) de lo que no está medido; solo sirven para repartir el porcentaje y estimar. process usa el medido.
PROPAGATE_S, LIBRARY_S, CHECK_S = 300.0, 120.0, 120.0
SUGGEST_PER_PLAY_S, FILL_PER_PLAY_S, BALL_PER_PLAY_S = 0.05, 0.10, 0.15
MIN_STAGE_S = 20.0
TICK_S = 5.0


# ------------------------------------------------------------------------------------------------ ejecución de comandos

def run_subprocess(cmd: list[str], tick: Callable[[], None] | None = None) -> int:
    """Lanza un comando y espera; llama a `tick` cada pocos segundos (para medir avance). Los tests reemplazan esta función."""
    print("    $ " + " ".join(cmd[1:]), flush=True)
    p = subprocess.Popen(cmd)
    try:
        while True:
            try:
                return p.wait(timeout=TICK_S)
            except subprocess.TimeoutExpired:
                if tick:
                    tick()
    except BaseException:
        p.terminate()
        try:
            p.wait(timeout=15)
        except subprocess.TimeoutExpired:
            p.kill()
        raise


RUNNER: Callable[..., int] = run_subprocess


def py(module: str, *args: str) -> list[str]:
    return [sys.executable, "-m", f"sportsan.tracking.{module}", *args]


def pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if sys.platform == "win32":
        import ctypes

        k = ctypes.windll.kernel32
        h = k.OpenProcess(0x1000, False, pid)          # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return False
        code = ctypes.c_ulong()
        k.GetExitCodeProcess(h, ctypes.byref(code))
        k.CloseHandle(h)
        return code.value == 259                        # STILL_ACTIVE
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


# ------------------------------------------------------------------------------------------------ estado y progreso

class Reporter:
    """Escribe el log de progreso y el JSON de estado que lee la app."""

    def __init__(self, rev_dir: Path, command: str, total_s: float):
        self.rev = rev_dir
        self.log_path = rev_dir / f"progreso_pipeline_{command}.log"
        self.state_path = rev_dir / f"pipeline_{command}.json"
        self.total = max(1.0, total_s)
        self.done = 0.0
        self.t0 = time.time()
        self.phase_t0 = self.t0
        self.phase = ""
        self.state: dict = {"state": "idle", "stage": "", "video": None, "part": None, "pct": 0.0, "eta_s": None,
                            "started": self.t0, "message": "", "pid": os.getpid(), "command": command}
        rev_dir.mkdir(parents=True, exist_ok=True)
        self.log_path.write_text("", encoding="utf-8")

    def _write(self) -> None:
        tmp = self.state_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.state, ensure_ascii=False), encoding="utf-8")
        tmp.replace(self.state_path)

    def begin(self, stage: str, video: str | None, part: str | None, message: str = "") -> None:
        self.phase, self.phase_t0 = stage, time.time()
        self.state.update(state="running", stage=stage, video=video, part=part, message=message)
        self.progress(0.0, message)

    def progress(self, frac: float, message: str | None = None, weight: float = 0.0) -> None:
        """`frac`: avance (0-1) de la etapa en curso, que pesa `weight` segundos estimados."""
        frac = min(1.0, max(0.0, frac))
        cur = self.done + frac * weight
        pct = 100 * min(1.0, cur / self.total)
        elapsed = time.time() - self.t0
        eta = elapsed / cur * (self.total - cur) if cur > 0 and elapsed > 0 else None
        self.state.update(pct=round(pct, 1), eta_s=None if eta is None else round(eta))
        if message is not None:
            self.state["message"] = message
        line = progress_line(self.phase, int(cur), int(self.total), elapsed, elapsed, time.strftime("%H:%M:%S"))
        with self.log_path.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
        self._write()

    def end_stage(self, weight: float) -> None:
        self.done += weight
        self.progress(0.0, None, 0.0)

    def finish(self, state: str, message: str) -> None:
        if state == "done":
            self.state["pct"], self.state["eta_s"] = 100.0, 0
        self.state.update(state=state, message=message, ended=time.time())
        self._write()


# ------------------------------------------------------------------------------------------------ etapas

@dataclass
class Stage:
    name: str
    video: str
    part: str | None
    est_s: float
    run: Callable[["Stage", Reporter], bool] | None = None
    done: Callable[[], bool] = lambda: False        # ya está hecho y al día (solo cuenta con --resume o si no hay nada que hacer)
    always_skip_if_done: bool = False               # process: nunca rehace lo que existe
    skip: str | None = None                         # no se puede o no corresponde (motivo)
    note: str = ""

    def label(self) -> str:
        return self.name + (f" {self.part}" if self.part else "")


def mtime(p: Path) -> float:
    return p.stat().st_mtime if p.exists() else 0.0


def newer(out: Path, *ins: Path) -> bool:
    """`out` existe y es más nuevo que todas las entradas que existen."""
    return out.exists() and all(mtime(out) >= mtime(i) for i in ins if i.exists())


def fmt(seconds: float) -> str:
    m = int(round(seconds / 60))
    return f"{m // 60} h {m % 60:02d} min" if m >= 60 else (f"{m} min" if m else f"{int(round(seconds))} s")


@dataclass
class VideoCtx:
    root: Path
    match: str
    video: str
    cfg: dict
    tdir: Path
    fps: float
    stride: int
    chunks: list[Chunk]

    def part(self, c: Chunk) -> str:
        return f"{self.video}_{c.name}"

    def rate(self) -> float:
        return COST_PER_PLAY_S * (self.fps / self.stride) / 10.0

    def length_s(self, c: Chunk) -> float:
        return (c.end - c.start) / self.fps


def video_ids(root: Path, match: str, only: str | None) -> list[str]:
    import yaml

    f = root / "matches" / match / "match.yaml"
    if not f.exists():
        raise SystemExit(f"No existe {f}")
    ids = [v["video_id"] for v in (yaml.safe_load(f.read_text(encoding="utf-8")) or {}).get("videos") or []]
    if only:
        if only not in ids:
            raise SystemExit(f"El partido {match} no tiene el video {only} (tiene: {', '.join(ids) or 'ninguno'})")
        return [only]
    return ids


def load_ctx(root: Path, match: str, video: str) -> tuple[VideoCtx | None, str | None]:
    """Contexto de un video o el motivo por el que no se puede."""
    try:
        cfg = config.load_config(match=match, video=video)
    except (FileNotFoundError, ValueError) as e:
        return None, "video sin descargar" if "no hay video" in str(e) else f"configuración: {e}"
    if not (root / cfg["paths"]["raw_video"]).exists():
        return None, "video sin descargar (python -m sportsan.ingest.download_videos)"
    seg_file = root / cfg["paths"]["segments_csv"]
    segs = load_segments(seg_file, video) if seg_file.exists() else None
    play = [] if segs is None else [(float(r.start_s), float(r.end_s)) for r in segs[segs["tipo"] == "juego"].itertuples()]
    if not play:
        return None, "faltan los tramos de juego de este video en segments.csv (pestaña Tramos)"
    fps = float(cfg.get("video_fps") or 30.0)
    chunks = plan_chunks(play, fps, 0)
    return VideoCtx(root, match, video, cfg, root / cfg["paths"]["tracking_dir"], fps, int(cfg.get("analysis_stride") or 3), chunks), None


def chunk_done(v: VideoCtx, c: Chunk, tdir: Path | None = None) -> bool:
    """Misma regla que process: la parte cuenta si existe y su índice trae posiciones (calibrated_share)."""
    d = tdir or v.tdir
    name = f"tracks_{v.video}_{c.name}.json"
    idx = d / f"tracks_{v.video}_index.json"
    if not (d / name).exists() or not idx.exists():
        return False
    try:
        chunks = json.loads(idx.read_text(encoding="utf-8")).get("chunks", [])
    except (OSError, ValueError):
        return False
    return any(x.get("file") == name and "calibrated_share" in x for x in chunks)


def protected(v: VideoCtx, part: str) -> bool:
    """La analista ya trabajó esta parte (anclas o tracks_fixed): no se toca sin --force."""
    return (v.tdir / "auto" / f"anchors_{part}.json").exists() or (v.tdir / f"tracks_fixed_{part}.json").exists()


def has_anchors(tdir: Path, part: str) -> bool:
    f = tdir / "auto" / f"anchors_{part}.json"
    try:
        return bool(json.loads(f.read_text(encoding="utf-8")).get("anchors"))
    except (OSError, ValueError, AttributeError):
        return False


# ------------------------------------------------------------------------------------------------ quick

def run_library_check(match: str, video: str, out_dir: Path, samples: int) -> list[dict]:
    """`library check` con su salida en out_dir; devuelve las filas y guarda la tabla en out_dir/check.txt."""
    from . import library

    ns = argparse.Namespace(match=match, video=video, library=None, samples=samples, seconds=10.0, every=1.0,
                            max_error=library.MAX_CONSISTENCY_M, out_dir=str(out_dir))
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rows = library._cmd_check(ns)
    (out_dir / "check.txt").write_text(buf.getvalue(), encoding="utf-8")
    return rows or []


def run_quick_suggest(tdir: Path, qdir: Path, part: str, per_min: str) -> dict | None:
    """Tracklets y sugerencias de la parte de prueba (en qdir). None si falta link_model.json."""
    from . import anchors_cli as ac

    if not (tdir / "link_model.json").exists():
        return None
    models = ac.Models.load(tdir)
    prep = ac.prepare(qdir, part, models, ac.Progress(None))
    res = ac.suggest(prep, per_min if per_min == "hybrid" else float(per_min))
    (qdir / f"suggest_{part}.json").write_text(json.dumps(res, ensure_ascii=False), encoding="utf-8")
    return {"chains": len(res["chains"]), "suggestions": len(res["suggestions"])}


def quick_range(v: VideoCtx, quick_s: float) -> Chunk:
    first = v.chunks[0]
    return Chunk(first.start, min(first.end, first.start + round(quick_s * v.fps)))


def quick_stages(v: VideoCtx, a: argparse.Namespace) -> list[Stage]:
    qdir = v.tdir / "revision" / "quick"
    qc = quick_range(v, a.quick_s)
    qpart = v.part(qc)
    summary = qdir / "summary.json"
    lib = v.tdir / f"library_{v.video}.npz"
    state: dict = {}

    def process(st: Stage, rep: Reporter) -> bool:
        qdir.mkdir(parents=True, exist_ok=True)
        cmd = py("process", "--match", v.match, "--video", v.video, "--start", f"{qc.start / v.fps:.6f}", "--end", f"{qc.end / v.fps:.6f}",
                 "--out-dir", str(qdir), "--force")
        if a.band_margin is not None:
            cmd += ["--band-margin", str(a.band_margin)]
        return RUNNER(cmd, lambda: rep.progress(0.5, None, st.est_s)) == 0

    def check(st: Stage, rep: Reporter) -> bool:
        state["check"] = run_library_check(v.match, v.video, qdir, a.quick_samples)
        return True

    def suggest(st: Stage, rep: Reporter) -> bool:
        state["suggest"] = run_quick_suggest(v.tdir, qdir, qpart, a.per_min)
        return True

    def report(st: Stage, rep: Reporter) -> bool:
        q = {}
        idx = qdir / f"tracks_{v.video}_index.json"
        if idx.exists():
            q = next(iter(json.loads(idx.read_text(encoding="utf-8")).get("chunks", [])), {})
        rows = state.get("check") or []
        bad = [r for r in rows if not (r.get("found") and r.get("neighbours_m") is not None and r["neighbours_m"] < 1.0
                                       and (r.get("refs_m") or 0) < 1.5 and not r.get("missing"))]
        doc = {"created": time.strftime("%Y-%m-%dT%H:%M:%S"), "match_id": v.match, "video_id": v.video, "part": qpart,
               "start_s": qc.start / v.fps, "end_s": qc.end / v.fps, "process": q,
               "calibration_check": {"samples": len(rows), "to_review": len(bad), "rows": rows, "table": "check.txt"},
               "suggest": state.get("suggest"), "link_model": (v.tdir / "link_model.json").exists(),
               "files": sorted(p.name for p in qdir.iterdir() if p.name != "summary.json")}
        qdir.mkdir(parents=True, exist_ok=True)
        summary.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
        return True

    out = [
        Stage("quick_process", v.video, qpart, (qc.end - qc.start) / v.fps * v.rate(), process,
              lambda: a.resume and newer(summary, lib), note=f"{(qc.end - qc.start) / v.fps:.0f} s desde {qc.start / v.fps:.0f} s"),
        Stage("quick_check", v.video, None, CHECK_S, check, lambda: a.resume and newer(summary, lib), note=f"{a.quick_samples} muestras de calibración"),
        Stage("quick_suggest", v.video, qpart, MIN_STAGE_S, suggest, lambda: a.resume and newer(summary, lib)),
        Stage("quick_report", v.video, None, 1.0, report, lambda: a.resume and newer(summary, lib), note="revision/quick/summary.json"),
    ]
    return out


# ------------------------------------------------------------------------------------------------ tracking

def tracking_stages(v: VideoCtx, a: argparse.Namespace) -> tuple[list[Stage], str | None]:
    """Etapas de un video. Segundo valor: motivo si todo el video se salta."""
    lib = v.tdir / f"library_{v.video}.npz"
    anchors = v.tdir / f"anchors_{v.match}_{v.video}.json"
    stages: list[Stage] = []

    if not lib.exists() and not anchors.exists():
        return [], f"faltan las anclas del barrido ({anchors.name}; pestaña Calibración -> Exportar anclas)"

    def calibs() -> list[Path]:
        return sorted(v.tdir.glob(f"calib_{v.video}_*.json"), key=mtime)

    def propagate(st: Stage, rep: Reporter) -> bool:
        return RUNNER(py("propagate", "--anchors", str(anchors)), lambda: rep.progress(0.5, None, st.est_s)) == 0

    def library(st: Stage, rep: Reporter) -> bool:
        c = calibs()
        if not c:
            print("    no hay calib_ después de la propagación", flush=True)
            return False
        return RUNNER(py("library", "build", "--track", str(c[-1])), lambda: rep.progress(0.5, None, st.est_s)) == 0

    pending = [c for c in v.chunks if not chunk_done(v, c)]
    if anchors.exists() and (a.quick or pending):     # sin partes por procesar, reconstruir la biblioteca no aporta nada
        # Con biblioteca más nueva que las anclas no hay nada que rehacer (ni con --resume ni sin él: reconstruirla
        # cambiaría la calibración de las partes que se procesen después de las ya hechas).
        stale = not newer(lib, anchors)
        def propagated() -> bool:
            c = calibs()
            return (not stale) or (a.resume and bool(c) and newer(c[-1], anchors))

        stages.append(Stage("propagate", v.video, None, PROPAGATE_S, propagate, propagated))
        stages.append(Stage("library", v.video, None, LIBRARY_S, library, lambda: not stale))

    if a.quick:
        return stages + quick_stages(v, a), None

    pend_s = sum(v.length_s(c) for c in pending)

    def process(st: Stage, rep: Reporter) -> bool:
        cmd = py("process", "--match", v.match, "--video", v.video)
        if a.band_margin is not None:
            cmd += ["--band-margin", str(a.band_margin)]
        if a.force:
            cmd.append("--force")

        def tick() -> None:
            left = sum(v.length_s(c) for c in v.chunks if not chunk_done(v, c)) if not a.force else pend_s
            rep.progress(1 - left / pend_s if pend_s else 1.0, None, st.est_s)
        return RUNNER(cmd, tick) == 0

    prot = [v.part(c) for c in v.chunks if protected(v, v.part(c))]
    note = f"{len(pending)} de {len(v.chunks)} partes por procesar"
    if prot and a.force:
        note += f"; --force reprocesa también {len(prot)} protegida(s)"
    stages.append(Stage("process", v.video, None, (pend_s if not a.force else sum(v.length_s(c) for c in v.chunks)) * v.rate(), process,
                        lambda: not pending and not a.force, True, note=note))

    link_ok = (v.tdir / "link_model.json").exists()
    for c in v.chunks:
        part = v.part(c)
        tr = v.tdir / f"tracks_{part}.json"
        sg = v.tdir / "auto" / f"suggest_{part}.json"

        def suggest(st: Stage, rep: Reporter, part=part, tr=tr) -> bool:
            if not tr.exists():
                print(f"    falta {tr.name} (¿falló process?)", flush=True)
                return False
            return RUNNER(py("anchors_cli", "suggest", "--match", v.match, "--part", part, "--per-min", a.per_min)) == 0

        skip = None
        if not link_ok:
            skip = "falta link_model.json en tracking/ (modelo de uniones: tracking.links_eval)"
        elif protected(v, part) and not a.force:
            skip = "parte con anclas/revisión de la analista (usa --force)"
        stages.append(Stage("suggest", v.video, part, max(MIN_STAGE_S, v.length_s(c) * SUGGEST_PER_PLAY_S), suggest,
                            lambda sg=sg, tr=tr: a.resume and newer(sg, tr), skip=skip))
    return stages, None


# ------------------------------------------------------------------------------------------------ fill-ball

def default_ball_model(root: Path) -> Path:
    w = root / "weights"
    p = w / MODEL_NAME
    if p.exists():
        return p
    c = sorted(w.glob("ball_model*.pt"), key=mtime) if w.exists() else []
    return c[-1] if c else p


def fill_ball_stages(v: VideoCtx, parts: list[Path], model: Path, a: argparse.Namespace) -> list[Stage]:
    stages: list[Stage] = []
    for tp in parts:
        part = tp.stem.removeprefix("tracks_")
        af = v.tdir / "auto" / f"anchors_{part}.json"
        links = v.tdir / "auto" / f"links_{part}_exp_tramos.json"
        ball = tp.with_name(tp.name.replace("tracks_", "ball_auto_", 1))
        try:
            a_, b_ = part.split("_")[-2:]
            length = (int(b_) - int(a_)) / v.fps
        except ValueError:
            length = 600.0

        def fill(st: Stage, rep: Reporter, part=part) -> bool:
            cmd = py("anchors_cli", "fill", "--match", v.match, "--part", part, "--variant", "exp")
            for flag, val in (("--unnamed-cost", a.unnamed_cost), ("--seg-max-cost", a.seg_max_cost), ("--seg-min-entry-p", a.seg_min_entry_p),
                              ("--seg-internal-p", a.seg_internal_p), ("--seg-reject-close", a.seg_reject_close)):
                if val is not None:
                    cmd += [flag, str(val)]
            return RUNNER(cmd) == 0

        def run_ball(st: Stage, rep: Reporter, tp=tp) -> bool:
            cmd = py("ball", "run", "--match", v.match, "--video", v.video, "--part", tp.name, "--accept", str(a.accept), "--model", str(model))
            if a.force:
                cmd.append("--force")
            return RUNNER(cmd, lambda: rep.progress(0.5, None, st.est_s)) == 0

        stages.append(Stage("fill", v.video, part, max(30.0, length * FILL_PER_PLAY_S), fill, lambda links=links, tp=tp, af=af: a.resume and newer(links, tp, af)))
        stages.append(Stage("ball", v.video, part, max(30.0, length * BALL_PER_PLAY_S), run_ball, lambda ball=ball: ball.exists() and not a.force,
                            True, note="ya existe ball_auto_ (se salta; --force lo rehace)" if ball.exists() and not a.force else ""))
    return stages


def fill_ball_preconditions(root: Path, v: VideoCtx) -> tuple[list[Path], str | None, list[str]]:
    """Partes con anclas del video, motivo por el que el video se salta y errores que impiden correr todo."""
    from .ball import parts_of

    errors: list[str] = []
    all_parts = parts_of(root / "matches" / v.match, v.video)
    parts = [p for p in all_parts if has_anchors(v.tdir, p.stem.removeprefix("tracks_"))]
    why = None
    if not all_parts:
        why = f"no hay partes procesadas (tracks_{v.video}_*.json); corre primero: pipeline tracking --match {v.match}"
    elif not parts:
        why = "ninguna parte tiene anclas de la analista (tracking/auto/anchors_<parte>.json, las escribe la mesa de Anclas)"
    if parts and not (v.tdir / "link_model.json").exists():
        errors.append("falta tracking/link_model.json (el relleno lo necesita; se entrena con tracking.links_eval)")
    return parts, why, errors


def model_errors(root: Path, match: str, video_ids_: list[str], model: Path) -> list[str]:
    if model.exists():
        return []
    samples = [root / "matches" / match / "tracking" / f"ball_samples_{vid}.json" for vid in video_ids_]
    have = [s.name for s in samples if s.exists()]
    if have:
        return [f"no existe el modelo de balón {model}. Hay muestras ({', '.join(have)}): entrena con "
                f"`python -m sportsan.tracking.ball train --match {match} --samples matches/{match}/tracking/{have[0]}`"]
    return [f"no existe el modelo de balón {model} y tampoco hay muestras (ball_samples_<video>.json): marca balones en Playground > Balón y entrena"]


# ------------------------------------------------------------------------------------------------ ejecución común

def print_plan(command: str, plan: list[tuple[str, list[Stage], str | None]]) -> float:
    print(f"Plan ({command}):")
    total = 0.0
    for vid, stages, why in plan:
        if why:
            print(f"  {vid}: se salta: {why}")
            continue
        print(f"  {vid}:")
        for s in stages:
            if s.skip:
                what = f"omitida: {s.skip}"
            elif s.done():
                what = "hecha (se salta)"
            else:
                what = f"~{fmt(s.est_s)}"
                total += s.est_s
            print(f"    {s.label():<42} {what}{' · ' + s.note if s.note and not s.skip else ''}")
    print(f"Estimado: ~{fmt(total)} (aproximado; process es lo medido, el resto son costos supuestos).")
    return total


def execute(command: str, rev_dir: Path, plan: list[tuple[str, list[Stage], str | None]]) -> int:
    todo = [(vid, s) for vid, stages, why in plan if not why for s in stages if not s.skip and not s.done()]
    omitted = [s for _, stages, why in plan if not why for s in stages if s.skip] + [None for _, _, why in plan if why]
    rep = Reporter(rev_dir, command, sum(s.est_s for _, s in todo))
    failed: list[str] = []
    dead_videos: set[str] = set()
    try:
        for vid, s in todo:
            if vid in dead_videos:
                continue
            print(f"\n== {s.label()} ({vid}) {time.strftime('%H:%M')} ==", flush=True)
            rep.begin(s.name, vid, s.part, s.note or s.label())
            try:
                ok = bool(s.run(s, rep)) if s.run else True
            except SystemExit as e:
                print(f"    {e}", flush=True)
                ok = False
            except Exception as e:             # una etapa rota no tumba a las demás
                print(f"    error: {type(e).__name__}: {e}", flush=True)
                ok = False
            if ok:
                rep.end_stage(s.est_s)
            else:
                failed.append(s.label())
                rep.end_stage(s.est_s)
                if s.name in ("propagate", "library", "process", "quick_process"):
                    dead_videos.add(vid)             # lo que sigue depende de esto
    except KeyboardInterrupt:
        rep.finish("error", "Interrumpido (Ctrl+C). Lo ya escrito se conserva; vuelve a lanzar con --resume.")
        print("\nInterrumpido. Vuelve a lanzar con --resume para continuar.", flush=True)
        return EXIT_INTERRUPTED
    if failed:
        rep.finish("error", f"Fallaron {len(failed)} etapa(s): {', '.join(failed[:5])}{'…' if len(failed) > 5 else ''}")
        print("\nFallaron: " + ", ".join(failed), flush=True)
        return EXIT_FAILED
    msg = "Listo." if not omitted else f"Listo; {len(omitted)} etapa(s)/video(s) omitidos (ver el log)."
    rep.finish("done", msg)
    print("\n" + msg, flush=True)
    return EXIT_PARTIAL if omitted else EXIT_OK


def guard_running(rev_dir: Path, command: str) -> None:
    f = rev_dir / f"pipeline_{command}.json"
    if not f.exists():
        return
    try:
        d = json.loads(f.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return
    if d.get("state") == "running" and d.get("pid") != os.getpid() and pid_alive(int(d.get("pid") or 0)):
        raise SystemExit(f"Ya hay un {command} corriendo (pid {d['pid']}). Espera a que termine o ciérralo.")


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="python -m sportsan.tracking.pipeline", description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="command", required=True)
    for name in ("tracking", "fill-ball"):
        p = sub.add_parser(name)
        p.add_argument("--match", required=True)
        p.add_argument("--video", help="solo este video (por defecto, todos los del partido)")
        p.add_argument("--plan", action="store_true", help="dice qué haría y cuánto estima, sin ejecutar")
        p.add_argument("--resume", action="store_true", help="salta lo ya hecho y al día")
        p.add_argument("--force", action="store_true", help="rehace también lo existente / partes de la analista")
    t = sub.choices["tracking"]
    t.add_argument("--quick", action="store_true", help="solo un tramo corto representativo + informe en revision/quick/")
    t.add_argument("--quick-s", type=float, default=60.0, help="segundos del tramo de --quick (por defecto %(default)s)")
    t.add_argument("--quick-samples", type=int, default=8, help="muestras de calibración del informe de --quick")
    t.add_argument("--band-margin", type=float, default=None, help="se reenvía a process (metros alrededor de la cancha)")
    t.add_argument("--per-min", default="2", help="sugerencias por minuto (1-5) o hybrid")
    f = sub.choices["fill-ball"]
    f.add_argument("--model", help="modelo de balón (por defecto weights/ball_model.pt o el ball_model*.pt más nuevo)")
    f.add_argument("--accept", type=float, default=0.95)
    f.add_argument("--unnamed-cost", type=float)
    f.add_argument("--seg-max-cost", type=float)
    f.add_argument("--seg-min-entry-p", type=float)
    f.add_argument("--seg-internal-p", type=float)
    f.add_argument("--seg-reject-close", choices=["yes", "no"])
    return ap


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    a = build_parser().parse_args(argv)
    if getattr(a, "quick", False) and a.force:
        raise SystemExit("--quick no se combina con --force")
    root = config.project_root()
    rev = root / "matches" / a.match / "tracking" / "revision"
    ids = video_ids(root, a.match, a.video)
    plan: list[tuple[str, list[Stage], str | None]] = []
    errors: list[str] = []
    if a.command == "tracking":
        for vid in ids:
            v, why = load_ctx(root, a.match, vid)
            if v is None:
                plan.append((vid, [], why))
                continue
            stages, why = tracking_stages(v, a)
            plan.append((vid, stages, why))
    else:
        model = Path(a.model) if a.model else default_ball_model(root)
        if not model.is_absolute():
            model = root / model
        errors += model_errors(root, a.match, ids, model)
        for vid in ids:
            v, why = load_ctx(root, a.match, vid)
            if v is None:
                plan.append((vid, [], why))
                continue
            parts, why, errs = fill_ball_preconditions(root, v)
            errors += errs
            plan.append((vid, [] if why else fill_ball_stages(v, parts, model, a), why))
    runnable = [p for p in plan if not p[2] and p[1]]
    if errors or not runnable:
        for e in errors:
            print(f"Precondición: {e}", file=sys.stderr)
        for vid, _, why in plan:
            if why:
                print(f"{vid}: {why}", file=sys.stderr)
        if not runnable and not errors:
            print("No hay nada que correr.", file=sys.stderr)
        if a.plan:
            print_plan(a.command, plan)
        return EXIT_PRECONDITION
    print_plan(a.command, plan)
    if a.plan:
        return EXIT_OK
    guard_running(rev, a.command)
    return execute(a.command, rev, plan)


if __name__ == "__main__":
    raise SystemExit(main())

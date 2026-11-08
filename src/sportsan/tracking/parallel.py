"""L6: procesos en paralelo para `process` (partes) y `overnight` (videos). Opcional: sin pedirlo, todo corre como siempre.

La laptop (8 núcleos / 16 hilos lógicos, 16 GB, sin GPU) la usa la analista a la vez, así que el número de procesos que
se pide se recorta a un tope seguro (`safe_workers`) por tres cosas:
  - hilos: todos los procesos juntos usan como máximo la mitad de los hilos lógicos (`CPU_SHARE`); cada proceso se
    fija a su propia franja de hilos (afinidad) para que OpenVINO no cree 16 hilos por proceso y se estorben;
  - memoria: cada proceso necesita ~`RAM_PER_WORKER_GB` (modelo + biblioteca + video + una parte en memoria) y siempre
    se deja `RAM_RESERVE_GB` libres para la analista;
  - un tope duro (`HARD_CAP`), por si la máquina es grande.
Fuera de eso el resultado es el mismo: cada parte se calcula igual (mismo código), solo cambia quién la calcula.
"""
from __future__ import annotations

import os
import time
from pathlib import Path

CPU_SHARE = 0.5          # fracción de los hilos lógicos que pueden usar todos los procesos juntos
RAM_PER_WORKER_GB = 1.2  # por proceso: medido ~0.7 GB (2 procesos + el principal sumaron 2.1 GB); ver docs/informes_agentes/L6_paralelo.md
RAM_RESERVE_GB = 2.5     # lo que se deja libre para el resto de la laptop
HARD_CAP = 4


def available_ram_gb() -> float | None:
    """RAM libre en GB (psutil si está; si no, la llamada de Windows). None si no se puede saber."""
    try:
        import psutil

        return psutil.virtual_memory().available / 1024 ** 3
    except Exception:
        pass
    try:
        import ctypes

        class MEM(ctypes.Structure):
            _fields_ = [("l", ctypes.c_ulong), ("load", ctypes.c_ulong), ("tot", ctypes.c_ulonglong), ("avail", ctypes.c_ulonglong),
                        ("tp", ctypes.c_ulonglong), ("ap", ctypes.c_ulonglong), ("tv", ctypes.c_ulonglong), ("av", ctypes.c_ulonglong),
                        ("ext", ctypes.c_ulonglong)]

        m = MEM()
        m.l = ctypes.sizeof(MEM)
        ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
        return m.avail / 1024 ** 3
    except Exception:
        return None


def safe_workers(requested: int, cpus: int | None = None, free_ram_gb: float | None = None, *, quiet: bool = False) -> int:
    """Procesos que de verdad se lanzan: lo pedido, recortado por hilos, memoria y el tope duro. Mínimo 1."""
    requested = max(1, int(requested or 1))
    if requested == 1:
        return 1
    cpus = cpus or os.cpu_count() or 4
    free = available_ram_gb() if free_ram_gb is None else free_ram_gb
    limits = {"hilos": max(1, int(cpus * CPU_SHARE) // 4), "tope": HARD_CAP}   # >= 4 hilos por proceso
    if free is not None:
        limits["memoria"] = max(1, int((free - RAM_RESERVE_GB) // RAM_PER_WORKER_GB))
    n = min(requested, *limits.values())
    if n < requested and not quiet:
        why = ", ".join(f"{k} permiten {v}" for k, v in limits.items() if v < requested)
        print(f"  Se pidieron {requested} procesos; se usan {n} para no saturar la laptop ({why}).", flush=True)
    return n


def cpu_slices(workers: int, cpus: int | None = None) -> list[list[int]]:
    """Franjas disjuntas de hilos lógicos, una por proceso, dentro de la mitad (CPU_SHARE) de la máquina.
    Los hilos hermanos (0,1 son un mismo núcleo) quedan en la misma franja. Se empieza por el final: el 0 suele usarlo el sistema."""
    cpus = cpus or os.cpu_count() or 4
    budget = max(workers, int(cpus * CPU_SHARE))
    per = max(1, budget // workers)
    top = cpus
    out = []
    for _ in range(workers):
        out.append(list(range(max(0, top - per), top)))
        top -= per
    return out


def pin_to(cpus: list[int]) -> bool:
    """Fija este proceso a esos hilos. Si no se puede (sin psutil, permisos), sigue sin fijar: solo es menos fino."""
    try:
        import psutil

        psutil.Process().cpu_affinity(cpus)
        return True
    except Exception:
        return False


def fmt_eta(seconds: float) -> str:
    seconds = max(0, int(round(seconds)))
    return f"{seconds // 3600} h {seconds % 3600 // 60:02d} min" if seconds >= 3600 else f"{seconds // 60} min {seconds % 60:02d} s"


class ProgressLog:
    """Línea con % y ETA a la pantalla y, si se da `path`, al archivo (se agrega; legible mientras corre)."""

    def __init__(self, label: str, total: float, path: Path | None = None):
        self.label, self.total, self.path = label, float(total), path
        self.done = 0.0
        self.t0 = time.time()

    def step(self, amount: float, note: str = "") -> str:
        self.done = min(self.total, self.done + amount)
        pct = 100.0 * self.done / self.total if self.total else 100.0
        el = time.time() - self.t0
        eta = el * (self.total - self.done) / self.done if self.done else 0.0
        line = f"[{time.strftime('%H:%M:%S')}] {self.label} {pct:5.1f} % · transcurrido {fmt_eta(el)} · faltan ~{fmt_eta(eta)}" + (f" · {note}" if note else "")
        print(line, flush=True)
        if self.path:
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                with open(self.path, "a", encoding="utf-8") as f:
                    f.write(line + "\n")
            except OSError:
                pass
        return line


# ---------------------------------------------------------------- partes de un video en paralelo (process --workers)

_W: dict = {}   # estado de cada proceso trabajador


def _init_worker(slots, spec: dict) -> None:
    """Cada trabajador carga una vez el modelo, la biblioteca y el video, y se fija a su franja de hilos."""
    import cv2

    from .library import Library
    from .process import load_model

    cpus = slots.get()
    pin_to(cpus)
    cv2.setNumThreads(max(1, len(cpus) // 2))
    _W.update(spec=spec, cpus=cpus, model=load_model(spec["model_path"]), lib=Library.load(spec["lib_path"]), cap=cv2.VideoCapture(spec["video_path"]))


def _run_one(task: tuple[int, int]) -> dict:
    from .detect import Chunk
    from .process import finish_chunk, run_chunk, write_outputs

    s = _W["spec"]
    chunk = Chunk(*task)
    t0 = time.time()
    frames, rows, motions, anchors = run_chunk(_W["cap"], _W["model"], _W["lib"], chunk, s["stride"], s["every"], s["conf"], s["tracker"],
                                               tiles=s["tiles"], band=s["band"], mask_rects=s["mask"], band_margin_m=s["band_margin"])
    if not frames:
        return {"chunk": task, "frames": 0, "seconds": time.time() - t0}
    result = finish_chunk(frames, rows, motions, anchors, _W["lib"], s["refs"], s["fps"], s["max_error"], s["post"])
    path = write_outputs(Path(s["out_dir"]), s["meta"], chunk, s["stride"], frames, result)
    return {"chunk": task, "frames": len(frames), "seconds": time.time() - t0, "path": path.name, "quality": result["quality"], "colors": result["colors"]}


def map_chunks(chunks, spec: dict, workers: int):
    """Procesa las partes en `workers` procesos (spawn: cada uno con su modelo y su video). Devuelve resultados al terminar
    cada parte (en el orden en que acaban). Las partes más largas salen primero para que no sobre un proceso al final."""
    import multiprocessing as mp
    from concurrent.futures import ProcessPoolExecutor, as_completed

    ctx = mp.get_context("spawn")
    slots = ctx.Queue()
    for c in cpu_slices(workers):
        slots.put(c)
    order = sorted(chunks, key=lambda c: c.start - c.end)
    with ProcessPoolExecutor(max_workers=workers, mp_context=ctx, initializer=_init_worker, initargs=(slots, spec)) as pool:
        futures = [pool.submit(_run_one, (c.start, c.end)) for c in order]
        try:
            for fut in as_completed(futures):
                yield fut.result()
        except BaseException:
            for f in futures:
                f.cancel()
            raise

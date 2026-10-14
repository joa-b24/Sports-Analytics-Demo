"""Detección y seguimiento de jugadoras en píxeles, por partes (paso A4 de la hoja de ruta).

Pensado para correr en la laptop (CPU) mientras se trabaja en otra cosa:

- El video se procesa por **partes** (60 s por defecto). Cada parte se escribe en cuanto termina, así que se
  puede ir revisando y corrigiendo mientras siguen las demás.
- Es **reanudable**: una parte ya escrita se salta. Se puede cortar con Ctrl+C y volver a lanzar.
- Por defecto recorre los tramos `juego` del video según `segments.csv`; con `--start/--end` se limita a un trozo.
- Cada parte lleva sus **indicadores de calidad** y los subtramos donde casi no se ve a nadie (la cámara no está
  sobre el juego), para decidir qué revisar primero y qué descartar.

Uso:
    python -m sportsan.tracking.detect --benchmark            # mide la velocidad y estima cuánto tarda todo
    python -m sportsan.tracking.detect                        # procesa los tramos de juego del primer video
    python -m sportsan.tracking.detect --start 0:33:20 --end 0:34:20
    python -m sportsan.tracking.detect --video v2 --stride 6  # segundo tiempo, a 5 cuadros por segundo

Salida, en `matches/<match_id>/tracking/`:
    tracks_<video>_<inicio>_<fin>.json   una por parte: cajas en píxeles con su track y el color de la camiseta
    tracks_<video>_index.json            lista de partes hechas con sus indicadores (para ver el avance)

Todo va en píxeles del video original: la conversión a metros se hace después con la calibración (A6).
El balón no se detecta: con un detector genérico, a este tamaño, lo confunde con las marcas del campo.
"""
from __future__ import annotations

import argparse
import json
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np

TRACKS_SCHEMA_VERSION = 1
# BoT-SORT con compensación del movimiento de cámara, ajustado sobre v1.mp4 (ver docs/roadmap.md).
DEFAULT_TRACKER = Path(__file__).with_name("botsort_pitch.yaml")
# Menos personas que esto en un cuadro: la cámara probablemente no está sobre el juego.
FEW_PEOPLE = 6
# Un subtramo "sin juego a la vista" tiene que durar al menos esto (segundos) para anotarse.
MIN_GAP_S = 2.0


# ---------------------------------------------------------------- planificación y calidad (numpy puro)

@dataclass(frozen=True)
class Chunk:
    start: int      # cuadro inicial, inclusive
    end: int        # cuadro final, exclusive

    @property
    def name(self) -> str:
        return f"{self.start}_{self.end}"


def plan_chunks(ranges_s: list[tuple[float, float]], fps: float, chunk_s: float) -> list[Chunk]:
    """Parte cada rango de tiempo (segundos) en trozos de `chunk_s`. El último de cada rango puede ser más corto;
    si quedaría de menos de 5 s se une al anterior. Con `chunk_s` <= 0 cada rango es una sola parte."""
    if chunk_s <= 0:
        return [Chunk(round(a * fps), round(b * fps)) for a, b in ranges_s if round(b * fps) > round(a * fps)]
    size = max(1, round(chunk_s * fps))
    out: list[Chunk] = []
    for a, b in ranges_s:
        f0, f1 = round(a * fps), round(b * fps)
        if f1 <= f0:
            continue
        starts = list(range(f0, f1, size))
        if len(starts) > 1 and f1 - starts[-1] < 5 * fps:
            starts.pop()
        for i, s in enumerate(starts):
            out.append(Chunk(s, starts[i + 1] if i + 1 < len(starts) else f1))
    return out


def low_visibility(frames: list[int], counts: list[int], fps: float, few: int = FEW_PEOPLE, min_s: float = MIN_GAP_S) -> list[tuple[int, int]]:
    """Subtramos seguidos con muy pocas personas a la vista. Devuelve pares (cuadro inicial, cuadro final)."""
    out: list[tuple[int, int]] = []
    run: list[int] = []
    for f, c in zip(frames, counts):
        if c < few:
            run.append(f)
            continue
        if run and (run[-1] - run[0]) / fps >= min_s:
            out.append((run[0], run[-1]))
        run = []
    if run and (run[-1] - run[0]) / fps >= min_s:
        out.append((run[0], run[-1]))
    return out


def chunk_quality(frames: list[int], boxes: list[list[list[float]]], fps: float) -> dict:
    """Indicadores de una parte, para decidir qué revisar primero.

    boxes[i] = cajas del cuadro i como [track_id, x1, y1, x2, y2, conf, ...].
    """
    counts = [len(b) for b in boxes]
    lengths: dict[int, int] = {}
    for bs in boxes:
        for b in bs:
            lengths[int(b[0])] = lengths.get(int(b[0]), 0) + 1
    n = max(1, len(frames))
    gaps = low_visibility(frames, counts, fps)
    hidden = sum(b - a for a, b in gaps)
    span = max(1, frames[-1] - frames[0]) if frames else 1
    return {
        "frames": len(frames),
        "people_median": float(np.median(counts)) if counts else 0.0,
        "people_min": int(min(counts)) if counts else 0,
        "tracks": len(lengths),
        # Un track que dura casi toda la parte es una jugadora seguida de principio a fin. Muchos tracks cortos
        # para pocas personas quiere decir identidades partidas: más trabajo en la mesa de corrección.
        "tracks_long": sum(1 for v in lengths.values() if v >= 0.8 * n),
        "tracks_per_person": round(len(lengths) / max(1.0, float(np.median(counts))), 2) if counts else 0.0,
        "low_visibility": [[int(a), int(b)] for a, b in gaps],
        "low_visibility_share": round(hidden / span, 3),
    }


def estimate_seconds(n_frames: int, stride: int, s_per_frame: float) -> float:
    return (n_frames / max(1, stride)) * s_per_frame


def fmt_duration(seconds: float) -> str:
    m = int(round(seconds / 60))
    return f"{m // 60} h {m % 60:02d} min" if m >= 60 else f"{m} min"


# ---------------------------------------------------------------- detector (ultralytics)

def load_model(path: str | Path):
    from ultralytics import YOLO

    return YOLO(str(path), task="detect")


def default_model(root: Path) -> Path:
    """El modelo OpenVINO si ya está exportado (más rápido en CPU); si no, los pesos de PyTorch."""
    ov = root / "weights" / "yolo11n_1280_openvino_model"
    return ov if ov.exists() else root / "weights" / "yolo11n.pt"


# Las detecciones que el seguidor no deja pasar se conservan con un identificador propio a partir de este número:
# son "sueltas" (un solo cuadro) y la unión de fragmentos las asigna después por posición.
LOOSE_ID = 1_000_000


def jersey_color(img, x1: float, y1: float, x2: float, y2: float) -> list[int]:
    """Color de la camiseta en Lab (escala de OpenCV): mediana del torso, sin contar el césped.

    Se toma el centro de la caja (del 30 al 70 % del ancho y del 18 al 48 % del alto). La mediana aguanta mejor que
    la media los brazos y el fondo; quitar los píxeles verdes evita que el césped apague un azul hasta parecer negro.
    """
    import cv2

    w, h = x2 - x1, y2 - y1
    xa, xb = int(x1 + 0.3 * w), int(x1 + 0.7 * w) + 1
    ya, yb = int(y1 + 0.18 * h), int(y1 + 0.48 * h) + 1
    crop = img[max(0, ya):yb, max(0, xa):xb]
    if crop.size == 0:
        return [0, 128, 128]
    lab = cv2.cvtColor(crop, cv2.COLOR_BGR2LAB).reshape(-1, 3).astype(float)
    return [int(round(v)) for v in shirt_median(lab)]


def shirt_median(lab: np.ndarray) -> np.ndarray:
    """Mediana de los píxeles que no son césped (verde: a bajo y b alto). Si casi todo es césped, la de todos."""
    lab = np.asarray(lab, dtype=float).reshape(-1, 3)
    grass = (lab[:, 1] < 120) & (lab[:, 2] > 132)
    keep = lab[~grass]
    return np.median(keep if len(keep) >= 0.2 * len(lab) else lab, axis=0)


def unmatched(det_xyxy: np.ndarray, tracked_xyxy: np.ndarray, min_iou: float = 0.5) -> np.ndarray:
    """Índices de las detecciones que no coinciden con ninguna caja que haya devuelto el seguidor."""
    det = np.asarray(det_xyxy, dtype=float).reshape(-1, 4)
    trk = np.asarray(tracked_xyxy, dtype=float).reshape(-1, 4)
    if len(det) == 0:
        return np.empty(0, dtype=int)
    if len(trk) == 0:
        return np.arange(len(det))
    x1 = np.maximum(det[:, None, 0], trk[None, :, 0])
    y1 = np.maximum(det[:, None, 1], trk[None, :, 1])
    x2 = np.minimum(det[:, None, 2], trk[None, :, 2])
    y2 = np.minimum(det[:, None, 3], trk[None, :, 3])
    inter = np.clip(x2 - x1, 0, None) * np.clip(y2 - y1, 0, None)
    area = lambda b: (b[:, 2] - b[:, 0]) * (b[:, 3] - b[:, 1])
    iou = inter / (area(det)[:, None] + area(trk)[None, :] - inter + 1e-9)
    return np.where(iou.max(axis=1) < min_iou)[0]


def make_tracker(path: str | Path):
    """Seguidor nuevo (los identificadores empiezan de cero) con la configuración dada."""
    from ultralytics.trackers import BOTSORT, BYTETracker
    from ultralytics.utils import YAML, IterableSimpleNamespace

    cfg = IterableSimpleNamespace(**YAML.load(str(path)))
    cfg.device = "cpu"
    return (BOTSORT if cfg.tracker_type == "botsort" else BYTETracker)(args=cfg)


class FrameTracker:
    """Detecta y sigue cuadro a cuadro sin perder nada de lo que el detector ve.

    El seguidor solo devuelve los tracks que da por confirmados: una jugadora bien visible puede quedarse sin caja
    varios cuadros hasta que la confirma. Aquí se guarda todo: los tracks del seguidor con su identificador y, con
    un identificador suelto, cada detección que el seguidor no dejó pasar.
    """

    def __init__(self, model, tracker_path: str | Path, conf: float, loose_conf: float = 0.3):
        self.model, self.conf, self.loose_conf = model, conf, loose_conf
        self.tracker = make_tracker(tracker_path)
        self.loose = 0

    def step(self, img) -> list[list[float]]:
        """Cajas del cuadro como [track_id, x1, y1, x2, y2, conf]."""
        r = self.model.predict(img, imgsz=[736, 1280], classes=[0], conf=self.conf, verbose=False)[0]
        det = r.boxes.cpu().numpy()
        out = self.tracker.update(det, img)
        rows = [[int(t[4]), float(t[0]), float(t[1]), float(t[2]), float(t[3]), float(t[5])] for t in out]
        # La última columna de cada track es el índice de la detección que lo alimentó en este cuadro: esas ya
        # están. De las demás se descartan las que caen encima de un track (el seguidor suaviza la caja y la
        # detección cruda de la misma persona puede no coincidir del todo).
        used = {int(t[-1]) for t in out}
        apart = set(unmatched(det.xyxy, np.array([t[:4] for t in out]).reshape(-1, 4), min_iou=0.2).tolist())
        for i in sorted(apart - used):
            if det.conf[i] < self.loose_conf:
                continue
            self.loose += 1
            rows.append([LOOSE_ID + self.loose, *[float(v) for v in det.xyxy[i]], float(det.conf[i])])
        return rows


def run_chunk(cap, model, chunk: Chunk, stride: int, imgsz, conf: float, tracker: str, on_frame=None) -> tuple[list[int], list[list[list[float]]]]:
    """Detecta y sigue a las personas de una parte. Los track_id son locales a la parte."""
    import cv2

    ft = FrameTracker(model, tracker, conf)
    cap.set(cv2.CAP_PROP_POS_FRAMES, chunk.start)
    frames: list[int] = []
    boxes: list[list[list[float]]] = []
    for f in range(chunk.start, chunk.end):
        ok = cap.grab()
        if not ok:
            break
        if (f - chunk.start) % stride:
            continue
        ok, img = cap.retrieve()
        if not ok:
            break
        row = [[tid, round(x1, 1), round(y1, 1), round(x2, 1), round(y2, 1), round(c, 2), *jersey_color(img, x1, y1, x2, y2)] for tid, x1, y1, x2, y2, c in ft.step(img)]
        frames.append(f)
        boxes.append(row)
        if on_frame:
            on_frame(len(frames))
    return frames, boxes


def write_chunk(path: Path, meta: dict, chunk: Chunk, stride: int, frames: list[int], boxes, quality: dict) -> None:
    data = {
        "schema_version": TRACKS_SCHEMA_VERSION,
        "kind": "tracks_px",
        **meta,
        "start_frame": chunk.start,
        "end_frame": chunk.end,
        "stride": stride,
        "box_columns": ["track_id", "x1", "y1", "x2", "y2", "conf", "lab_l", "lab_a", "lab_b"],
        "frames": [{"frame": f, "boxes": b} for f, b in zip(frames, boxes)],
        "quality": quality,
    }
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    tmp.replace(path)  # nunca queda una parte a medio escribir


# ---------------------------------------------------------------- CLI

def main(argv: list[str] | None = None) -> None:
    import cv2

    from ..config import load_config, project_root
    from ..timebase import load_segments, parse_hms

    ap = argparse.ArgumentParser(description="Detecta y sigue a las jugadoras en píxeles, por partes y de forma reanudable.")
    ap.add_argument("--match")
    ap.add_argument("--video")
    ap.add_argument("--start", help="inicio (HH:MM:SS); sin él se usan los tramos de juego de segments.csv")
    ap.add_argument("--end", help="fin (HH:MM:SS)")
    ap.add_argument("--chunk", type=float, default=60.0, help="segundos por parte")
    ap.add_argument("--stride", type=int, help="procesa 1 de cada N cuadros (por defecto, analysis_stride de match.yaml)")
    ap.add_argument("--model", help="pesos .pt o carpeta *_openvino_model")
    ap.add_argument("--conf", type=float, default=0.2)
    ap.add_argument("--tracker", default=str(DEFAULT_TRACKER), help="configuración del seguidor; por defecto, BoT-SORT ajustado a este video")
    ap.add_argument("--benchmark", action="store_true", help="solo mide la velocidad y estima el tiempo total")
    ap.add_argument("--force", action="store_true", help="vuelve a procesar las partes ya hechas")
    args = ap.parse_args(argv)

    cfg = load_config(match=args.match, video=args.video)
    root = project_root()
    fps = float(cfg["video_fps"])
    stride = args.stride or int(cfg.get("analysis_stride") or 3)
    video = root / cfg["paths"]["raw_video"]
    out_dir = root / cfg["paths"]["tracking_dir"]
    out_dir.mkdir(parents=True, exist_ok=True)

    if args.start and args.end:
        ranges = [(parse_hms(args.start), parse_hms(args.end))]
        origin = "el tramo pedido"
    else:
        seg_file = root / cfg["paths"]["segments_csv"]
        if not seg_file.exists():
            raise SystemExit(f"No existe {seg_file}. Marca los tramos en la app y exporta segments.csv, o usa --start y --end.")
        segs = load_segments(seg_file, cfg["video_id"])
        ranges = [(r.start_s, r.end_s) for r in segs[segs["tipo"] == "juego"].itertuples()]
        origin = f"{len(ranges)} tramo(s) de juego de segments.csv"
        if not ranges:
            raise SystemExit(f"segments.csv no tiene tramos de juego para {cfg['video_id']}.")
    chunks = plan_chunks(ranges, fps, args.chunk)
    total_frames = sum(c.end - c.start for c in chunks)

    model_path = Path(args.model) if args.model else default_model(root)
    if not model_path.exists():
        raise SystemExit(f"No encuentro el modelo en {model_path}. Descarga yolo11n.pt a la carpeta weights/ (ver docs/roadmap.md).")
    model = load_model(model_path)
    cap = cv2.VideoCapture(str(video))
    if not cap.isOpened():
        raise SystemExit(f"No se pudo abrir el video: {video}")
    w, h = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    imgsz = [736, 1280]
    meta = {"match_id": cfg["match_id"], "video_id": cfg["video_id"], "fps": fps, "image_w": w, "image_h": h, "model": model_path.name, "tracker": Path(args.tracker).name}
    print(f"{cfg['match_id']} {cfg['video_id']}: {origin}, {total_frames / fps / 60:.1f} min de video en {len(chunks)} parte(s); 1 de cada {stride} cuadros; modelo {model_path.name}")

    if args.benchmark:
        probe = Chunk(chunks[0].start, min(chunks[0].end, chunks[0].start + round(20 * fps)))
        t0 = time.time()
        frames, boxes = run_chunk(cap, model, probe, stride, imgsz, args.conf, args.tracker)
        per = (time.time() - t0) / max(1, len(frames))
        q = chunk_quality(frames, boxes, fps)
        print(f"  prueba de {len(frames)} cuadros: {per * 1000:.0f} ms por cuadro procesado; {q['people_median']:.0f} personas por cuadro (mediana)")
        print(f"  estimado para todo lo planificado: {fmt_duration(estimate_seconds(total_frames, stride, per))}")
        for s in (stride * 2, stride * 3):
            print(f"    con --stride {s} ({fps / s:.1f} cuadros por segundo): {fmt_duration(estimate_seconds(total_frames, s, per))}")
        print("  La laptop se puede seguir usando; si se calienta o va con batería, tardará más.")
        return

    index_path = out_dir / f"tracks_{cfg['video_id']}_index.json"
    index = {"schema_version": TRACKS_SCHEMA_VERSION, **meta, "stride": stride, "chunks": []}
    if index_path.exists() and not args.force:
        index["chunks"] = json.loads(index_path.read_text(encoding="utf-8")).get("chunks", [])
    done = {c["name"] for c in index["chunks"]}

    pending = [c for c in chunks if args.force or c.name not in done or not (out_dir / f"tracks_{cfg['video_id']}_{c.name}.json").exists()]
    print(f"  hechas: {len(chunks) - len(pending)} de {len(chunks)}; faltan {len(pending)}. Se puede cortar con Ctrl+C y volver a lanzar.")
    spent, processed = 0.0, 0
    try:
        for n, chunk in enumerate(pending, 1):
            t0 = time.time()
            frames, boxes = run_chunk(cap, model, chunk, stride, imgsz, args.conf, args.tracker)
            if not frames:
                print(f"  parte {chunk.name}: sin cuadros (¿fin del video?)")
                continue
            q = chunk_quality(frames, boxes, fps)
            path = out_dir / f"tracks_{cfg['video_id']}_{chunk.name}.json"
            write_chunk(path, meta, chunk, stride, frames, boxes, q)
            index["chunks"] = [c for c in index["chunks"] if c["name"] != chunk.name] + [
                {"name": chunk.name, "file": path.name, "start_frame": chunk.start, "end_frame": chunk.end, "start_s": round(chunk.start / fps, 1), "end_s": round(chunk.end / fps, 1), **q}
            ]
            index["chunks"].sort(key=lambda c: c["start_frame"])
            index_path.write_text(json.dumps(index, indent=1), encoding="utf-8")
            spent += time.time() - t0
            processed += len(frames)
            left = sum(c.end - c.start for c in pending[n:])
            eta = estimate_seconds(left, stride, spent / processed)
            t = chunk.start / fps
            print(
                f"  [{n}/{len(pending)}] {int(t // 60)}:{int(t % 60):02d} · {q['people_median']:.0f} personas, {q['tracks']} tracks "
                f"({q['tracks_per_person']} por persona){' · poco a la vista ' + str(round(q['low_visibility_share'] * 100)) + ' %' if q['low_visibility'] else ''}"
                f" · {time.time() - t0:.0f} s · faltan ~{fmt_duration(eta)}"
            )
    except KeyboardInterrupt:
        print("\n  Cortado. Lo ya escrito se conserva; vuelve a lanzar el mismo comando para continuar.")
    finally:
        cap.release()
    print(f"Partes en {out_dir} · índice: {index_path.name}")


if __name__ == "__main__":
    main()

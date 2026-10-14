"""Detección + calibración en una sola pasada, por partes: de video a posiciones en metros.

Une `detect` (personas y tracks en píxeles) con `library` (dónde está la cancha en cada cuadro). Por cada parte
lee el video una sola vez y, en cada cuadro procesado, mide el movimiento de cámara, detecta y sigue a las
personas y, una vez por segundo, ubica el cuadro con la biblioteca. Al cerrar la parte propaga la calibración
entre esas ubicaciones y pasa el pie de cada caja a metros.

Requiere la biblioteca del video (`python -m sportsan.tracking.library build ...`).

Uso:
    python -m sportsan.tracking.process --benchmark
    python -m sportsan.tracking.process                         # tramos de juego de segments.csv
    python -m sportsan.tracking.process --start 0:33:20 --end 0:34:20

Salida por parte, en `matches/<match_id>/tracking/`:
    tracks_<video>_<inicio>_<fin>.json       cajas en píxeles + posición en la cancha + equipo (lo que carga la app)
    tracking_<video>_<inicio>_<fin>.parquet  tabla del contrato: solo quien está dentro de la cancha
    tracks_<video>_index.json                avance e indicadores de cada parte

Es reanudable: una parte ya escrita se salta. Los equipos se asignan por el color de la camiseta si `match.yaml`
trae `jersey_colors`; si no, quedan en `unk` y se imprimen los colores encontrados para elegirlos.
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np

from ..schema import MARGIN_M, PITCH_LENGTH_M, PITCH_WIDTH_M
from .detect import DEFAULT_TRACKER, LOOSE_ID, Chunk, FrameTracker, chunk_quality, default_model, estimate_seconds, fmt_duration, jersey_color, load_model, plan_chunks
from .propagate import apply_h, estimate_motion, propagate, venue_grid
from .stitch import absorb_loose, color_distance, duplicate_loose, fragments_from_boxes, stitch

TRACKS_SCHEMA_VERSION = 3
TEAM_CODES = ("unk", "own", "opp", "ref")
# Claves de `jersey_colors` en match.yaml y el equipo al que pertenece cada una (las porteras visten distinto).
JERSEY_KEYS = {"own": "own", "opp": "opp", "ref": "ref", "own_gk": "own", "opp_gk": "opp"}
# Distancia de color (Lab con la luminosidad a la mitad) a partir de la cual una camiseta no se asigna a ningún equipo.
MAX_COLOR_DISTANCE = 40.0
# Una caja a menos de estos píxeles del borde de la imagen está saliendo o entrando del encuadre.
EDGE_PX = 10


# ---------------------------------------------------------------- geometría y color (numpy puro)

def to_normalized(H: np.ndarray | None, feet_px: np.ndarray, length_m: float, width_m: float) -> np.ndarray:
    """Pie de cada caja (px) -> cancha normalizada 105 x 68. NaN si el cuadro no tiene calibración."""
    feet_px = np.asarray(feet_px, dtype=float).reshape(-1, 2)
    if H is None:
        return np.full((len(feet_px), 2), np.nan)
    meters = apply_h(H, feet_px)
    return meters * np.array([PITCH_LENGTH_M / length_m, PITCH_WIDTH_M / width_m])


def on_pitch(xy: np.ndarray, margin: float = MARGIN_M) -> np.ndarray:
    """Dentro de la cancha, con el margen del contrato. Sin posición (NaN) no se puede saber: False."""
    xy = np.asarray(xy, dtype=float).reshape(-1, 2)
    with np.errstate(invalid="ignore"):
        return (xy[:, 0] >= -margin) & (xy[:, 0] <= PITCH_LENGTH_M + margin) & (xy[:, 1] >= -margin) & (xy[:, 1] <= PITCH_WIDTH_M + margin)


def hex_to_lab(color: str) -> np.ndarray:
    """'#rrggbb' -> Lab en la escala de 8 bits de OpenCV (L 0-255, a y b centrados en 128)."""
    c = color.strip().lstrip("#")
    if len(c) != 6:
        raise ValueError(f"Color inválido: {color!r} (se espera #rrggbb)")
    rgb = np.array([int(c[i:i + 2], 16) for i in (0, 2, 4)], dtype=float) / 255
    lin = np.where(rgb > 0.04045, ((rgb + 0.055) / 1.055) ** 2.4, rgb / 12.92)
    xyz = np.array([[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.0721750], [0.0193339, 0.1191920, 0.9503041]]) @ lin
    f = xyz / np.array([0.95047, 1.0, 1.08883])
    f = np.where(f > 0.008856, np.cbrt(f), 7.787 * f + 16 / 116)
    return np.array([(116 * f[1] - 16) * 255 / 100, 500 * (f[0] - f[1]) + 128, 200 * (f[1] - f[2]) + 128])


def lab_to_hex(lab: np.ndarray) -> str:
    L, a, b = lab[0] * 100 / 255, lab[1] - 128, lab[2] - 128
    fy = (L + 16) / 116
    f = np.array([fy + a / 500, fy, fy - b / 200])
    xyz = np.where(f ** 3 > 0.008856, f ** 3, (f - 16 / 116) / 7.787) * np.array([0.95047, 1.0, 1.08883])
    lin = np.array([[3.2404542, -1.5371385, -0.4985314], [-0.9692660, 1.8760108, 0.0415560], [0.0556434, -0.2040259, 1.0572252]]) @ xyz
    lin = np.clip(lin, 0, 1)
    rgb = np.where(lin > 0.0031308, 1.055 * lin ** (1 / 2.4) - 0.055, 12.92 * lin)
    return "#" + "".join(f"{int(round(v * 255)):02x}" for v in np.clip(rgb, 0, 1))


def classify_team(lab: np.ndarray, refs: dict[str, np.ndarray], max_distance: float = MAX_COLOR_DISTANCE) -> str:
    """Equipo cuya camiseta de referencia está más cerca en color; 'unk' si ninguna está cerca o no hay referencias.

    `refs` usa las claves de `jersey_colors` (own, opp, ref, own_gk, opp_gk): la portera cuenta para su equipo.
    """
    if not refs:
        return "unk"
    name, d = min(((k, color_distance(lab, v)) for k, v in refs.items()), key=lambda kv: kv[1])
    return JERSEY_KEYS.get(name, "unk") if d <= max_distance else "unk"


def track_teams(rows: list[dict], refs: dict[str, np.ndarray]) -> dict[int, str]:
    """Un equipo por track: el del color mediano de sus cajas (más estable que decidir caja a caja)."""
    by_track: dict[int, list[list[float]]] = {}
    for r in rows:
        by_track.setdefault(r["track_id"], []).append(r["lab"])
    return {t: classify_team(np.median(np.array(v), axis=0), refs) for t, v in by_track.items()}


def dominant_colors(labs: np.ndarray, k: int = 3, rounds: int = 12) -> list[tuple[str, int]]:
    """Colores de camiseta más frecuentes (k-medias sencillo). Devuelve [(hex, cuántos tracks)], de más a menos."""
    labs = np.asarray(labs, dtype=float).reshape(-1, 3)
    if len(labs) == 0:
        return []
    k = min(k, len(labs))
    # Inicio determinista: repartidos a lo largo de la luminosidad.
    order = np.argsort(labs[:, 0])
    centers = labs[order[np.linspace(0, len(labs) - 1, k).astype(int)]]
    for _ in range(rounds):
        label = np.argmin(np.linalg.norm(labs[:, None] - centers[None], axis=2), axis=1)
        centers = np.array([labs[label == i].mean(axis=0) if (label == i).any() else centers[i] for i in range(k)])
    label = np.argmin(np.linalg.norm(labs[:, None] - centers[None], axis=2), axis=1)
    out = [(lab_to_hex(centers[i]), int((label == i).sum())) for i in range(k)]
    return sorted([o for o in out if o[1] > 0], key=lambda o: -o[1])


def calibrate_processed(anchors: dict[int, np.ndarray], motions: dict[int, np.ndarray | None], n: int, grid_m: np.ndarray, w: int, h: int, max_error_m: float):
    """Calibración de cada cuadro procesado (índices 0..n-1) a partir de las ubicaciones de la biblioteca.

    Devuelve (lista de H o None, índices de anclas descartadas, discrepancia media por cuadro).
    """
    from .library import reject_inconsistent

    if not anchors:
        return [None] * n, [], [None] * n
    kept, dropped = reject_inconsistent(anchors, motions, grid_m, w, h, max_error_m)
    calib = propagate(kept, motions, 0, n - 1, grid_m, w, h)
    return [c.H for c in calib], dropped, [c.disagreement_m for c in calib]


# ---------------------------------------------------------------- una parte

def _mmss(seconds: float) -> str:
    """1 h 05 min, 12:30 o 0:45."""
    s = int(round(seconds))
    return f"{s // 3600} h {s % 3600 // 60:02d} min" if s >= 3600 else f"{s // 60}:{s % 60:02d}"


class Progress:
    """Línea de progreso en la terminal, reescrita en su sitio: parte, barra, minuto del video, velocidad y lo que falta.
    Solo caracteres ASCII: la consola de Windows no siempre muestra otros."""

    SPIN = "|/-\\"

    def __init__(self, label: str, n_frames: int, fps: float, stride: int, after_s: float = 0.0, out=None):
        import sys

        self.label, self.n, self.fps, self.stride, self.after_s = label, max(1, n_frames), fps, stride, after_s
        self.out = out or sys.stdout
        self.t0 = time.time()
        self.k = 0

    def line(self, done: int, now_s: float) -> str:
        """Texto de la línea con `done` cuadros procesados de `n`, en el segundo `now_s` del video."""
        frac = min(1.0, done / self.n)
        width = 24
        bar = "#" * round(frac * width) + "-" * (width - round(frac * width))
        spent = time.time() - self.t0
        rate = done / spent if spent > 0 else 0.0
        left = (self.n - done) / rate if rate > 0 else float("nan")
        total = left + self.after_s * (spent / max(1, done)) if rate > 0 else float("nan")
        spin = self.SPIN[self.k % len(self.SPIN)]
        when = f"{int(now_s // 60)}:{int(now_s % 60):02d}"
        tail = f"parte ~{_mmss(left)} | todo ~{_mmss(total)}" if rate > 0 else "midiendo..."
        return f"  {spin} {self.label} [{bar}] {frac * 100:3.0f} % | video {when} | {rate:.1f} c/s | {tail}"

    def width(self) -> int:
        """Ancho de la terminal menos uno: una línea más larga se parte en dos y ya no se puede reescribir en su sitio."""
        import shutil

        return max(40, shutil.get_terminal_size((100, 20)).columns - 1)

    def __call__(self, done: int, frame: int) -> None:
        self.k += 1
        if self.k % 5 and done < self.n:
            return
        w = self.width()
        self.out.write("\r" + self.line(done, frame / self.fps)[:w].ljust(w))
        self.out.flush()

    def end(self) -> None:
        self.out.write("\r" + " " * self.width() + "\r")
        self.out.flush()


def run_chunk(cap, model, lib, chunk: Chunk, stride: int, every: int, conf: float, tracker: str, progress=None):
    """Una pasada por la parte: movimiento de cámara, detección y seguimiento, y ubicación con la biblioteca cada `every` cuadros procesados."""
    import cv2

    from .library import features, localize

    ft = FrameTracker(model, tracker, conf)  # seguidor nuevo: los identificadores son locales a la parte
    w, h = lib.meta["image_w"], lib.meta["image_h"]
    scale = min(1.0, lib.meta["work_width"] / w)
    cap.set(cv2.CAP_PROP_POS_FRAMES, chunk.start)
    frames: list[int] = []
    rows: list[list[dict]] = []
    motions: dict[int, np.ndarray | None] = {}
    anchors: dict[int, np.ndarray] = {}
    prev_gray, hint = None, None
    for f in range(chunk.start, chunk.end):
        if not cap.grab():
            break
        if (f - chunk.start) % stride:
            continue
        ok, img = cap.retrieve()
        if not ok:
            break
        i = len(frames)
        small = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA) if scale < 1.0 else img
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        if prev_gray is not None:
            motions[i - 1], _ = estimate_motion(prev_gray, gray, scale)
        prev_gray = gray
        if i % every == 0:
            loc = localize(*features(gray, scale), lib, hint)
            if loc.H is not None:
                anchors[i] = loc.H
                hint = loc.ref
        row: list[dict] = []
        for tid, x1, y1, x2, y2, c in ft.step(img):
            row.append({
                "track_id": tid, "box": [round(x1, 1), round(y1, 1), round(x2, 1), round(y2, 1)], "conf": round(c, 2),
                "lab": jersey_color(img, x1, y1, x2, y2),
                # Pegada al borde lateral o inferior: está entrando o saliendo del encuadre.
                "edge": bool(x1 <= EDGE_PX or x2 >= w - EDGE_PX or y2 >= h - EDGE_PX),
            })
        frames.append(f)
        rows.append(row)
        if progress:
            progress(len(frames), f)
    return frames, rows, motions, anchors


def finish_chunk(frames, rows, motions, anchors, lib, refs: dict[str, np.ndarray], fps: float, max_error_m: float) -> dict:
    """Calibra la parte, pasa las cajas a la cancha, une fragmentos, asigna equipos y resume la calidad."""
    stride_s = (frames[1] - frames[0]) / fps if len(frames) > 1 else 1 / fps
    w, h = lib.meta["image_w"], lib.meta["image_h"]
    venue = lib.meta.get("venue") or {}
    length, width = float(venue.get("length_m", PITCH_LENGTH_M)), float(venue.get("width_m", PITCH_WIDTH_M))
    Hs, dropped, _ = calibrate_processed(anchors, motions, len(frames), venue_grid(length, width), w, h, max_error_m)

    # Posición de cada caja en la cancha.
    positions: list[np.ndarray] = []
    insides: list[np.ndarray] = []
    for H, row in zip(Hs, rows):
        feet = np.array([[(r["box"][0] + r["box"][2]) / 2, r["box"][3]] for r in row], dtype=float).reshape(-1, 2)
        xy = to_normalized(H, feet, length, width)
        positions.append(xy)
        insides.append(on_pitch(xy))

    # Una detección suelta encima de alguien que el seguidor ya lleva es la misma persona vista dos veces: fuera.
    duplicates = 0
    for i, (row, xy, inside) in enumerate(zip(rows, positions, insides)):
        dup = duplicate_loose([{"track_id": r["track_id"], "xy": (p.tolist() if ins else None)} for r, p, ins in zip(row, xy, inside)], lambda t: t >= LOOSE_ID)
        if dup:
            keep = [k for k, r in enumerate(row) if r["track_id"] not in dup]
            rows[i], positions[i], insides[i] = [row[k] for k in keep], xy[keep], inside[keep]
            duplicates += len(dup)

    # Equipo de cada track por su color, antes de unir: dos equipos distintos nunca son la misma persona.
    raw_teams = track_teams([r for row in rows for r in row], refs)
    # Fragmentos del mismo color y equipo que se continúan en la cancha: una identidad propuesta por persona.
    for_stitch = [
        [
            {"track_id": r["track_id"], "xy": (p.tolist() if ins else None), "lab": r["lab"], "team": raw_teams[r["track_id"]], "edge": r.get("edge", False)}
            for r, p, ins in zip(row, xy, inside)
        ]
        for row, xy, inside in zip(rows, positions, insides)
    ]
    # Primero, las detecciones sueltas que caen en el hueco de un track pasan a ser de ese track.
    absorbed = absorb_loose(frames, for_stitch, lambda t: t >= LOOSE_ID, fps)
    for row in for_stitch:
        for b in row:
            b["track_id"] = absorbed.get(b["track_id"], b["track_id"])
    identity = stitch(fragments_from_boxes(frames, for_stitch, fps), fps)
    ident = lambda tid: identity.get(absorbed.get(tid, tid), absorbed.get(tid, tid))
    # El equipo se decide por identidad: más cajas, color más estable.
    teams = track_teams([{"track_id": ident(r["track_id"]), "lab": r["lab"]} for row in rows for r in row], refs)

    out_rows: list[list[list]] = []
    inside_counts: list[int] = []
    inside_tracks: dict[int, int] = {}
    seen: dict[int, int] = {}
    for row, xy, inside in zip(rows, positions, insides):
        line = []
        for r, p, ins in zip(row, xy, inside):
            known = bool(np.isfinite(p).all())
            line.append([
                r["track_id"], *r["box"], r["conf"], *r["lab"],
                round(float(p[0]), 2) if known else None, round(float(p[1]), 2) if known else None,
                bool(ins), teams[ident(r["track_id"])], ident(r["track_id"]),
            ])
            seen[r["track_id"]] = seen.get(r["track_id"], 0) + 1
            if ins:
                inside_tracks[r["track_id"]] = inside_tracks.get(r["track_id"], 0) + 1
        inside_counts.append(int(inside.sum()))
        out_rows.append(line)
    # Un track es "de la cancha" si la mayoría de sus cajas lo son; uno que la roza un instante no cuenta.
    inside_tracks = {t: v for t, v in inside_tracks.items() if v > 0.5 * seen[t]}
    n = max(1, len(frames))
    quality = chunk_quality(frames, [[[b[0]] for b in line] for line in out_rows], fps)
    calibrated = sum(1 for H in Hs if H is not None)
    people = max(1.0, float(np.median(inside_counts)) if inside_counts else 1.0)
    identities = {ident(t) for t in inside_tracks}
    quality.update({
        "calibrated_share": round(calibrated / n, 3),
        "library_anchors": len(anchors) - len(dropped),
        "library_dropped": len(dropped),
        "on_pitch_median": float(np.median(inside_counts)) if inside_counts else 0.0,
        "on_pitch_tracks": len(inside_tracks),
        "on_pitch_tracks_long": sum(1 for v in inside_tracks.values() if v >= 0.8 * n),
        # Fragmentos de menos de 1.5 s: casi siempre un cambio de identidad, no una persona nueva.
        "on_pitch_tracks_short": sum(1 for v in inside_tracks.values() if v * stride_s < 1.5),
        "on_pitch_tracks_per_person": round(len(inside_tracks) / people, 2),
        # Después de unir fragmentos: cuántas identidades propuestas quedan para revisar.
        # Detecciones que el seguidor no confirmó y se guardaron sueltas (se asignan al unir fragmentos).
        "loose_boxes": sum(1 for line in out_rows for b in line if b[0] >= LOOSE_ID),
        "loose_absorbed": len(absorbed),
        "loose_duplicates_dropped": duplicates,
        "identities": len(identities),
        "identities_per_person": round(len(identities) / people, 2),
        "teams": {t: sum(1 for i in identities if teams.get(i) == t) for t in TEAM_CODES},
    })
    track_labs = [np.median(np.array([b[6:9] for line in out_rows for b in line if b[0] == t]), axis=0) for t in inside_tracks]
    return {"boxes": out_rows, "quality": quality, "colors": dominant_colors(np.array(track_labs)) if track_labs else [], "H": Hs}


def tracking_table(meta: dict, chunk: Chunk, frames: list[int], boxes: list[list[list]]):
    """Tabla `tracking` del contrato para la parte: solo las personas dentro de la cancha."""
    import pandas as pd

    from ..schema import TRACKING_COLUMNS, validate_tracking

    fps = meta["fps"]
    segment_id = f"{meta['video_id']}_{chunk.name}"
    data = []
    for f, line in zip(frames, boxes):
        for b in line:
            if not b[11]:
                continue
            local = f - chunk.start
            data.append({
                "match_id": meta["match_id"], "segment_id": segment_id, "frame": local, "t_local": local / fps, "t_video": f / fps,
                "track_id": b[0], "team": b[12], "player_id": None,
                # Dentro del margen del contrato; se recorta a él para no fallar por un redondeo en el borde.
                "x": float(np.clip(b[9], -MARGIN_M, PITCH_LENGTH_M + MARGIN_M)), "y": float(np.clip(b[10], -MARGIN_M, PITCH_WIDTH_M + MARGIN_M)),
                "conf": b[5], "px": (b[1] + b[3]) / 2, "py": b[4],
            })
    df = pd.DataFrame(data, columns=[*TRACKING_COLUMNS, "px", "py"])
    df["player_id"] = df["player_id"].astype("string")
    return validate_tracking(df)


def write_outputs(out_dir: Path, meta: dict, chunk: Chunk, stride: int, frames: list[int], result: dict) -> Path:
    path = out_dir / f"tracks_{meta['video_id']}_{chunk.name}.json"
    data = {
        "schema_version": TRACKS_SCHEMA_VERSION,
        "kind": "tracks_px",
        **meta,
        "start_frame": chunk.start,
        "end_frame": chunk.end,
        "stride": stride,
        "box_columns": ["track_id", "x1", "y1", "x2", "y2", "conf", "lab_l", "lab_a", "lab_b", "x", "y", "on_pitch", "team", "identity"],
        # H: imagen (px) -> sede (metros reales), para pasar a la cancha lo que se marque a mano en la mesa de corrección.
        "frames": [
            {"frame": f, "H": None if H is None else [float(v) for v in np.asarray(H).reshape(-1)], "boxes": b}
            for f, H, b in zip(frames, result["H"], result["boxes"])
        ],
        "quality": result["quality"],
    }
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    tmp.replace(path)
    table = tracking_table(meta, chunk, frames, result["boxes"])
    table.to_parquet(out_dir / f"tracking_{meta['video_id']}_{chunk.name}.parquet", index=False)
    return path


# ---------------------------------------------------------------- CLI

def main(argv: list[str] | None = None) -> None:
    import cv2

    from ..config import load_config, project_root
    from ..timebase import load_segments, parse_hms
    from .library import MAX_CONSISTENCY_M, Library

    ap = argparse.ArgumentParser(description="De video a posiciones en metros, por partes: detección + calibración con la biblioteca.")
    ap.add_argument("--match")
    ap.add_argument("--video")
    ap.add_argument("--start", help="inicio (HH:MM:SS); sin él se usan los tramos de juego de segments.csv")
    ap.add_argument("--end", help="fin (HH:MM:SS)")
    ap.add_argument("--chunk", type=float, default=0.0, help="segundos por parte; 0 (por defecto) = una parte por tramo de juego")
    ap.add_argument("--stride", type=int, help="procesa 1 de cada N cuadros (por defecto, analysis_stride de match.yaml)")
    ap.add_argument("--every", type=float, default=1.0, help="segundos entre ubicaciones con la biblioteca")
    ap.add_argument("--model")
    ap.add_argument("--library")
    ap.add_argument("--conf", type=float, default=0.2)
    ap.add_argument("--tracker", default=str(DEFAULT_TRACKER))
    ap.add_argument("--max-error", type=float, default=MAX_CONSISTENCY_M)
    ap.add_argument("--benchmark", action="store_true", help="solo mide la velocidad y estima el tiempo total")
    ap.add_argument("--force", action="store_true", help="vuelve a procesar las partes ya hechas")
    args = ap.parse_args(argv)

    cfg = load_config(match=args.match, video=args.video)
    root = project_root()
    fps = float(cfg["video_fps"])
    stride = args.stride or int(cfg.get("analysis_stride") or 3)
    every = max(1, round(args.every * fps / stride))
    out_dir = root / cfg["paths"]["tracking_dir"]
    out_dir.mkdir(parents=True, exist_ok=True)

    lib_path = Path(args.library) if args.library else out_dir / f"library_{cfg['video_id']}.npz"
    if not lib_path.exists():
        raise SystemExit(f"No existe la biblioteca {lib_path}. Constrúyela primero: python -m sportsan.tracking.library build --track <calib del barrido>.json")
    lib = Library.load(lib_path)

    if args.start and args.end:
        ranges, origin = [(parse_hms(args.start), parse_hms(args.end))], "el tramo pedido"
    else:
        seg_file = root / cfg["paths"]["segments_csv"]
        if not seg_file.exists():
            raise SystemExit(f"No existe {seg_file}. Marca los tramos en la app y exporta segments.csv a la carpeta del partido, o usa --start y --end.")
        segs = load_segments(seg_file, cfg["video_id"])
        ranges = [(r.start_s, r.end_s) for r in segs[segs["tipo"] == "juego"].itertuples()]
        origin = f"{len(ranges)} tramo(s) de juego de segments.csv"
        if not ranges:
            raise SystemExit(f"segments.csv no tiene tramos de juego para {cfg['video_id']}.")
    chunks = plan_chunks(ranges, fps, args.chunk)
    total_frames = sum(c.end - c.start for c in chunks)

    refs = {k: hex_to_lab(v) for k, v in (cfg.get("jersey_colors") or {}).items() if k in JERSEY_KEYS and v}
    model_path = Path(args.model) if args.model else default_model(root)
    if not model_path.exists():
        raise SystemExit(f"No encuentro el modelo en {model_path}.")
    model = load_model(model_path)
    cap = cv2.VideoCapture(str(root / cfg["paths"]["raw_video"]))
    if not cap.isOpened():
        raise SystemExit(f"No se pudo abrir el video: {root / cfg['paths']['raw_video']}")
    meta = {
        "match_id": cfg["match_id"], "video_id": cfg["video_id"], "fps": fps, "image_w": lib.meta["image_w"], "image_h": lib.meta["image_h"],
        "model": model_path.name, "tracker": Path(args.tracker).name, "venue": lib.meta.get("venue") or {},
    }
    print(f"{cfg['match_id']} {cfg['video_id']}: {origin}, {total_frames / fps / 60:.1f} min de video en {len(chunks)} parte(s); 1 de cada {stride} cuadros")
    lengths = [(c.end - c.start) / fps for c in chunks]
    print(f"  duración de las partes: media {fmt_duration(sum(lengths) / len(lengths))}, la más larga {fmt_duration(max(lengths))}")
    print(f"  equipos por color: {', '.join(refs) if refs else 'sin jersey_colors en match.yaml (todo queda en unk)'}")

    if args.benchmark:
        probe = Chunk(chunks[0].start, min(chunks[0].end, chunks[0].start + round(20 * fps)))
        t0 = time.time()
        frames, rows, motions, anchors = run_chunk(cap, model, lib, probe, stride, every, args.conf, args.tracker)
        result = finish_chunk(frames, rows, motions, anchors, lib, refs, fps, args.max_error)
        per = (time.time() - t0) / max(1, len(frames))
        q = result["quality"]
        print(f"  prueba de {len(frames)} cuadros: {per * 1000:.0f} ms por cuadro procesado")
        print(f"  {q['on_pitch_median']:.0f} personas en la cancha (mediana), calibrado el {q['calibrated_share'] * 100:.0f} % de los cuadros")
        print(f"  {q['on_pitch_tracks']} tracks -> {q['identities']} identidades tras unir fragmentos")
        print("  equipos de esas identidades: " + ", ".join(f"{k} {v}" for k, v in (q.get("teams") or {}).items()))
        print(f"  estimado para todo lo planificado: {fmt_duration(estimate_seconds(total_frames, stride, per))}")
        print(f"    con --stride {stride * 2} ({fps / (stride * 2):.1f} cuadros por segundo): {fmt_duration(estimate_seconds(total_frames, stride * 2, per))}")
        if result["colors"]:
            print("  colores de camiseta más frecuentes en la cancha: " + ", ".join(f"{c} ({n} tracks)" for c, n in result["colors"]))
        return

    index_path = out_dir / f"tracks_{cfg['video_id']}_index.json"
    index = {"schema_version": TRACKS_SCHEMA_VERSION, **meta, "stride": stride, "chunks": []}
    if index_path.exists() and not args.force:
        index["chunks"] = json.loads(index_path.read_text(encoding="utf-8")).get("chunks", [])
    # Una parte cuenta como hecha solo si ya tiene posiciones (las de `detect` a secas no las tienen).
    done = {c["name"] for c in index["chunks"] if "calibrated_share" in c}
    pending = [c for c in chunks if args.force or c.name not in done or not (out_dir / f"tracks_{cfg['video_id']}_{c.name}.json").exists()]
    print(f"  hechas: {len(chunks) - len(pending)} de {len(chunks)}; faltan {len(pending)}. Se puede cortar con Ctrl+C y volver a lanzar.")
    spent, processed = 0.0, 0
    colors_shown = bool(refs)
    try:
        for n, chunk in enumerate(pending, 1):
            t0 = time.time()
            after = sum(c.end - c.start for c in pending[n:]) // stride
            bar = Progress(f"[{n}/{len(pending)}]", (chunk.end - chunk.start) // stride + 1, fps, stride, after_s=after)
            frames, rows, motions, anchors = run_chunk(cap, model, lib, chunk, stride, every, args.conf, args.tracker, progress=bar)
            bar.end()
            if not frames:
                print(f"  parte {chunk.name}: sin cuadros (¿fin del video?)")
                continue
            result = finish_chunk(frames, rows, motions, anchors, lib, refs, fps, args.max_error)
            path = write_outputs(out_dir, meta, chunk, stride, frames, result)
            q = result["quality"]
            index["chunks"] = [c for c in index["chunks"] if c["name"] != chunk.name] + [
                {"name": chunk.name, "file": path.name, "start_frame": chunk.start, "end_frame": chunk.end, "start_s": round(chunk.start / fps, 1), "end_s": round(chunk.end / fps, 1), **q}
            ]
            index["chunks"].sort(key=lambda c: c["start_frame"])
            index_path.write_text(json.dumps(index, indent=1), encoding="utf-8")
            spent += time.time() - t0
            processed += len(frames)
            eta = estimate_seconds(sum(c.end - c.start for c in pending[n:]), stride, spent / processed)
            t = chunk.start / fps
            print(
                f"  [{n}/{len(pending)}] {int(t // 60)}:{int(t % 60):02d} · {q['on_pitch_median']:.0f} en la cancha, {q['on_pitch_tracks']} tracks "
                f"-> {q['identities']} identidades tras unir ({q['identities_per_person']} por persona) · calibrado {q['calibrated_share'] * 100:.0f} %"
                f"{' · poco a la vista ' + str(round(q['low_visibility_share'] * 100)) + ' %' if q['low_visibility'] else ''}"
                f" · {time.time() - t0:.0f} s · faltan ~{fmt_duration(eta)}"
            )
            if not colors_shown and result["colors"]:
                colors_shown = True
                print("      colores de camiseta más frecuentes: " + ", ".join(f"{c} ({k} tracks)" for c, k in result["colors"]))
                print("      para asignar equipos, añade a match.yaml:  jersey_colors: {own: \"#......\", opp: \"#......\", ref: \"#......\", own_gk: \"#......\", opp_gk: \"#......\"}")
    except KeyboardInterrupt:
        print("\n  Cortado. Lo ya escrito se conserva; vuelve a lanzar el mismo comando para continuar.")
    finally:
        cap.release()
    print(f"Partes en {out_dir} · índice: {index_path.name}")


if __name__ == "__main__":
    main()

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
from .feet import FEET_CORRECTION, correct_rows
from .propagate import apply_h, estimate_motion, propagate, venue_grid
from .stitch import absorb_loose, duplicate_loose, fragments_from_boxes, stitch
from .team import JERSEY_KEYS, MAX_COLOR_DISTANCE, classify_team, hex_to_lab, lab_to_hex, team_changes, track_teams, track_teams_legacy, vote_teams  # noqa: F401  (se usan desde aquí)

TRACKS_SCHEMA_VERSION = 3
TEAM_CODES = ("unk", "own", "opp", "ref")
# Una caja a menos de estos píxeles del borde de la imagen está saliendo o entrando del encuadre.
EDGE_PX = 10


# ---------------------------------------------------------------- geometría y color (numpy puro)

def to_meters(H: np.ndarray | None, feet_px: np.ndarray) -> np.ndarray:
    """Pie de cada caja (px) -> metros reales de la sede. NaN si el cuadro no tiene calibración."""
    feet_px = np.asarray(feet_px, dtype=float).reshape(-1, 2)
    if H is None:
        return np.full((len(feet_px), 2), np.nan)
    return apply_h(H, feet_px)


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


# Franja de la cancha en la imagen, desde la calibración: lo que cae fuera (cielo, gradas) no se le da al detector.
# Arriba se deja margen para la cabeza de quien está en la banda lejana; los lados no se recortan.
BAND_TOP_PX = 120
BAND_BOTTOM_PX = 20
BAND_MARGIN_M = 3.0


def pitch_band(H: np.ndarray | None, length_m: float, width_m: float, w: int, h: int) -> tuple[int, int] | None:
    """(y0, y1) en píxeles donde cae la cancha (con BAND_MARGIN_M alrededor) según la calibración H (píxel -> metros).
    None si no hay calibración o si la cancha no cae en la imagen."""
    if H is None:
        return None
    try:
        inv = np.linalg.inv(np.asarray(H, dtype=float).reshape(3, 3))
    except np.linalg.LinAlgError:
        return None
    m = BAND_MARGIN_M
    # Las cuatro esquinas y puntos de las bandas: una banda curvada por la perspectiva queda bien cubierta.
    pts = [(x, y) for x in np.linspace(-m, length_m + m, 9) for y in (-m, width_m + m)]
    ys = []
    for x, y in pts:
        p = inv @ np.array([x, y, 1.0])
        # A homography is the same times any number, also a negative one: only a zero scale is out.
        if abs(p[2]) > 1e-12:
            ys.append(p[1] / p[2])
    if not ys:
        return None
    y0 = int(max(0, min(ys) - BAND_TOP_PX))
    y1 = int(min(h, max(ys) + BAND_BOTTOM_PX))
    return (y0, y1) if y1 - y0 > 40 else None


def run_chunk(cap, model, lib, chunk: Chunk, stride: int, every: int, conf: float, tracker: str, progress=None, tiles: int = 1, band: tuple[int, int] | str | None = None, mask_rects: list | None = None):
    """Una pasada por la parte: movimiento de cámara, detección y seguimiento, y ubicación con la biblioteca cada `every` cuadros procesados."""
    import cv2

    from .library import features, in_mask, localize, mask_image

    auto_band = band == "auto"
    ft = FrameTracker(model, tracker, conf, tiles=tiles, band=None if auto_band else band)  # seguidor nuevo: identificadores locales a la parte
    w, h = lib.meta["image_w"], lib.meta["image_h"]
    scale = min(1.0, lib.meta["work_width"] / w)
    cap.set(cv2.CAP_PROP_POS_FRAMES, chunk.start)
    frames: list[int] = []
    rows: list[list[dict]] = []
    motions: dict[int, np.ndarray | None] = {}
    anchors: dict[int, np.ndarray] = {}
    prev_gray, hint = None, None
    rects = mask_rects if mask_rects is not None else (lib.meta.get("mask") or [])
    hide = None
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
        if rects and hide is None:
            hide = mask_image(rects, gray.shape, scale)
        if prev_gray is not None:
            motions[i - 1], _ = estimate_motion(prev_gray, gray, scale, hide)
        prev_gray = gray
        if i % every == 0:
            loc = localize(*features(gray, scale, mask=hide), lib, hint)
            if loc.H is not None:
                anchors[i] = loc.H
                hint = loc.ref
                if auto_band:
                    venue = lib.meta.get("venue") or {}
                    ft.band = pitch_band(loc.H, float(venue.get("length_m", PITCH_LENGTH_M)), float(venue.get("width_m", PITCH_WIDTH_M)), w, h)
        row: list[dict] = []
        for tid, x1, y1, x2, y2, c in ft.step(img):
            if in_mask(rects, (x1 + x2) / 2, (y1 + y2) / 2):
                continue  # en el marcador o el logo, no es una persona
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


def propose_identities(frames: list[int], rows: list[list[dict]], meters: list[np.ndarray], insides: list[np.ndarray],
                       refs: dict[str, np.ndarray], fps: float) -> dict:
    """Identidad propuesta para cada track de una parte. Función pura.

    Medido el 2026-10-15 contra dos partes corregidas a mano: otras formas de unir (cambios de la fase 1, partir por
    cambio de camiseta, asociación en la cancha con Mahalanobis, un modelo aprendido, re-identificación) dejaron igual
    o más trabajo que esta (docs/roadmap.md) y se quitaron.

    rows[i]: cajas del cuadro frames[i] ({"track_id", "lab", "edge"?}); meters[i]: su posición en metros reales de la
    sede (NaN sin calibración); insides[i]: si está en la cancha. Pasos:
    1. una detección suelta encima de un track del seguidor es la misma persona vista dos veces: fuera;
    2. equipo de cada track por sus cajas (team.track_teams_legacy);
    3. las sueltas que caen en el hueco de un track pasan a ser de ese track;
    4. se unen los fragmentos (stitch), en metros.

    Devuelve rows y kept (índices conservados por cuadro, tras quitar duplicados), ident(track) -> identidad,
    ident_box(cuadro, track), teams (identidad -> equipo), team_conf (track -> fracción de votos), absorbed y el
    número de duplicados.
    """
    is_loose = lambda t: t >= LOOSE_ID  # noqa: E731
    kept_rows: list[list[dict]] = []
    kept_idx: list[list[int]] = []
    kept_m: list[np.ndarray] = []
    kept_in: list[np.ndarray] = []
    duplicates = 0
    for row, m, inside in zip(rows, meters, insides):
        dup = duplicate_loose([{"track_id": r["track_id"], "xy": (p.tolist() if ins else None)} for r, p, ins in zip(row, m, inside)], is_loose)
        keep = [k for k, r in enumerate(row) if r["track_id"] not in dup]
        duplicates += len(row) - len(keep)
        kept_idx.append(keep)
        kept_rows.append([row[k] for k in keep])
        kept_m.append(m[keep] if len(m) else m)
        kept_in.append(inside[keep] if len(inside) else inside)
    votes = {t: (team, 1.0) for t, team in track_teams_legacy([r for row in kept_rows for r in row], refs).items()}
    for_stitch = [
        [
            {"track_id": r["track_id"], "xy": (p.tolist() if ins and np.isfinite(p).all() else None), "lab": r["lab"],
             "team": votes[r["track_id"]][0], "edge": r.get("edge", False)}
            for r, p, ins in zip(row, m, inside)
        ]
        for row, m, inside in zip(kept_rows, kept_m, kept_in)
    ]
    absorbed = absorb_loose(frames, for_stitch, is_loose, fps)
    linkable = [[{**b, "track_id": absorbed.get(b["track_id"], b["track_id"])} for b in row] for row in for_stitch]
    identity = stitch(fragments_from_boxes(frames, linkable, fps), fps, min_link_s=0.0, immediate_veto=False)

    def ident(tid: int) -> int:
        t = absorbed.get(tid, tid)
        return identity.get(t, t)

    def ident_box(frame: int, tid: int) -> int:
        """Identidad de una caja por su track original."""
        return ident(tid)

    by_ident = [{"track_id": ident(r["track_id"]), "lab": r["lab"]} for row in kept_rows for r in row]
    teams = track_teams_legacy(by_ident, refs)
    return {"rows": kept_rows, "kept": kept_idx, "ident": ident, "ident_box": ident_box, "teams": teams,
            "team_conf": {t: c for t, (_, c) in votes.items()}, "absorbed": absorbed, "duplicates": duplicates}


def finish_chunk(frames, rows, motions, anchors, lib, refs: dict[str, np.ndarray], fps: float, max_error_m: float) -> dict:
    """Calibra la parte, pasa las cajas a la cancha, une fragmentos, asigna equipos y resume la calidad."""
    stride_s = (frames[1] - frames[0]) / fps if len(frames) > 1 else 1 / fps
    w, h = lib.meta["image_w"], lib.meta["image_h"]
    venue = lib.meta.get("venue") or {}
    length, width = float(venue.get("length_m", PITCH_LENGTH_M)), float(venue.get("width_m", PITCH_WIDTH_M))
    Hs, dropped, _ = calibrate_processed(anchors, motions, len(frames), venue_grid(length, width), w, h, max_error_m)

    # Posición de cada caja: en metros reales para la física (unir, velocidades) y normalizada para escribir.
    meters: list[np.ndarray] = []
    positions: list[np.ndarray] = []
    insides: list[np.ndarray] = []
    # Feet: the bottom of the box, or under the head where that bottom is not reliable (feet.py, FEET_CORRECTION).
    if FEET_CORRECTION:
        feet_rows, _ = correct_rows(frames, rows, fps)
    else:
        feet_rows = [np.array([[(r["box"][0] + r["box"][2]) / 2, r["box"][3]] for r in row], dtype=float).reshape(-1, 2) for row in rows]
    for H, row, feet in zip(Hs, rows, feet_rows):
        m = to_meters(H, feet)
        xy = m * np.array([PITCH_LENGTH_M / length, PITCH_WIDTH_M / width])
        meters.append(m)
        positions.append(xy)
        insides.append(on_pitch(xy))

    prop = propose_identities(frames, rows, meters, insides, refs, fps)
    rows, positions, insides = prop["rows"], [positions[i][k] for i, k in enumerate(prop["kept"])], [insides[i][k] for i, k in enumerate(prop["kept"])]
    ident_box, teams, absorbed, duplicates = prop["ident_box"], prop["teams"], prop["absorbed"], prop["duplicates"]

    out_rows: list[list[list]] = []
    inside_counts: list[int] = []
    inside_tracks: dict[int, int] = {}
    seen: dict[int, int] = {}
    for f, row, xy, inside in zip(frames, rows, positions, insides):
        line = []
        for r, p, ins in zip(row, xy, inside):
            known = bool(np.isfinite(p).all())
            who = ident_box(f, r["track_id"])
            line.append([
                r["track_id"], *r["box"], r["conf"], *r["lab"],
                round(float(p[0]), 2) if known else None, round(float(p[1]), 2) if known else None,
                bool(ins), teams.get(who, "unk"), who,
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
    identities = {b[13] for line in out_rows for b in line if b[0] in inside_tracks}
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


# ---------------------------------------------------------------- test

TEST_S = 30


def test_summary(result: dict, frames: list[int], per_frame_s: float, total_frames: int, stride: int, fps: float) -> dict:
    """What a short test says before processing everything: how many people the detector sees per frame (all boxes and
    those on the pitch; a full pitch has about 22 players plus referees, a narrow camera sees fewer), how much was
    calibrated, and the time the whole plan would take at this speed."""
    boxes = [len(b) for b in result["boxes"]]
    on_pitch = [sum(1 for row in b if row[11]) for b in result["boxes"]]
    q = result["quality"]
    return {
        "frames": len(frames),
        "boxes_median": float(np.median(boxes)) if boxes else 0.0,
        "boxes_p10": float(np.percentile(boxes, 10)) if boxes else 0.0,
        "on_pitch_median": float(np.median(on_pitch)) if on_pitch else 0.0,
        "calibrated_share": float(q.get("calibrated_share", 0.0)),
        "identities": int(q.get("identities", 0)),
        "teams": q.get("teams") or {},
        "ms_per_frame": round(per_frame_s * 1000),
        "estimate_s": float(estimate_seconds(total_frames, stride, per_frame_s)),
        "fps": fps,
    }


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
    ap.add_argument("--model", help="modelo (carpeta OpenVINO o .pt); por defecto, `detector.model` de match.yaml o el de siempre")
    ap.add_argument("--tiles", type=int, help="trozos a lo ancho para detectar (cámara amplia); por defecto, `detector.tiles` de match.yaml o 1")
    ap.add_argument("--band", help="franja de la cancha en la imagen: «auto» (desde la calibración) o «y0,y1» en píxeles; por defecto, `detector.band` de match.yaml o todo el alto")
    ap.add_argument("--library")
    ap.add_argument("--conf", type=float, help="confianza mínima de una caja; por defecto, `detector.conf` de match.yaml o 0.2")
    ap.add_argument("--tracker", default=str(DEFAULT_TRACKER))
    ap.add_argument("--max-error", type=float, default=MAX_CONSISTENCY_M)
    ap.add_argument("--benchmark", action="store_true", help="solo mide la velocidad y estima el tiempo total")
    ap.add_argument("--test", action="store_true",
                    help=f"prueba de {TEST_S} s antes del proceso completo: escribe la parte en tracking/prueba/ con un summary.json (cuántas personas ve por cuadro, tiempo estimado) sin tocar lo hecho")
    ap.add_argument("--force", action="store_true", help="vuelve a procesar las partes ya hechas")
    ap.add_argument("--out-dir", help="carpeta de salida (por defecto, tracking/ del partido); para pruebas que no toquen lo hecho")
    args = ap.parse_args(argv)

    cfg = load_config(match=args.match, video=args.video)
    root = project_root()
    fps = float(cfg["video_fps"])
    stride = args.stride or int(cfg.get("analysis_stride") or 3)
    every = max(1, round(args.every * fps / stride))
    out_dir = Path(args.out_dir) if args.out_dir else root / cfg["paths"]["tracking_dir"]
    out_dir.mkdir(parents=True, exist_ok=True)

    lib_path = Path(args.library) if args.library else root / cfg["paths"]["tracking_dir"] / f"library_{cfg['video_id']}.npz"
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
    det_cfg = cfg.get("detector") or {}
    model_arg = args.model or det_cfg.get("model")
    model_path = (Path(model_arg) if Path(model_arg).is_absolute() or Path(model_arg).exists() else root / "weights" / model_arg) if model_arg else default_model(root)
    tiles = int(args.tiles or det_cfg.get("tiles") or 1)
    band_raw = args.band or det_cfg.get("band")
    conf = float(args.conf if args.conf is not None else det_cfg.get("conf", 0.2))
    band = "auto" if band_raw == "auto" else (tuple(int(v) for v in (band_raw.split(",") if isinstance(band_raw, str) else band_raw)) if band_raw else None)
    if not model_path.exists():
        raise SystemExit(f"No encuentro el modelo en {model_path}.")
    model = load_model(model_path)
    cap = cv2.VideoCapture(str(root / cfg["paths"]["raw_video"]))
    if not cap.isOpened():
        raise SystemExit(f"No se pudo abrir el video: {root / cfg['paths']['raw_video']}")
    meta = {
        "match_id": cfg["match_id"], "video_id": cfg["video_id"], "fps": fps, "image_w": lib.meta["image_w"], "image_h": lib.meta["image_h"],
        "model": model_path.name, "tracker": Path(args.tracker).name, "tiles": tiles, "band": band if band in (None, "auto") else list(band), "venue": lib.meta.get("venue") or {},
    }
    print(f"{cfg['match_id']} {cfg['video_id']}: {origin}, {total_frames / fps / 60:.1f} min de video en {len(chunks)} parte(s); 1 de cada {stride} cuadros")
    print(f"  detector: {model_path.name}" + (f", {tiles} trozo(s) a lo ancho" if tiles > 1 else "") + (", franja de la cancha desde la calibración" if band == "auto" else f", franja y {band[0]}-{band[1]} px" if band else ""))
    lengths = [(c.end - c.start) / fps for c in chunks]
    print(f"  duración de las partes: media {fmt_duration(sum(lengths) / len(lengths))}, la más larga {fmt_duration(max(lengths))}")
    print(f"  equipos por color: {', '.join(refs) if refs else 'sin jersey_colors en match.yaml (todo queda en unk)'}")

    if args.benchmark:
        probe = Chunk(chunks[0].start, min(chunks[0].end, chunks[0].start + round(20 * fps)))
        t0 = time.time()
        frames, rows, motions, anchors = run_chunk(cap, model, lib, probe, stride, every, conf, args.tracker, tiles=tiles, band=band, mask_rects=cfg.get("mask") or None)
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

    if args.test:
        # The first stretch of play long enough (else the longest), TEST_S seconds of it, apart from the real parts.
        long_enough = [c for c in chunks if c.end - c.start >= TEST_S * fps]
        base = long_enough[0] if long_enough else max(chunks, key=lambda c: c.end - c.start)
        probe = Chunk(base.start, min(base.end, base.start + round(TEST_S * fps)))
        test_dir = root / cfg["paths"]["tracking_dir"] / "prueba"
        test_dir.mkdir(parents=True, exist_ok=True)
        t0 = time.time()
        frames, rows, motions, anchors = run_chunk(cap, model, lib, probe, stride, every, conf, args.tracker, tiles=tiles, band=band, mask_rects=cfg.get("mask") or None)
        result = finish_chunk(frames, rows, motions, anchors, lib, refs, fps, args.max_error)
        per = (time.time() - t0) / max(1, len(frames))
        path = write_outputs(test_dir, meta, probe, stride, frames, result)
        summary = test_summary(result, frames, per, total_frames, stride, fps)
        summary.update({"part": path.name, "start_s": probe.start / fps, "end_s": probe.end / fps, "model": model_path.name, "tiles": tiles,
                        "band": meta["band"], "conf": conf, "stride": stride, "created": time.strftime("%Y-%m-%d %H:%M")})
        (test_dir / "summary.json").write_text(json.dumps(summary, indent=1), encoding="utf-8")
        print(f"  prueba: {summary['boxes_median']:.0f} cajas por cuadro (mediana), {summary['on_pitch_median']:.0f} en la cancha;"
              f" calibrado el {summary['calibrated_share'] * 100:.0f} %; {per * 1000:.0f} ms por cuadro")
        print(f"  estimado para todo lo planificado: {fmt_duration(summary['estimate_s'])}. Resultado en {test_dir / 'summary.json'}")
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
            frames, rows, motions, anchors = run_chunk(cap, model, lib, chunk, stride, every, conf, args.tracker, progress=bar, tiles=tiles, band=band, mask_rects=cfg.get("mask") or None)
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

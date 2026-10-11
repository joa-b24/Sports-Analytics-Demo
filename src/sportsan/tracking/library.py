"""Biblioteca de calibración: ubicar cualquier cuadro comparándolo con un barrido ya calibrado.

Idea: la cámara gira y hace zoom desde un punto fijo, así que dos cuadros cualesquiera que muestren una
zona parecida se relacionan por una homografía. Si un barrido de lado a lado está calibrado (unas pocas
anclas a mano + `propagate`), sus cuadros sirven de referencia: un cuadro nuevo se empareja con la
referencia más parecida y hereda su calibración. Así no hace falta marcar anclas en cada jugada.

Dos pasos:

    # 1. Una vez por sede y posición de cámara: a partir de un tramo calibrado (salida de propagate)
    python -m sportsan.tracking.library build --track matches/<id>/tracking/calib_v1_<a>_<b>.json

    # 2. Para cada jugada: anclas automáticas cada segundo + propagación entre ellas
    python -m sportsan.tracking.library locate --match <id> --start 0:33:20 --end 0:33:35

`locate` escribe el mismo `calib_*.json` que `propagate`, así que se revisa igual en la app (Calibración).
Las anclas automáticas llevan `source = "library"`. Cada una se comprueba contra sus vecinas: si la
biblioteca la ubicó mal (por ejemplo, una línea de yarda de más), no cuadra con el movimiento de cámara
medido entre cuadros y se descarta.

Límites: vale mientras la cámara no cambie de sitio respecto al barrido, y solo para encuadres parecidos
a alguno del barrido (misma zona de la cancha y un zoom no muy distinto).
"""
from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .propagate import FrameCalib, apply_h, propagate, track_to_json, venue_grid, video_motions, visible_controls

LIBRARY_SCHEMA_VERSION = 1
# Emparejamientos coherentes mínimos para aceptar una ubicación.
MIN_INLIERS = 60
# Con esta cantidad en una referencia vecina a la anterior no se busca en el resto.
GOOD_INLIERS = 250
# Un ancla automática que se aparta más que esto (metros) de lo que predicen sus vecinas se descarta.
MAX_CONSISTENCY_M = 2.0


# ---------------------------------------------------------------- selección de referencias (numpy puro)

def camera_shift_px(H_from: np.ndarray, H_to: np.ndarray, image_w: int, image_h: int) -> float:
    """Cuánto se desplazó la imagen entre dos cuadros calibrados: media en píxeles sobre una rejilla de la imagen."""
    xs = np.linspace(0.2, 0.8, 4) * image_w
    ys = np.linspace(0.5, 0.9, 3) * image_h  # mitad inferior: ahí está la cancha
    px = np.array([(x, y) for x in xs for y in ys])
    try:
        moved = apply_h(np.linalg.inv(H_to) @ H_from, px)
    except np.linalg.LinAlgError:
        return float("inf")
    d = np.linalg.norm(moved - px, axis=1)
    return float(np.nanmean(d)) if np.isfinite(d).any() else float("inf")


def select_keyframes(frames: list[tuple[int, np.ndarray]], image_w: int, image_h: int, min_shift_px: float = 150.0) -> list[int]:
    """Índices de los cuadros que entran a la biblioteca: uno nuevo cada vez que la imagen se movió lo suficiente."""
    if not frames:
        return []
    keep = [0]
    for i in range(1, len(frames)):
        if camera_shift_px(frames[keep[-1]][1], frames[i][1], image_w, image_h) >= min_shift_px:
            keep.append(i)
    if keep[-1] != len(frames) - 1:
        keep.append(len(frames) - 1)
    return keep


# ---------------------------------------------------------------- comprobación entre anclas (numpy puro)

def anchor_consistency(
    anchors: dict[int, np.ndarray],
    motions: dict[int, np.ndarray | None],
    grid_m: np.ndarray,
    image_w: int,
    image_h: int,
) -> dict[int, float | None]:
    """Para cada ancla interior: a cuántos metros queda de lo que predice la propagación entre sus dos vecinas.

    Es la versión con matrices de `propagate.leave_one_out`. None si no se pudo comparar.
    """
    frames = sorted(anchors)
    out: dict[int, float | None] = {}
    for prev, mid, nxt in zip(frames, frames[1:], frames[2:]):
        calib = propagate({prev: anchors[prev], nxt: anchors[nxt]}, motions, prev, nxt, grid_m, image_w, image_h)
        predicted = calib[mid - prev].H
        px, meters = visible_controls(anchors[mid], grid_m, image_w, image_h)
        if predicted is None or len(px) < 4:
            out[mid] = None
            continue
        err = np.linalg.norm(apply_h(predicted, px) - meters, axis=1)
        out[mid] = float(np.nanmean(err)) if np.isfinite(err).any() else None
    return out


def reject_inconsistent(
    anchors: dict[int, np.ndarray],
    motions: dict[int, np.ndarray | None],
    grid_m: np.ndarray,
    image_w: int,
    image_h: int,
    max_error_m: float = MAX_CONSISTENCY_M,
) -> tuple[dict[int, np.ndarray], list[int]]:
    """Quita, de una en una y empezando por la peor, las anclas que no cuadran con sus vecinas.

    Una sola ancla mal ubicada hace que también sus vecinas parezcan malas; por eso se quita solo la peor y se vuelve a medir.
    """
    kept = dict(anchors)
    dropped: list[int] = []
    while len(kept) >= 3:
        errors = {f: e for f, e in anchor_consistency(kept, motions, grid_m, image_w, image_h).items() if e is not None}
        if not errors:
            break
        worst = max(errors, key=errors.get)
        if errors[worst] <= max_error_m:
            break
        dropped.append(worst)
        del kept[worst]
    return kept, sorted(dropped)


# ---------------------------------------------------------------- biblioteca (OpenCV)

@dataclass
class Library:
    frames: np.ndarray          # (k,) cuadro del video de cada referencia
    H: np.ndarray               # (k, 3, 3) imagen (px) -> sede (m)
    offsets: np.ndarray         # (k + 1,) dónde empiezan los puntos de cada referencia
    xy: np.ndarray              # (n, 2) puntos característicos, en píxeles del video original
    des: np.ndarray             # (n, 128) descriptores SIFT, uint8
    meta: dict

    def ref(self, i: int) -> tuple[np.ndarray, np.ndarray]:
        a, b = self.offsets[i], self.offsets[i + 1]
        return self.xy[a:b], self.des[a:b]

    def save(self, path: str | Path) -> None:
        np.savez_compressed(path, frames=self.frames, H=self.H, offsets=self.offsets, xy=self.xy, des=self.des, meta=json.dumps(self.meta))

    @staticmethod
    def load(path: str | Path) -> "Library":
        d = np.load(path, allow_pickle=False)
        meta = json.loads(str(d["meta"]))
        if meta.get("schema_version") != LIBRARY_SCHEMA_VERSION:
            raise ValueError(f"{path}: versión de biblioteca {meta.get('schema_version')!r}; vuelve a construirla")
        return Library(d["frames"], d["H"], d["offsets"], d["xy"], d["des"], meta)


def features(gray_small, scale: float, max_features: int = 2500) -> tuple[np.ndarray, np.ndarray]:
    """Puntos característicos de un cuadro reducido; las coordenadas se devuelven en píxeles del video original."""
    import cv2

    kp, des = cv2.SIFT_create(nfeatures=max_features).detectAndCompute(gray_small, None)
    if des is None or len(kp) == 0:
        return np.empty((0, 2), np.float32), np.empty((0, 128), np.uint8)
    xy = np.float32([k.pt for k in kp]) / scale
    return xy, np.clip(np.rint(des), 0, 255).astype(np.uint8)


def read_gray(cap, frame: int, scale: float):
    import cv2

    cap.set(cv2.CAP_PROP_POS_FRAMES, frame)
    ok, img = cap.read()
    if not ok:
        return None
    if scale < 1.0:
        img = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    return cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)


@dataclass
class RefMatch:
    index: int                  # referencia de la biblioteca
    G: np.ndarray               # cuadro consultado (px) -> referencia (px)
    inliers: int
    src: np.ndarray             # puntos del cuadro consultado que apoyan G
    dst: np.ndarray             # sus parejas en la referencia


def match_to_ref(xy_q: np.ndarray, des_q: np.ndarray, xy_r: np.ndarray, des_r: np.ndarray, index: int = 0) -> RefMatch | None:
    """Empareja el cuadro consultado con una referencia. None si no hay apoyo suficiente."""
    import cv2

    if len(des_q) < MIN_INLIERS or len(des_r) < MIN_INLIERS:
        return None
    pairs = cv2.BFMatcher(cv2.NORM_L2).knnMatch(des_q.astype(np.float32), des_r.astype(np.float32), k=2)
    good = [m for m, n in (p for p in pairs if len(p) == 2) if m.distance < 0.75 * n.distance]
    if len(good) < MIN_INLIERS:
        return None
    src = np.float32([xy_q[m.queryIdx] for m in good])
    dst = np.float32([xy_r[m.trainIdx] for m in good])
    G, inliers = cv2.findHomography(src, dst, cv2.RANSAC, 4.0)
    if G is None or inliers is None or int(inliers.sum()) < MIN_INLIERS:
        return None
    ok = inliers[:, 0] == 1
    return RefMatch(index, G, int(ok.sum()), src[ok], dst[ok])


@dataclass
class Location:
    H: np.ndarray | None        # imagen (px) -> sede (m)
    inliers: int                # apoyo de la mejor referencia
    ref: int | None             # índice de la mejor referencia
    n_refs: int                 # referencias combinadas
    # Metros de diferencia media entre la respuesta combinada y la de la mejor referencia sola. Alto = las referencias
    # no coinciden entre sí en ese encuadre (calibración del barrido irregular, o poco solape con el cuadro).
    spread_m: float | None


def localize(xy_q: np.ndarray, des_q: np.ndarray, lib: Library, hint: int | None = None, pool: int = 3) -> Location:
    """Calibración de un cuadro según la biblioteca.

    Se combinan las `pool` referencias con más apoyo: cada emparejamiento da un píxel del cuadro y su posición en
    metros según esa referencia, y con todos juntos se ajusta una sola homografía. Así el error de calibración de
    una referencia concreta pesa menos y el ajuste cubre más parte de la imagen.
    `hint`: referencia que sirvió para el cuadro anterior; se prueban primero ella y sus vecinas.
    """
    import cv2

    k = len(lib.frames)
    order = list(range(k))
    if hint is not None:
        near = [i for i in (hint, hint - 1, hint + 1, hint - 2, hint + 2) if 0 <= i < k]
        order = near + [i for i in order if i not in near]
    found: list[RefMatch] = []
    for n, i in enumerate(order):
        m = match_to_ref(xy_q, des_q, *lib.ref(i), index=i)
        if m is not None:
            found.append(m)
        # Con vecinas muy claras no hace falta recorrer toda la biblioteca.
        if hint is not None and n == 4 and sum(1 for f in found if f.inliers >= GOOD_INLIERS) >= 2:
            break
    if not found:
        return Location(None, 0, None, 0, None)
    found.sort(key=lambda f: -f.inliers)
    best = found[0]
    H_best = lib.H[best.index] @ best.G
    H_best = H_best / H_best[2, 2]
    used = [f for f in found[:pool] if f.inliers >= 0.5 * best.inliers]
    if len(used) == 1:
        return Location(H_best, best.inliers, best.index, 1, None)

    src = np.concatenate([f.src for f in used]).astype(np.float64)
    meters = np.concatenate([apply_h(lib.H[f.index], f.dst) for f in used])
    ok = np.isfinite(meters).all(axis=1)
    H, _ = cv2.findHomography(src[ok], meters[ok], cv2.RANSAC, 1.0) if ok.sum() >= MIN_INLIERS else (None, None)
    if H is None:
        return Location(H_best, best.inliers, best.index, 1, None)
    H = H / H[2, 2]
    # Comparación sobre los propios puntos emparejados (dentro de la imagen, donde las dos respuestas están apoyadas).
    spread = np.linalg.norm(apply_h(H, best.src) - apply_h(H_best, best.src), axis=1)
    return Location(H, best.inliers, best.index, len(used), float(np.nanmean(spread)) if np.isfinite(spread).any() else None)


def build_library(video: str | Path, track: dict, min_shift_px: float = 150.0, work_width: int = 960, progress=None) -> Library:
    """Biblioteca a partir de un tramo calibrado (el JSON de `propagate`)."""
    import cv2

    w, h = int(track["image_w"]), int(track["image_h"])
    calibrated = [(int(f["frame"]), np.array(f["H"], dtype=float).reshape(3, 3)) for f in track["frames"] if f.get("H")]
    chosen = [calibrated[i] for i in select_keyframes(calibrated, w, h, min_shift_px)]
    if not chosen:
        raise ValueError("El tramo no tiene cuadros calibrados")
    cap = cv2.VideoCapture(str(video))
    if not cap.isOpened():
        raise FileNotFoundError(f"No se pudo abrir el video: {video}")
    scale = min(1.0, work_width / w)
    frames, Hs, xys, dess, offsets = [], [], [], [], [0]
    for n, (frame, H) in enumerate(chosen):
        gray = read_gray(cap, frame, scale)
        if gray is None:
            continue
        xy, des = features(gray, scale)
        if len(xy) < MIN_INLIERS:
            continue
        frames.append(frame)
        Hs.append(H)
        xys.append(xy)
        dess.append(des)
        offsets.append(offsets[-1] + len(xy))
        if progress:
            progress(n + 1, len(chosen))
    cap.release()
    if not frames:
        raise ValueError("Ningún cuadro del tramo dio puntos suficientes para servir de referencia")
    meta = {
        "schema_version": LIBRARY_SCHEMA_VERSION,
        "match_id": track.get("match_id"),
        "video_id": track.get("video_id"),
        "image_w": w,
        "image_h": h,
        "work_width": work_width,
        "venue": track.get("venue") or {},
        "source_frames": [int(track["start_frame"]), int(track["end_frame"])],
    }
    return Library(np.array(frames), np.array(Hs), np.array(offsets), np.concatenate(xys), np.concatenate(dess), meta)


def auto_anchors(video: str | Path, lib: Library, frames: list[int], progress=None) -> tuple[dict[int, np.ndarray], dict[int, Location]]:
    """Ubica los cuadros pedidos con la biblioteca. Devuelve (cuadro -> H) y (cuadro -> detalle); los que fallan no tienen H."""
    import cv2

    cap = cv2.VideoCapture(str(video))
    if not cap.isOpened():
        raise FileNotFoundError(f"No se pudo abrir el video: {video}")
    scale = min(1.0, lib.meta["work_width"] / lib.meta["image_w"])
    anchors: dict[int, np.ndarray] = {}
    support: dict[int, Location] = {}
    hint = None
    for n, frame in enumerate(frames):
        gray = read_gray(cap, frame, scale)
        if gray is not None:
            loc = localize(*features(gray, scale), lib, hint)
            support[frame] = loc
            if loc.H is not None:
                anchors[frame] = loc.H
                hint = loc.ref
        if progress:
            progress(n + 1, len(frames))
    cap.release()
    return anchors, support


# ---------------------------------------------------------------- CLI

def _cmd_build(args) -> None:
    from ..config import load_config, project_root

    track = json.loads(Path(args.track).read_text(encoding="utf-8"))
    if track.get("kind") != "calib_track":
        raise SystemExit(f"{args.track} no es una calibración propagada (se espera el JSON de sportsan.tracking.propagate).")
    cfg = load_config(match=args.match or track["match_id"], video=args.video or track["video_id"])
    root = project_root()
    lib = build_library(root / cfg["paths"]["raw_video"], track, args.min_shift_px, progress=lambda i, t: print(f"  referencia {i}/{t}", end="\r"))
    out = Path(args.out) if args.out else root / cfg["paths"]["tracking_dir"] / f"library_{cfg['video_id']}.npz"
    out.parent.mkdir(parents=True, exist_ok=True)
    lib.save(out)
    print(f"\nBiblioteca escrita: {out}")
    print(f"  {len(lib.frames)} referencias de los cuadros {lib.meta['source_frames'][0]} a {lib.meta['source_frames'][1]}, {len(lib.xy)} puntos")


def _cmd_locate(args) -> None:
    from ..config import load_config, project_root
    from ..timebase import parse_hms

    cfg = load_config(match=args.match, video=args.video)
    root = project_root()
    fps = float(cfg["video_fps"])
    video = root / cfg["paths"]["raw_video"]
    lib = Library.load(args.library or root / cfg["paths"]["tracking_dir"] / f"library_{cfg['video_id']}.npz")
    w, h = lib.meta["image_w"], lib.meta["image_h"]
    venue = lib.meta.get("venue") or {}
    grid = venue_grid(float(venue.get("length_m", 105)), float(venue.get("width_m", 68)))

    start, end = round(parse_hms(args.start) * fps), round(parse_hms(args.end) * fps)
    if end <= start:
        raise SystemExit("El tramo está vacío.")
    step = max(1, round(args.every * fps))
    wanted = sorted(set(range(start, end + 1, step)) | {end})
    print(f"{cfg['match_id']} {cfg['video_id']}: cuadros {start} a {end} ({(end - start) / fps:.1f} s), {len(wanted)} anclas automáticas a intentar")

    found, support = auto_anchors(video, lib, wanted, progress=lambda i, t: print(f"  ubicando {i}/{t}", end="\r"))
    print(f"\n  ubicadas con la biblioteca: {len(found)} de {len(wanted)}")
    if not found:
        raise SystemExit("La biblioteca no reconoce ningún cuadro del tramo: el encuadre no se parece a nada del barrido.")
    motions, _ = video_motions(video, start, end, lib.meta["work_width"], progress=lambda i, t: print(f"  movimiento {i}/{t}", end="\r"))
    kept, dropped = reject_inconsistent(found, motions, grid, w, h, args.max_error)
    calib = propagate(kept, motions, start, end, grid, w, h)
    calib = [FrameCalib(c.frame, c.H, "library" if c.frame in kept else c.source, c.disagreement_m) for c in calib]
    errors = anchor_consistency(kept, motions, grid, w, h)
    check = [
        {"frame": f, "from": "library", "error_mean_m": e, "error_max_m": e, "inliers": support[f].inliers, "ref_spread_m": support[f].spread_m}
        for f, e in sorted(errors.items())
    ]

    meta = {"match_id": cfg["match_id"], "video_id": cfg["video_id"], "fps": fps, "image_w": w, "image_h": h, "venue": venue}
    out = Path(args.out) if args.out else root / cfg["paths"]["tracking_dir"] / f"calib_{cfg['video_id']}_{start}_{end}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(track_to_json(meta, calib, check)), encoding="utf-8")

    print(f"\nEscrito: {out}")
    if dropped:
        print(f"  descartadas por no cuadrar con sus vecinas (> {args.max_error} m): cuadros {dropped}")
    measured = [e for e in errors.values() if e is not None]
    if measured:
        print(f"  anclas automáticas contra sus vecinas: media {np.mean(measured):.2f} m, peor {np.max(measured):.2f} m")
    spreads = [support[f].spread_m for f in kept if support[f].spread_m is not None]
    if spreads:
        print(f"  diferencia entre referencias de la biblioteca: media {np.mean(spreads):.2f} m, peor {np.max(spreads):.2f} m")
    missing = sum(1 for c in calib if c.H is None)
    if missing:
        print(f"  cuadros sin calibración: {missing} de {len(calib)}")
    print("  Revisa el tramo en la app (Calibración -> Cargar propagación): la rejilla punteada tiene que calzar con las líneas.")


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="Biblioteca de calibración a partir de un barrido calibrado.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build", help="construye la biblioteca desde un tramo calibrado")
    b.add_argument("--track", required=True, help="calib_*.json escrito por sportsan.tracking.propagate")
    b.add_argument("--match")
    b.add_argument("--video")
    b.add_argument("--out")
    b.add_argument("--min-shift-px", type=float, default=150.0, help="movimiento de imagen entre referencias consecutivas")
    b.set_defaults(func=_cmd_build)
    loc = sub.add_parser("locate", help="calibra un tramo cualquiera con la biblioteca")
    loc.add_argument("--match")
    loc.add_argument("--video")
    loc.add_argument("--library")
    loc.add_argument("--start", required=True, help="HH:MM:SS")
    loc.add_argument("--end", required=True, help="HH:MM:SS")
    loc.add_argument("--every", type=float, default=1.0, help="segundos entre anclas automáticas")
    loc.add_argument("--max-error", type=float, default=MAX_CONSISTENCY_M, help="metros a partir de los que un ancla automática se descarta")
    loc.add_argument("--out")
    loc.set_defaults(func=_cmd_locate)
    args = ap.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()

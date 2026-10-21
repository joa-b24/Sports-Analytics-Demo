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


def mask_image(rects: list, shape: tuple, scale: float, pad: float = 8.0) -> np.ndarray | None:
    """Máscara (255 = se mira, 0 = no) del tamaño de un cuadro reducido, con los rectángulos de `mask` de match.yaml (en
    píxeles del video original) tapados y un margen. None sin rectángulos."""
    if not rects:
        return None
    m = np.full(shape[:2], 255, np.uint8)
    for x0, y0, x1, y1 in rects:
        r0, r1 = max(0, int((y0 - pad) * scale)), int((y1 + pad) * scale) + 1
        c0, c1 = max(0, int((x0 - pad) * scale)), int((x1 + pad) * scale) + 1
        m[r0:r1, c0:c1] = 0
    return m


def in_mask(rects: list, x: float, y: float) -> bool:
    """¿El punto (píxeles del video original) cae en algún rectángulo tapado?"""
    return any(x0 <= x <= x1 and y0 <= y <= y1 for x0, y0, x1, y1 in rects or [])


def features(gray_small, scale: float, max_features: int = 2500, mask: np.ndarray | None = None) -> tuple[np.ndarray, np.ndarray]:
    """Puntos característicos de un cuadro reducido; las coordenadas se devuelven en píxeles del video original.
    `mask`: zonas que no se miran (mask_image)."""
    import cv2

    kp, des = cv2.SIFT_create(nfeatures=max_features).detectAndCompute(gray_small, mask)
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


# Margen alrededor de la cancha (m) para los rasgos que cuentan en el ajuste de varias referencias.
PITCH_MARGIN_M = 10.0


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

    # Solo los rasgos que caen sobre la cancha (con margen): los de gradas, edificios y cielo, llevados al suelo, quedan
    # cerca del horizonte o detrás de la cámara, a cientos de metros, y desequilibran el ajuste y la comparación.
    venue = lib.meta.get("venue") or {}
    L, W = float(venue.get("length_m", 105.0)), float(venue.get("width_m", 68.0))

    def on_pitch(m: np.ndarray) -> np.ndarray:
        return np.isfinite(m).all(axis=1) & (m[:, 0] > -PITCH_MARGIN_M) & (m[:, 0] < L + PITCH_MARGIN_M) & (m[:, 1] > -PITCH_MARGIN_M) & (m[:, 1] < W + PITCH_MARGIN_M)

    src = np.concatenate([f.src for f in used]).astype(np.float64)
    meters = np.concatenate([apply_h(lib.H[f.index], f.dst) for f in used])
    ok = on_pitch(meters)
    H, _ = cv2.findHomography(src[ok], meters[ok], cv2.RANSAC, 1.0) if ok.sum() >= MIN_INLIERS else (None, None)
    if H is None:
        return Location(H_best, best.inliers, best.index, 1, None)
    H = H / H[2, 2]
    # Comparación sobre los propios puntos emparejados que caen en la cancha, donde las dos respuestas están apoyadas.
    near = best.src[on_pitch(apply_h(H_best, best.src))]
    if len(near) == 0:
        return Location(H, best.inliers, best.index, len(used), None)
    spread = np.linalg.norm(apply_h(H, near) - apply_h(H_best, near), axis=1)
    return Location(H, best.inliers, best.index, len(used), float(np.nanmean(spread)) if np.isfinite(spread).any() else None)


def build_library(video: str | Path, track: dict, min_shift_px: float = 150.0, work_width: int = 960, progress=None, mask: list | None = None) -> Library:
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
        xy, des = features(gray, scale, mask=mask_image(mask or [], gray.shape, scale))
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
        # Lo que no se mira (marcador, logo): quien ubique cuadros con esta biblioteca lo tapa igual.
        "mask": [list(map(float, r)) for r in (mask or [])],
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
            loc = localize(*features(gray, scale, mask=mask_image(lib.meta.get("mask") or [], gray.shape, scale)), lib, hint)
            support[frame] = loc
            if loc.H is not None:
                anchors[frame] = loc.H
                hint = loc.ref
        if progress:
            progress(n + 1, len(frames))
    cap.release()
    return anchors, support


# ---------------------------------------------------------------- CLI

def track_from_anchors(data: dict, fps: float, min_points: int = 6) -> tuple[dict, list[str]]:
    """Un "tramo calibrado" hecho solo de las anclas (sin propagar): cada ancla con `min_points` o más puntos es una
    referencia. Sirve cuando las líneas solo se ven en algunos momentos y el fondo (edificios, reja) basta para ubicar
    el resto. Devuelve el tramo y avisos de las anclas que se quedan fuera."""
    from .propagate import anchor_arrays, anchor_frame, fit_homography

    frames, notes = [], []
    w = h = None
    for a in sorted(data["anchors"], key=lambda a: a.get("t_video", a["frame"])):
        px, m = anchor_arrays(a)
        f = anchor_frame(a, fps)
        if len(px) < min_points:
            notes.append(f"cuadro {f}: {len(px)} puntos (hacen falta {min_points}), fuera")
            continue
        H = fit_homography(px, m)
        if H is None:
            notes.append(f"cuadro {f}: puntos alineados, fuera")
            continue
        frames.append({"frame": f, "H": [float(v) for v in H.reshape(-1)], "source": "anchor"})
        w, h = a.get("image_w", w), a.get("image_h", h)
    track = {"kind": "calib_track", "match_id": data["match_id"], "video_id": data["video_id"], "fps": fps,
             "image_w": w, "image_h": h, "venue": data.get("venue") or {}, "frames": frames,
             "start_frame": frames[0]["frame"] if frames else 0, "end_frame": frames[-1]["frame"] if frames else 0}
    return track, notes


def _cmd_build(args) -> None:
    from ..config import load_config, project_root

    if bool(args.track) == bool(args.anchors):
        raise SystemExit("Da --track (calib_*.json de propagate) o --anchors (anchors_*.json de la app), uno de los dos.")
    if args.anchors:
        from .propagate import read_anchors

        data = read_anchors(args.anchors)
        cfg = load_config(match=args.match or data["match_id"], video=args.video or data["video_id"])
        track, notes = track_from_anchors(data, float(cfg["video_fps"]), args.min_points)
        for n in notes:
            print(f"  {n}")
        if not track["frames"]:
            raise SystemExit("Ningún ancla tiene suficientes puntos para ser referencia.")
        min_shift = 0.0  # todas las anclas buenas cuentan
    else:
        track = json.loads(Path(args.track).read_text(encoding="utf-8"))
        if track.get("kind") != "calib_track":
            raise SystemExit(f"{args.track} no es una calibración propagada (se espera el JSON de sportsan.tracking.propagate).")
        cfg = load_config(match=args.match or track["match_id"], video=args.video or track["video_id"])
        min_shift = args.min_shift_px
    root = project_root()
    if cfg.get("mask"):
        print(f"  tapado (mask de match.yaml): {len(cfg['mask'])} rectángulo(s)")
    lib = build_library(root / cfg["paths"]["raw_video"], track, min_shift, mask=cfg.get("mask"), progress=lambda i, t: print(f"  referencia {i}/{t}", end="\r"))
    out = Path(args.out) if args.out else root / cfg["paths"]["tracking_dir"] / f"library_{cfg['video_id']}.npz"
    out.parent.mkdir(parents=True, exist_ok=True)
    lib.save(out)
    print(f"\nBiblioteca escrita: {out}")
    print(f"  {len(lib.frames)} referencias de los cuadros {lib.meta['source_frames'][0]} a {lib.meta['source_frames'][1]}, {len(lib.xy)} puntos")


def locate_stretch(cfg: dict, lib: Library, start: int, end: int, every_s: float, max_error: float, out: Path, quiet: bool = False) -> dict:
    """Calibra un tramo con la biblioteca, escribe su calib_*.json (para revisarlo en Calibración › Verificar) y devuelve
    sus medidas: anclas ubicadas, descartadas, coherencia entre vecinas y entre referencias, cuadros sin calibración."""
    from ..config import project_root

    say = (lambda *a, **k: None) if quiet else print
    root = project_root()
    fps = float(cfg["video_fps"])
    video = root / cfg["paths"]["raw_video"]
    w, h = lib.meta["image_w"], lib.meta["image_h"]
    venue = lib.meta.get("venue") or {}
    grid = venue_grid(float(venue.get("length_m", 105)), float(venue.get("width_m", 68)))
    step = max(1, round(every_s * fps))
    wanted = sorted(set(range(start, end + 1, step)) | {end})
    say(f"{cfg['match_id']} {cfg['video_id']}: cuadros {start} a {end} ({(end - start) / fps:.1f} s), {len(wanted)} anclas automáticas a intentar")
    found, support = auto_anchors(video, lib, wanted, progress=None if quiet else (lambda i, t: print(f"  ubicando {i}/{t}", end="\r")))
    stats = {"start": start, "end": end, "wanted": len(wanted), "found": len(found), "dropped": [], "neighbours_m": None, "worst_m": None,
             "refs_m": None, "missing": None, "out": str(out)}
    if not found:
        return stats
    motions, _ = video_motions(video, start, end, lib.meta["work_width"], mask=lib.meta.get("mask"))
    kept, dropped = reject_inconsistent(found, motions, grid, w, h, max_error)
    calib = propagate(kept, motions, start, end, grid, w, h)
    calib = [FrameCalib(c.frame, c.H, "library" if c.frame in kept else c.source, c.disagreement_m) for c in calib]
    errors = anchor_consistency(kept, motions, grid, w, h)
    check = [
        {"frame": f, "from": "library", "error_mean_m": e, "error_max_m": e, "inliers": support[f].inliers, "ref_spread_m": support[f].spread_m}
        for f, e in sorted(errors.items())
    ]
    meta = {"match_id": cfg["match_id"], "video_id": cfg["video_id"], "fps": fps, "image_w": w, "image_h": h, "venue": venue}
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(track_to_json(meta, calib, check)), encoding="utf-8")
    measured = [e for e in errors.values() if e is not None]
    spreads = [support[f].spread_m for f in kept if support[f].spread_m is not None]
    stats.update(
        dropped=dropped,
        neighbours_m=float(np.mean(measured)) if measured else None,
        worst_m=float(np.max(measured)) if measured else None,
        refs_m=float(np.mean(spreads)) if spreads else None,
        missing=sum(1 for c in calib if c.H is None),
        frames=len(calib),
    )
    return stats


def _cmd_locate(args) -> None:
    from ..config import load_config, project_root
    from ..timebase import parse_hms

    cfg = load_config(match=args.match, video=args.video)
    root = project_root()
    fps = float(cfg["video_fps"])
    lib = Library.load(args.library or root / cfg["paths"]["tracking_dir"] / f"library_{cfg['video_id']}.npz")
    start, end = round(parse_hms(args.start) * fps), round(parse_hms(args.end) * fps)
    if end <= start:
        raise SystemExit("El tramo está vacío.")
    out = Path(args.out) if args.out else root / cfg["paths"]["tracking_dir"] / f"calib_{cfg['video_id']}_{start}_{end}.json"
    st = locate_stretch(cfg, lib, start, end, args.every, args.max_error, out)
    print(f"\n  ubicadas con la biblioteca: {st['found']} de {st['wanted']}")
    if not st["found"]:
        raise SystemExit("La biblioteca no reconoce ningún cuadro del tramo: el encuadre no se parece a nada del barrido.")
    print(f"Escrito: {out}")
    if st["dropped"]:
        print(f"  descartadas por no cuadrar con sus vecinas (> {args.max_error} m): cuadros {st['dropped']}")
    if st["neighbours_m"] is not None:
        print(f"  anclas automáticas contra sus vecinas: media {st['neighbours_m']:.2f} m, peor {st['worst_m']:.2f} m")
    if st["refs_m"] is not None:
        print(f"  diferencia entre referencias de la biblioteca: media {st['refs_m']:.2f} m")
    if st["missing"]:
        print(f"  cuadros sin calibración: {st['missing']} de {st['frames']}")
    print("  Revisa el tramo en la app (Calibración › Verificar › cargar el calib_…): la rejilla punteada tiene que calzar con las líneas.")


def _cmd_check(args) -> None:
    """Antes de procesar todo: varios tramos repartidos por los tramos de juego, cada uno ubicado con la biblioteca, con
    una tabla de cómo salió y sus calib_*.json en tracking/revision/ para mirarlos en la app."""
    from ..config import load_config, project_root
    from ..timebase import load_segments

    cfg = load_config(match=args.match, video=args.video)
    root = project_root()
    fps = float(cfg["video_fps"])
    lib = Library.load(args.library or root / cfg["paths"]["tracking_dir"] / f"library_{cfg['video_id']}.npz")
    seg_file = root / cfg["paths"]["segments_csv"]
    if not seg_file.exists():
        raise SystemExit("Hace falta segments.csv con los tramos de juego (pestaña Tramos de la app).")
    segs = load_segments(seg_file, cfg["video_id"])
    play = [(float(r.start_s), float(r.end_s)) for r in segs[segs["tipo"] == "juego"].itertuples()]
    if not play:
        raise SystemExit(f"segments.csv no tiene tramos de juego para {cfg['video_id']}.")
    total = sum(b - a for a, b in play)
    # Puntos repartidos sobre el tiempo de juego (no sobre el video): el centro de cada uno es el centro de un tramo.
    picks = []
    for k in range(args.samples):
        t = (k + 0.5) * total / args.samples
        for a, b in play:
            if t <= b - a:
                mid = a + t
                lo, hi = max(a, mid - args.seconds / 2), min(b, mid + args.seconds / 2)
                picks.append((round(lo * fps), round(hi * fps)))
                break
            t -= b - a
    out_dir = root / cfg["paths"]["tracking_dir"] / "revision"
    print(f"{cfg['match_id']} {cfg['video_id']}: {len(picks)} tramos de {args.seconds:g} s repartidos por {total / 60:.0f} min de juego")
    rows = []
    for n, (a, b) in enumerate(picks, 1):
        print(f"  tramo {n}/{len(picks)}…", end="\r")
        rows.append(locate_stretch(cfg, lib, a, b, args.every, args.max_error, out_dir / f"calib_{cfg['video_id']}_{a}_{b}.json", quiet=True))
    fmt_t = lambda f: f"{int(f / fps // 60)}:{int(f / fps % 60):02d}"
    print("\n\n  tramo        ubicadas  descartadas  vecinas (media/peor)  referencias  sin calibrar")
    bad = 0
    for r in rows:
        nb = "      -" if r["neighbours_m"] is None else f"{r['neighbours_m']:5.2f} / {r['worst_m']:4.2f} m"
        rf = "    -" if r["refs_m"] is None else f"{r['refs_m']:5.2f} m"
        miss = "-" if r["missing"] is None else f"{r['missing']}/{r.get('frames', 0)}"
        ok = r["found"] and r["neighbours_m"] is not None and r["neighbours_m"] < 1.0 and (r["refs_m"] or 0) < 1.5 and not r["missing"]
        bad += not ok
        print(f"  {fmt_t(r['start'])}-{fmt_t(r['end'])}  {r['found']:>3}/{r['wanted']:<3}  {len(r['dropped']):>6}       {nb:>18}   {rf:>10}   {miss:>7}  {'bien' if ok else 'REVISAR'}")
    print(f"\n  Archivos en {out_dir}: en la app, Calibración › Verificar › cargar cada calib_… y mirar que la rejilla calce.")
    print("  " + ("Todo dentro de lo esperado: se puede procesar." if not bad else f"{bad} tramo(s) para revisar: añade un ancla cerca de ellos y reconstruye la biblioteca."))


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="Biblioteca de calibración a partir de un barrido calibrado.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build", help="construye la biblioteca desde un tramo calibrado")
    b.add_argument("--track", help="calib_*.json escrito por sportsan.tracking.propagate")
    b.add_argument("--anchors", help="anchors_*.json de la app: cada ancla buena es una referencia, sin propagar (líneas que solo se ven a ratos)")
    b.add_argument("--min-points", type=int, default=6, help="con --anchors: puntos mínimos de un ancla para ser referencia")
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
    chk = sub.add_parser("check", help="antes de procesar: varios tramos repartidos por el partido, con una tabla y sus calib_ para revisar")
    chk.add_argument("--match")
    chk.add_argument("--video")
    chk.add_argument("--library")
    chk.add_argument("--samples", type=int, default=8, help="cuántos tramos")
    chk.add_argument("--seconds", type=float, default=10.0, help="duración de cada tramo")
    chk.add_argument("--every", type=float, default=1.0, help="segundos entre anclas automáticas")
    chk.add_argument("--max-error", type=float, default=MAX_CONSISTENCY_M)
    chk.set_defaults(func=_cmd_check)
    args = ap.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()

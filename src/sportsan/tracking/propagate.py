"""Propagación de la calibración entre anclas (paso A3 de la hoja de ruta).

La analista calibra a mano unos pocos cuadros (anclas) en la app. Aquí se estima cómo se movió la
cámara de un cuadro al siguiente y se lleva la homografía de cada ancla a los cuadros intermedios.
Entre dos anclas se combinan la propagación hacia adelante y hacia atrás; cuánto discrepan es la
medida automática de calidad de cada cuadro.

Convenciones (las del contrato):
- H: imagen (px) -> sede (metros reales), matriz 3x3.
- G[k]: imagen del cuadro k (px) -> imagen del cuadro k+1 (px). Entonces H[k+1] = H[k] @ inv(G[k]).

Supuesto: la cámara gira y hace zoom desde un punto fijo (trípode). En ese caso el movimiento entre
dos cuadros es una homografía válida para toda la imagen, no solo para el plano de la cancha.

Uso:
    python -m sportsan.tracking.propagate --anchors anchors_<match>_<video>.json [--start 0:03:40 --end 0:03:55]

El cálculo de las cadenas es numpy puro (probado en tests/test_propagate.py); solo la lectura del
video y la estimación del movimiento usan OpenCV.
"""
from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

ANCHORS_SCHEMA_VERSION = 2
TRACK_SCHEMA_VERSION = 1
# Menos correspondencias que esto entre dos cuadros: el movimiento no es fiable y la cadena se corta.
MIN_INLIERS = 40


# ---------------------------------------------------------------- geometría (numpy puro)

def apply_h(H: np.ndarray, pts: np.ndarray) -> np.ndarray:
    """Aplica una homografía a puntos (n, 2). Los puntos en el infinito salen como NaN."""
    pts = np.asarray(pts, dtype=float).reshape(-1, 2)
    p = np.c_[pts, np.ones(len(pts))] @ np.asarray(H, dtype=float).T
    w = p[:, 2:3]
    with np.errstate(divide="ignore", invalid="ignore"):
        out = p[:, :2] / w
    out[np.abs(w[:, 0]) < 1e-12] = np.nan
    return out


def _normalizer(pts: np.ndarray) -> np.ndarray:
    c = pts.mean(axis=0)
    d = np.linalg.norm(pts - c, axis=1).mean()
    s = np.sqrt(2) / d if d > 1e-12 else 1.0
    return np.array([[s, 0, -s * c[0]], [0, s, -s * c[1]], [0, 0, 1]])


def fit_homography(src: np.ndarray, dst: np.ndarray) -> np.ndarray | None:
    """Homografía src -> dst por mínimos cuadrados (DLT normalizado). None si no se puede calcular."""
    src = np.asarray(src, dtype=float).reshape(-1, 2)
    dst = np.asarray(dst, dtype=float).reshape(-1, 2)
    if len(src) < 4 or len(src) != len(dst) or not (np.isfinite(src).all() and np.isfinite(dst).all()):
        return None
    Ts, Td = _normalizer(src), _normalizer(dst)
    s, d = apply_h(Ts, src), apply_h(Td, dst)
    rows = []
    for (x, y), (u, v) in zip(s, d):
        rows.append([-x, -y, -1, 0, 0, 0, u * x, u * y, u])
        rows.append([0, 0, 0, -x, -y, -1, v * x, v * y, v])
    _, sv, vt = np.linalg.svd(np.asarray(rows))
    if sv[-2] < 1e-9:  # puntos alineados: no hay solución única
        return None
    H = np.linalg.inv(Td) @ vt[-1].reshape(3, 3) @ Ts
    if abs(H[2, 2]) < 1e-12:
        return None
    return H / H[2, 2]


def venue_grid(length_m: float, width_m: float, step_m: float = 5.0) -> np.ndarray:
    """Puntos de control sobre la cancha, en metros."""
    xs = np.arange(0, length_m + 1e-6, step_m)
    ys = np.arange(0, width_m + 1e-6, step_m)
    return np.array([(x, y) for x in xs for y in ys], dtype=float)


def visible_controls(H: np.ndarray, grid_m: np.ndarray, image_w: int, image_h: int) -> tuple[np.ndarray, np.ndarray]:
    """Puntos de la rejilla que caen dentro de la imagen según H. Devuelve (px, metros)."""
    try:
        Hinv = np.linalg.inv(H)
    except np.linalg.LinAlgError:
        return np.empty((0, 2)), np.empty((0, 2))
    px = apply_h(Hinv, grid_m)
    # Mismo lado de la cámara: el denominador proyectivo no cambia de signo respecto al centro visible.
    w = np.c_[grid_m, np.ones(len(grid_m))] @ Hinv.T[:, 2]
    ok = np.isfinite(px).all(axis=1) & (px[:, 0] >= 0) & (px[:, 0] <= image_w) & (px[:, 1] >= 0) & (px[:, 1] <= image_h)
    if ok.any():
        ok &= np.sign(w) == np.sign(np.median(w[ok]))
    return px[ok], grid_m[ok]


def blend(Hf: np.ndarray, Hb: np.ndarray, weight_b: float, grid_m: np.ndarray, image_w: int, image_h: int) -> tuple[np.ndarray, float | None]:
    """Combina la propagación hacia adelante (Hf) y hacia atrás (Hb).

    Se mezclan las posiciones en metros que cada una da a los mismos píxeles, y se reajusta.
    Devuelve (H, discrepancia media en metros entre las dos). Sin puntos visibles suficientes, gana la más cercana.
    """
    px, m_f = visible_controls(Hf, grid_m, image_w, image_h)
    if len(px) < 6:
        return (Hb if weight_b >= 0.5 else Hf), None
    m_b = apply_h(Hb, px)
    ok = np.isfinite(m_b).all(axis=1)
    if ok.sum() < 6:
        return (Hb if weight_b >= 0.5 else Hf), None
    px, m_f, m_b = px[ok], m_f[ok], m_b[ok]
    disagreement = float(np.linalg.norm(m_f - m_b, axis=1).mean())
    H = fit_homography(px, (1 - weight_b) * m_f + weight_b * m_b)
    if H is None:
        return (Hb if weight_b >= 0.5 else Hf), disagreement
    return H, disagreement


@dataclass
class FrameCalib:
    frame: int
    H: np.ndarray | None
    source: str                 # "anchor", "propagated" o "none"
    disagreement_m: float | None = None


def _chain_forward(H0: np.ndarray, motions: dict[int, np.ndarray | None], start: int, end: int) -> dict[int, np.ndarray]:
    """H de cada cuadro de start a end partiendo de H0 en start. Se detiene donde falta el movimiento."""
    out = {start: H0}
    H = H0
    for k in range(start, end):
        G = motions.get(k)
        if G is None:
            break
        H = H @ np.linalg.inv(G)
        out[k + 1] = H / H[2, 2]
    return out


def _chain_backward(H1: np.ndarray, motions: dict[int, np.ndarray | None], start: int, end: int) -> dict[int, np.ndarray]:
    """H de cada cuadro de end a start partiendo de H1 en end."""
    out = {end: H1}
    H = H1
    for k in range(end - 1, start - 1, -1):
        G = motions.get(k)
        if G is None:
            break
        H = H @ G
        out[k] = H / H[2, 2]
    return out


def propagate(
    anchors: dict[int, np.ndarray],
    motions: dict[int, np.ndarray | None],
    start: int,
    end: int,
    grid_m: np.ndarray,
    image_w: int,
    image_h: int,
) -> list[FrameCalib]:
    """Calibración de cada cuadro de [start, end] a partir de las anclas y del movimiento entre cuadros.

    anchors: cuadro -> H del ancla. motions: k -> G[k] (o None si no se pudo estimar).
    """
    frames = sorted(f for f in anchors if start <= f <= end)
    if not frames:
        raise ValueError("No hay anclas dentro del rango pedido")
    result: dict[int, FrameCalib] = {}

    # Antes de la primera ancla y después de la última: una sola dirección, sin medida de discrepancia.
    for k, H in _chain_backward(anchors[frames[0]], motions, start, frames[0]).items():
        result[k] = FrameCalib(k, H, "propagated")
    for k, H in _chain_forward(anchors[frames[-1]], motions, frames[-1], end).items():
        result[k] = FrameCalib(k, H, "propagated")

    for a, b in zip(frames, frames[1:]):
        fwd = _chain_forward(anchors[a], motions, a, b)
        bwd = _chain_backward(anchors[b], motions, a, b)
        for k in range(a + 1, b):
            Hf, Hb = fwd.get(k), bwd.get(k)
            if Hf is not None and Hb is not None:
                H, dis = blend(Hf, Hb, (k - a) / (b - a), grid_m, image_w, image_h)
                result[k] = FrameCalib(k, H, "propagated", dis)
            elif Hf is not None or Hb is not None:
                result[k] = FrameCalib(k, Hf if Hf is not None else Hb, "propagated")
            else:
                result[k] = FrameCalib(k, None, "none")

    for f in frames:
        result[f] = FrameCalib(f, anchors[f], "anchor", 0.0)
    return [result.get(k, FrameCalib(k, None, "none")) for k in range(start, end + 1)]


def leave_one_out(
    anchor_points: dict[int, tuple[np.ndarray, np.ndarray]],
    motions: dict[int, np.ndarray | None],
    grid_m: np.ndarray,
    image_w: int,
    image_h: int,
) -> list[dict]:
    """Comprobación con anclas de control: se quita cada ancla interior y se mide a cuántos metros
    quedan sus puntos según la propagación entre sus dos vecinas. Es la estimación honesta del error.

    anchor_points: cuadro -> (px (n, 2), metros (n, 2)).
    """
    frames = sorted(anchor_points)
    fits = {f: fit_homography(*anchor_points[f]) for f in frames}
    out = []
    for prev, mid, nxt in zip(frames, frames[1:], frames[2:]):
        if fits[prev] is None or fits[nxt] is None:
            continue
        calib = propagate({prev: fits[prev], nxt: fits[nxt]}, motions, prev, nxt, grid_m, image_w, image_h)
        H = calib[mid - prev].H
        if H is None:
            out.append({"frame": mid, "from": [prev, nxt], "error_mean_m": None, "error_max_m": None})
            continue
        px, meters = anchor_points[mid]
        err = np.linalg.norm(apply_h(H, px) - meters, axis=1)
        out.append({"frame": mid, "from": [prev, nxt], "error_mean_m": float(err.mean()), "error_max_m": float(err.max())})
    return out


# ---------------------------------------------------------------- entrada y salida

def find_anchors(path: str | Path, matches_dir: Path | None = None) -> Path:
    """Ruta del archivo de anclas. Si no existe tal cual y es solo un nombre (anchors_<partido>_<video>.json), se busca
    en la carpeta tracking/ de cada partido, que es donde la app lo guarda."""
    p = Path(path)
    if p.exists() or p.parent != Path("."):
        return p
    from ..config import MATCHES_DIR, project_root

    hits = sorted((matches_dir or project_root() / MATCHES_DIR).glob(f"*/tracking/{p.name}"))
    if len(hits) == 1:
        return hits[0]
    if len(hits) > 1:
        raise FileNotFoundError(f"{p.name} está en varios partidos: " + ", ".join(str(h) for h in hits) + ". Da la ruta completa.")
    raise FileNotFoundError(f"No encuentro {p.name} ni aquí ni en matches/*/tracking/. Expórtalo desde Calibración -> Exportar anclas.")


def read_anchors(path: str | Path) -> dict:
    """Lee el JSON de anclas exportado por la app (Calibración -> Exportar anclas)."""
    path = find_anchors(path)
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if data.get("schema_version") != ANCHORS_SCHEMA_VERSION:
        raise ValueError(
            f"{path}: schema_version {data.get('schema_version')!r}; hace falta {ANCHORS_SCHEMA_VERSION} "
            "(con las coordenadas en metros de cada punto). Vuelve a exportar las anclas desde la app."
        )
    if not data.get("anchors"):
        raise ValueError(f"{path}: no trae anclas")
    return data


def anchor_arrays(anchor: dict) -> tuple[np.ndarray, np.ndarray]:
    px = np.array([[p["px"], p["py"]] for p in anchor["points"]], dtype=float)
    meters = np.array([[p["x_m"], p["y_m"]] for p in anchor["points"]], dtype=float)
    return px, meters


def track_to_json(meta: dict, calib: list[FrameCalib], check: list[dict]) -> dict:
    return {
        "schema_version": TRACK_SCHEMA_VERSION,
        "kind": "calib_track",
        **meta,
        "start_frame": calib[0].frame,
        "end_frame": calib[-1].frame,
        "frames": [
            {
                "frame": c.frame,
                "H": None if c.H is None else [float(v) for v in c.H.reshape(-1)],
                "source": c.source,
                "disagreement_m": c.disagreement_m,
            }
            for c in calib
        ],
        "check": check,
    }


# ---------------------------------------------------------------- video (OpenCV)

def estimate_motion(prev_gray, gray, scale: float) -> tuple[np.ndarray | None, int]:
    """Homografía del cuadro anterior al actual, en píxeles del video original. (None, n) si no es fiable."""
    import cv2

    p0 = cv2.goodFeaturesToTrack(prev_gray, maxCorners=1500, qualityLevel=0.01, minDistance=8)
    if p0 is None or len(p0) < MIN_INLIERS:
        return None, 0
    p1, st1, _ = cv2.calcOpticalFlowPyrLK(prev_gray, gray, p0, None, winSize=(21, 21), maxLevel=3)
    back, st2, _ = cv2.calcOpticalFlowPyrLK(gray, prev_gray, p1, None, winSize=(21, 21), maxLevel=3)
    # Solo puntos que vuelven a su sitio al seguirlos de regreso.
    ok = (st1[:, 0] == 1) & (st2[:, 0] == 1) & (np.linalg.norm((p0 - back).reshape(-1, 2), axis=1) < 1.0)
    if ok.sum() < MIN_INLIERS:
        return None, int(ok.sum())
    # RANSAC descarta lo que se mueve por su cuenta (jugadoras, balón, público).
    G, inliers = cv2.findHomography(p0[ok], p1[ok], cv2.RANSAC, 2.0)
    n = int(inliers.sum()) if inliers is not None else 0
    if G is None or n < MIN_INLIERS:
        return None, n
    S = np.diag([scale, scale, 1.0])  # original -> reducido
    return np.linalg.inv(S) @ G @ S, n


def video_motions(video: str | Path, start: int, end: int, work_width: int = 960, progress=None) -> tuple[dict[int, np.ndarray | None], tuple[int, int]]:
    """Movimiento de cámara G[k] para k en [start, end). Lee el video en orden desde `start`."""
    import cv2

    cap = cv2.VideoCapture(str(video))
    if not cap.isOpened():
        raise FileNotFoundError(f"No se pudo abrir el video: {video}")
    w, h = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    scale = min(1.0, work_width / w)
    cap.set(cv2.CAP_PROP_POS_FRAMES, start)

    def grab():
        ok, frame = cap.read()
        if not ok:
            return None
        if scale < 1.0:
            frame = cv2.resize(frame, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
        return cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

    motions: dict[int, np.ndarray | None] = {}
    prev = grab()
    for k in range(start, end):
        cur = grab() if prev is not None else None
        if cur is None:
            motions[k] = None
            prev = None
            continue
        motions[k], _ = estimate_motion(prev, cur, scale)
        prev = cur
        if progress and (k - start) % 50 == 0:
            progress(k - start, end - start)
    cap.release()
    return motions, (w, h)


# ---------------------------------------------------------------- CLI

def main(argv: list[str] | None = None) -> None:
    from ..config import load_config, project_root
    from ..timebase import parse_hms

    ap = argparse.ArgumentParser(description="Propaga la calibración entre las anclas marcadas en la app.")
    ap.add_argument("--anchors", required=True, help="JSON exportado desde Calibración -> Exportar anclas")
    ap.add_argument("--match", help="match_id (por defecto, el del archivo de anclas)")
    ap.add_argument("--video", help="video_id (por defecto, el del archivo de anclas)")
    ap.add_argument("--start", help="inicio del tramo (HH:MM:SS); por defecto, la primera ancla")
    ap.add_argument("--end", help="fin del tramo (HH:MM:SS); por defecto, la última ancla")
    ap.add_argument("--out", help="archivo de salida; por defecto, en la carpeta tracking/ del partido")
    ap.add_argument("--work-width", type=int, default=960, help="ancho al que se reduce el video para estimar el movimiento")
    args = ap.parse_args(argv)

    data = read_anchors(args.anchors)
    cfg = load_config(match=args.match or data["match_id"], video=args.video or data["video_id"])
    fps = float(cfg["video_fps"])
    root = project_root()
    video = root / cfg["paths"]["raw_video"]

    points = {int(a["frame"]): anchor_arrays(a) for a in data["anchors"] if len(a["points"]) >= 4}
    anchors = {f: H for f, (px, m) in points.items() if (H := fit_homography(px, m)) is not None}
    if not anchors:
        raise SystemExit("Ningún ancla tiene 4 o más puntos utilizables.")
    start = round(parse_hms(args.start) * fps) if args.start else min(anchors)
    end = round(parse_hms(args.end) * fps) if args.end else max(anchors)
    if end <= start:
        raise SystemExit("El tramo está vacío: hace falta más de un ancla, o --start/--end.")
    inside = {f: H for f, H in anchors.items() if start <= f <= end}
    if not inside:
        raise SystemExit("No hay anclas dentro del tramo pedido.")
    n = end - start
    print(f"{cfg['match_id']} {cfg['video_id']}: cuadros {start} a {end} ({n / fps:.1f} s), {len(inside)} ancla(s)")
    if n > 3000:
        print("  Aviso: tramo largo. La propagación está pensada para jugadas de 10 a 20 s; el error crece lejos de las anclas.")

    motions, (w, h) = video_motions(video, start, end, args.work_width, progress=lambda i, t: print(f"  movimiento {i}/{t}", end="\r"))
    lost = sum(1 for g in motions.values() if g is None)
    venue = data.get("venue") or {}
    grid = venue_grid(float(venue.get("length_m", 105)), float(venue.get("width_m", 68)))
    calib = propagate(inside, motions, start, end, grid, w, h)
    check = leave_one_out({f: points[f] for f in inside}, motions, grid, w, h)

    meta = {"match_id": cfg["match_id"], "video_id": cfg["video_id"], "fps": fps, "image_w": w, "image_h": h, "venue": venue}
    out = Path(args.out) if args.out else root / cfg["paths"]["tracking_dir"] / f"calib_{cfg['video_id']}_{start}_{end}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(track_to_json(meta, calib, check)), encoding="utf-8")

    dis = [c.disagreement_m for c in calib if c.source == "propagated" and c.disagreement_m is not None]
    print(f"\nEscrito: {out}")
    print(f"  cuadros sin movimiento fiable: {lost} de {n}")
    if dis:
        print(f"  discrepancia adelante/atrás: media {np.mean(dis):.2f} m, máxima {np.max(dis):.2f} m")
    else:
        print("  sin discrepancia que medir: hace falta un ancla a cada lado del tramo")
    if check:
        print("  anclas de control (se quita cada ancla interior y se mide su error):")
        for c in check:
            err = "sin resultado" if c["error_mean_m"] is None else f"media {c['error_mean_m']:.2f} m, máx. {c['error_max_m']:.2f} m"
            print(f"    cuadro {c['frame']}: {err}")
    else:
        print("  sin anclas de control: con 3 o más anclas se mide el error real en las interiores")


if __name__ == "__main__":
    main()

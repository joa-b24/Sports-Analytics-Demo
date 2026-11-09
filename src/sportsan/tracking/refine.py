"""Refinar una parte ya procesada sin detectar de nuevo: pies corregidos y calibración suavizada en el tiempo.

    python -m sportsan.tracking.refine --match <id> --part <parte> [--out <ruta>] [--no-feet] [--no-smooth-h]

Usa las cajas en píxeles y las H guardadas en `tracks_<parte>.json` (schema 3) para:

(a) pies: recalcular x, y con `feet.correct_rows` (la corrección que `process` aplica desde el 2026-10-21; las partes
    procesadas antes tienen los pies en el borde inferior de la caja);
(b) calibración suavizada: la H de cada cuadro tiembla (se calcula cuadro por cuadro) y eso mueve a todas las jugadoras a
    la vez, más lejos de la cámara. No se filtran los 9 números de H: se proyectan a la cancha 6 puntos fijos de la imagen
    (la zona donde hay jugadoras: 3 columnas x 2 filas), se suaviza cada trayectoria con mediana (quita cuadros sueltos
    malos) y Savitzky-Golay de grado 2 (sigue barridos de cámara sin retraso) y se reconstruye H de esos puntos. No se
    suaviza a través de un corte: un cuadro sin H o un salto de los puntos de más de CUT_M que no vuelve en el cuadro
    siguiente (cambio de calibración de la biblioteca) parte la serie en tramos independientes.

Idempotente: el JSON guarda `"refined": {"feet": bool, "smooth_h": bool, ...}` y nunca suaviza dos veces. Con `--out` no
toca el original; sin `--out` escribe en sitio y deja antes una copia `<archivo>.pre_refine.json` (y regenera el parquet
`tracking_*` validado). Progreso en tracking/revision/progreso_refine_<parte>.log.
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

import numpy as np

from ..schema import PITCH_LENGTH_M, PITCH_WIDTH_M
from .feet import apply_h, correct_rows

# Ventana del suavizado (s): ~0.7 s quita el temblor de cuadro a cuadro y deja pasar barridos de cámara.
WINDOW_S = 0.7
# Ventana de la mediana previa (muestras, impar): quita un cuadro suelto con H mala.
MEDIAN_SAMPLES = 3
# Salto de la mediana de los puntos fijos entre dos muestras (m) que se trata como corte si no vuelve en la siguiente.
CUT_M = 4.0
# ...y que además es CUT_RATIO veces mayor que el movimiento típico alrededor (un barrido rápido no es un corte).
CUT_RATIO = 4.0
# Tramos más cortos que esto (muestras) se dejan como están.
MIN_RUN = 5
# Un punto fijo donde un píxel vale más que esto (m) está casi en el horizonte: ese cuadro no se suaviza.
MAX_M_PER_PX = 3.0
# Si Savitzky-Golay se aparta de la mediana más que esto (m) en algún punto, el cuadro se queda con la mediana.
MAX_SG_DEV_M = 1.5


def image_points(feet_rows: list[np.ndarray], w: float = 1920, h: float = 1080) -> np.ndarray:
    """6 puntos fijos de la imagen (3 columnas x 2 filas) dentro de la zona donde hay pies; por defecto, la mitad baja."""
    allf = np.concatenate([f for f in feet_rows if len(f)]) if any(len(f) for f in feet_rows) else np.zeros((0, 2))
    allf = allf[np.isfinite(allf).all(axis=1)]
    if len(allf) >= 20:
        xs = np.quantile(allf[:, 0], [0.1, 0.5, 0.9])
        ys = np.quantile(allf[:, 1], [0.15, 0.85])
    else:
        xs, ys = np.array([0.15, 0.5, 0.85]) * w, np.array([0.55, 0.85]) * h
    if ys[1] - ys[0] < 20:
        ys = np.array([ys[0] - 10, ys[0] + 10])
    return np.array([[x, y] for y in ys for x in xs], dtype=float)


def fit_h(src: np.ndarray, dst: np.ndarray) -> np.ndarray | None:
    """Homografía src -> dst por DLT normalizado (mínimos cuadrados con 4 o más puntos)."""
    def norm(p):
        c = p.mean(axis=0)
        s = np.sqrt(2) / max(1e-9, np.mean(np.linalg.norm(p - c, axis=1)))
        return np.array([[s, 0, -s * c[0]], [0, s, -s * c[1]], [0, 0, 1]])
    if len(src) < 4 or not (np.isfinite(src).all() and np.isfinite(dst).all()):
        return None
    Ts, Td = norm(src), norm(dst)
    a = apply_h(Ts, src)
    b = apply_h(Td, dst)
    A = []
    for (x, y), (u, v) in zip(a, b):
        A.append([-x, -y, -1, 0, 0, 0, u * x, u * y, u])
        A.append([0, 0, 0, -x, -y, -1, v * x, v * y, v])
    _, _, vt = np.linalg.svd(np.asarray(A))
    Hn = vt[-1].reshape(3, 3)
    H = np.linalg.inv(Td) @ Hn @ Ts
    if abs(H[2, 2]) < 1e-12:
        return None
    return H / H[2, 2]


def _project(H, pts: np.ndarray) -> np.ndarray | None:
    if H is None:
        return None
    H = np.asarray(H, dtype=float).reshape(3, 3)
    den = np.c_[pts, np.ones(len(pts))] @ H[2]
    if not (np.all(den > 0) or np.all(den < 0)):   # algún punto por encima del horizonte: H no sirve aquí
        return None
    p = apply_h(H, pts)
    if not np.isfinite(p).all():
        return None
    # Cerca del horizonte un píxel son metros: ahí el suavizado en metros no tiene sentido (se deja H tal cual).
    q = apply_h(H, pts + [0.0, 1.0])
    if np.max(np.linalg.norm(q - p, axis=1)) > MAX_M_PER_PX:
        return None
    return p


def _runs(P: list[np.ndarray | None]) -> list[tuple[int, int]]:
    """Tramos [i, j) sin cortes: muestras con proyección válida y sin salto grande que no vuelve."""
    n = len(P)
    med = np.full(n, np.nan)
    for i in range(1, n):
        if P[i] is not None and P[i - 1] is not None:
            med[i] = float(np.median(np.linalg.norm(P[i] - P[i - 1], axis=1)))
    cut = np.zeros(n, dtype=bool)
    for i in range(1, n):
        if P[i] is None or P[i - 1] is None:
            cut[i] = True
            continue
        if med[i] <= CUT_M:
            continue
        around = med[max(1, i - 5):i + 6].copy()
        around = np.delete(around, min(5, i - max(1, i - 5)))
        typ = np.nanmedian(around) if np.isfinite(around).any() else 0.0
        if med[i] < CUT_RATIO * max(typ, 0.25):
            continue
        # Un cuadro suelto que salta y vuelve es un cuadro malo (lo quita la mediana), no un corte.
        back = i + 1 < n and P[i + 1] is not None and float(np.median(np.linalg.norm(P[i + 1] - P[i - 1], axis=1))) < 0.5 * med[i]
        if not back:
            cut[i] = True
    runs, s = [], None
    for i in range(n):
        if P[i] is None:
            if s is not None:
                runs.append((s, i))
            s = None
            continue
        if s is None:
            s = i
        elif cut[i]:
            runs.append((s, i))
            s = i
    if s is not None:
        runs.append((s, n))
    return runs


def _smooth_series(y: np.ndarray, win: int) -> np.ndarray:
    from scipy.ndimage import median_filter
    from scipy.signal import savgol_filter

    n = len(y)
    if n < MIN_RUN:
        return y
    med = median_filter(y, size=(MEDIAN_SAMPLES, 1), mode="nearest")
    w = min(win, n if n % 2 else n - 1)
    if w < 5:
        return med
    sg = savgol_filter(med, w, 2, axis=0, mode="interp")
    d = np.linalg.norm((sg - med).reshape(n, -1, 2), axis=2).max(axis=1)
    sg[d > MAX_SG_DEV_M] = med[d > MAX_SG_DEV_M]
    return sg


def smooth_homographies(Hs: list, times_s: np.ndarray, pts_px: np.ndarray, window_s: float = WINDOW_S) -> tuple[list, dict]:
    """H suavizadas (misma longitud; None donde no había) e información: tramos, cortes y puntos antes/después."""
    times_s = np.asarray(times_s, dtype=float)
    n = len(Hs)
    P = [_project(H, pts_px) for H in Hs]
    dt = float(np.median(np.diff(times_s))) if n > 1 else 1.0
    win = int(round(window_s / max(dt, 1e-6)))
    win = max(5, win | 1)
    out: list = [None if H is None else np.asarray(H, dtype=float).reshape(3, 3) for H in Hs]
    before = np.full((n, len(pts_px), 2), np.nan)
    after = np.full((n, len(pts_px), 2), np.nan)
    runs = _runs(P)
    for s, e in runs:
        Y = np.stack([P[i] for i in range(s, e)])            # (m, k, 2)
        before[s:e] = Y
        if e - s < MIN_RUN:
            after[s:e] = Y
            continue
        Z = _smooth_series(Y.reshape(e - s, -1), win).reshape(Y.shape)
        for j, i in enumerate(range(s, e)):
            H = fit_h(pts_px, Z[j])
            if H is not None and _project(H, pts_px) is not None:
                out[i] = H
                after[i] = Z[j]
            else:
                after[i] = Y[j]
    for i, H in enumerate(Hs):
        if H is not None and P[i] is None:   # H que no proyecta los puntos fijos: se deja como estaba
            out[i] = np.asarray(H, dtype=float).reshape(3, 3)
    unsmoothed = sum(1 for H, p in zip(Hs, P) if H is not None and p is None) + sum(e - s for s, e in runs if e - s < MIN_RUN)
    return out, {"runs": runs, "cuts": max(0, len(runs) - 1), "window_samples": win, "before": before, "after": after,
                 "unsmoothed": unsmoothed}


def _frames_rows(data: dict):
    c = {name: i for i, name in enumerate(data["box_columns"])}
    frames = [fr["frame"] for fr in data["frames"]]
    rows = [[{"track_id": int(b[c["track_id"]]), "box": [b[c["x1"]], b[c["y1"]], b[c["x2"]], b[c["y2"]]]} for b in fr["boxes"]] for fr in data["frames"]]
    return c, frames, rows


def feet_marks_from_rows(part: str, fps: float, stride: int, frames: list[int], rows: list[list[dict]], feet_rows) -> dict:
    """Archivo auxiliar `tracks_<parte>.feet.json`: solo las cajas cuyos pies se corrigieron, con el pie corregido en px
    {"part", "fps", "stride", "boxes": {"<cuadro>": {"<track_id>": [x_px, y_px]}}}. La app dibuja ahí una línea."""
    boxes: dict[str, dict[str, list[float]]] = {}
    for f, row, ft in zip(frames, rows, feet_rows):
        for r, p in zip(row, ft):
            b = r["box"]
            if abs(p[1] - b[3]) > 1e-6 or abs(p[0] - (b[0] + b[2]) / 2) > 1e-6:
                boxes.setdefault(str(f), {})[str(r["track_id"])] = [round(float(p[0]), 1), round(float(p[1]), 1)]
    return {"part": part, "fps": fps, "stride": stride, "boxes": boxes}


def feet_marks(data: dict, part: str) -> dict:
    """Marcas de pies de una parte (ya refinada o no): mismo cálculo determinista que refine, sin tocar H."""
    _, frames, rows = _frames_rows(data)
    fps = float(data["fps"])
    feet_rows, _ = correct_rows(frames, rows, fps)
    return feet_marks_from_rows(part, fps, int(data.get("stride") or 1), frames, rows, feet_rows)


def feet_marks_path(tracks: Path) -> Path:
    return tracks.with_name(tracks.stem + ".feet.json")


def refine_tracks(data: dict, feet: bool = True, smooth_h: bool = True, progress=None, window_s: float = WINDOW_S) -> tuple[dict, dict]:
    """Devuelve (datos refinados, resumen). Pura: no lee ni escribe archivos. Si ya se hizo lo pedido, devuelve los datos
    tal cual con `summary["skipped"] = True`."""
    from .process import on_pitch

    log = progress.log if progress else (lambda *a: None)
    prev = data.get("refined") or {}
    do_smooth = smooth_h and not prev.get("smooth_h")
    new_feet = feet and not prev.get("feet")
    if not do_smooth and not new_feet:
        return data, {"skipped": True, "refined": prev}
    do_feet = feet or bool(prev.get("feet"))   # los pies ya corregidos se vuelven a calcular igual (deterministas)

    c, frames, rows = _frames_rows(data)
    fps = float(data["fps"])
    log("pies", 0, 1)
    if do_feet:
        feet_rows, n_fixed = correct_rows(frames, rows, fps)
    else:
        feet_rows = [np.array([[(r["box"][0] + r["box"][2]) / 2, r["box"][3]] for r in row], dtype=float).reshape(-1, 2) for row in rows]
        n_fixed = 0
    log("pies", 1, 1)
    Hs = [None if fr.get("H") is None else np.asarray(fr["H"], dtype=float).reshape(3, 3) for fr in data["frames"]]
    info: dict = {"cuts": 0}
    pts = image_points(feet_rows, float(data.get("image_w") or 1920), float(data.get("image_h") or 1080))
    if do_smooth:
        log("calibración", 0, 1)
        Hs, info = smooth_homographies(Hs, np.array(frames) / fps, pts, window_s)
        log("calibración", 1, 1)
    venue = data.get("venue") or {}
    L, W = float(venue.get("length_m") or PITCH_LENGTH_M), float(venue.get("width_m") or PITCH_WIDTH_M)
    scale = np.array([PITCH_LENGTH_M / L, PITCH_WIDTH_M / W])
    new_frames = []
    n = len(frames)
    for i, (fr, H, f) in enumerate(zip(data["frames"], Hs, feet_rows)):
        boxes = [list(b) for b in fr["boxes"]]
        if H is not None and len(f):
            xy = apply_h(H, f) * scale
            ins = on_pitch(xy)
        else:
            xy, ins = np.full((len(f), 2), np.nan), np.zeros(len(f), dtype=bool)
        for b, p, k in zip(boxes, xy, ins):
            ok = bool(np.isfinite(p).all())
            b[c["x"]] = round(float(p[0]), 2) if ok else None
            b[c["y"]] = round(float(p[1]), 2) if ok else None
            if "on_pitch" in c:
                b[c["on_pitch"]] = bool(k)
        new_frames.append({**fr, "H": None if H is None else [float(v) for v in np.asarray(H).reshape(-1)], "boxes": boxes})
        if i % 500 == 0:
            log("posiciones", i, n)
    log("posiciones", n, n)
    refined = {"feet": do_feet, "smooth_h": bool(prev.get("smooth_h")) or do_smooth, "window_s": window_s if do_smooth else prev.get("window_s", window_s), "cut_m": CUT_M,
               "feet_fixed": n_fixed, "h_cuts": info.get("cuts", 0)}
    out = {**data, "frames": new_frames, "refined": refined}
    return out, {"skipped": False, "refined": refined, "info": info, "points_px": pts}


def _write_parquet(path: Path, data: dict) -> None:
    """Regenera tracking_<parte>.parquet (validado) desde el JSON refinado."""
    from .detect import Chunk
    from .process import tracking_table

    meta = {"match_id": data["match_id"], "video_id": data["video_id"], "fps": data["fps"]}
    chunk = Chunk(int(data["start_frame"]), int(data["end_frame"]))
    frames = [fr["frame"] for fr in data["frames"]]
    table = tracking_table(meta, chunk, frames, [fr["boxes"] for fr in data["frames"]])
    table.to_parquet(path, index=False)


def main(argv: list[str] | None = None) -> None:
    from sportsan.config import load_config, project_root

    from .anchors_cli import Progress

    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(prog="python -m sportsan.tracking.refine", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--match")
    ap.add_argument("--part", required=True, help="p. ej. v2_34220_45027")
    ap.add_argument("--out", help="JSON de salida; sin él se escribe en sitio con copia .pre_refine.json")
    ap.add_argument("--no-feet", action="store_true")
    ap.add_argument("--no-smooth-h", action="store_true")
    ap.add_argument("--feet-marks-only", action="store_true",
                    help="solo escribe tracks_<parte>.feet.json (cajas con pies corregidos) sin tocar los tracks")
    args = ap.parse_args(argv)
    cfg = load_config(match=args.match)
    from .process import post_settings

    post = post_settings(cfg)  # `postprocess` de match.yaml (lo elegido en la app); las banderas --no-* solo apagan
    dir_ = project_root() / cfg["paths"]["tracking_dir"]
    src = dir_ / f"tracks_{args.part}.json"
    pg = Progress(dir_ / "revision" / f"progreso_refine_{args.part}.log")
    if args.feet_marks_only:
        pg.log("pies", 0, 1)
        marks = write_feet_marks(json.loads(src.read_text(encoding="utf-8")), args.part, feet_marks_path(src))
        pg.log("pies", 1, 1)
        print(f"Marcas de pies: {sum(len(v) for v in marks['boxes'].values())} cajas -> {feet_marks_path(src)}")
        return
    summary = refine_file(src, Path(args.out) if args.out else None, feet=post["feet"] and not args.no_feet, smooth_h=post["smooth_h"] and not args.no_smooth_h, progress=pg, window_s=post["window_s"])
    if summary["skipped"]:
        print(f"La parte ya estaba refinada ({summary['refined']}); no se cambia nada.")
        return
    r = summary["refined"]
    print(f"Refinada {args.part}: pies corregidos {r['feet_fixed']} cajas; cortes de calibración {r['h_cuts']}; -> {summary['path']}")


def backup_path(src: Path) -> Path:
    return src.with_name(src.stem + ".pre_refine.json")


def refine_file(src: Path, out: Path | None = None, feet: bool = True, smooth_h: bool = True, progress=None, window_s: float = WINDOW_S) -> dict:
    """Refina `src`. Con `out`, escribe ahí y no toca nada más. Sin `out`, en sitio: copia `<parte>.pre_refine.json` (solo
    la primera vez: guarda el original de verdad) y regenera `tracking_<parte>.parquet` validado."""
    log = progress.log if progress else (lambda *a: None)
    log("lectura", 0, 1)
    data = json.loads(src.read_text(encoding="utf-8"))
    log("lectura", 1, 1)
    new, summary = refine_tracks(data, feet=feet, smooth_h=smooth_h, progress=progress, window_s=window_s)
    if summary["skipped"]:
        log("listo", 1, 1)
        return summary
    log("escritura", 0, 1)
    if out is not None:
        dst = out
        dst.parent.mkdir(parents=True, exist_ok=True)
    else:
        dst = src
        if not backup_path(src).exists():
            shutil.copy2(src, backup_path(src))
    # La tabla del contrato primero: si no valida, no se toca el JSON.
    if out is None:
        part = src.stem.removeprefix("tracks_")
        pq = src.with_name(f"tracking_{part}.parquet")
        tmp_pq = pq.with_suffix(".tmp")
        _write_parquet(tmp_pq, new)
    tmp = dst.with_suffix(".tmp")
    tmp.write_text(json.dumps(new, separators=(",", ":")), encoding="utf-8")
    tmp.replace(dst)
    if out is None:
        tmp_pq.replace(pq)
    if new["refined"].get("feet"):
        write_feet_marks(new, src.stem.removeprefix("tracks_"), feet_marks_path(dst))
    log("escritura", 1, 1)
    return {**summary, "path": str(dst)}


def write_feet_marks(data: dict, part: str, path: Path) -> dict:
    marks = feet_marks(data, part)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(marks, separators=(",", ":")), encoding="utf-8")
    tmp.replace(path)
    return marks


if __name__ == "__main__":
    main()

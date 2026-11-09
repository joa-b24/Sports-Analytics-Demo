"""Reidentificación por apariencia para unir trozos (docs/propuesta_union_tracks.md).

Por cada trozo puro (`tracklets.pure_tracklets`) se eligen hasta `SAMPLES` cajas nítidas (altas, sin solape con otra caja
y sin cortar en el borde de la imagen), se recortan del video y se describen con:

- `classic`: histograma Lab por franjas verticales (cabeza / torso / piernas, solo el centro de la caja para quitar
  césped) + orientaciones de gradiente por franja (un HOG simple). numpy + OpenCV, sin pesos.
- `onnx`: un modelo de re-id pequeño ya en `weights/` (`yolo26n-reid.onnx`, 512 valores), por onnxruntime en CPU.

El vector del trozo es la media de sus cajas (normalizada); la similitud entre trozos es el coseno. Los vectores por caja
se guardan en `tracking/revision/reid_cache/<parte>.npz` (fuera del repo), así que el video se lee una sola vez.

Uso en el modelo de unión (opcional, sin tocar `FEATURES`): `reid_column` da una columna más para cada candidato, la
similitud si las dos cajas del paso miden al menos `h_min` px de alto y `NO_SIM` si no. `links_eval --reid` y
`anchors --reid` la añaden.

    python -m sportsan.tracking.reid --match 2026_09_25_tec_ccm_vs_anahuac      # medición y revision/reid.md
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np

from sportsan.tracking.tracklets import Box, Tracklet

SAMPLES = 5
CROP_W, CROP_H = 32, 64            # recorte normalizado del descriptor clásico
ONNX_W, ONNX_H = 128, 256
STRIPES = ((0.0, 0.2), (0.2, 0.55), (0.55, 1.0))   # cabeza, torso, piernas (fracción del alto)
CENTER = (0.2, 0.8)                # franja horizontal que se usa (quita césped de los lados)
ISO_IOU = 0.05                     # una caja que se solapa más que esto con otra no se usa si hay otras
EDGE_PX = 2.0
NO_SIM = -1.0                      # similitud cuando las cajas son demasiado chicas
H_BUCKETS = (0, 60, 100, 150, 10_000)
ONNX_WEIGHTS = "weights/yolo26n-reid.onnx"


# --------------------------------------------------------------------------------------------- elegir cajas

def _iou_matrix(b: np.ndarray) -> np.ndarray:
    x1, y1, x2, y2 = b[:, 0], b[:, 1], b[:, 2], b[:, 3]
    ix = np.clip(np.minimum(x2[:, None], x2) - np.maximum(x1[:, None], x1), 0, None)
    iy = np.clip(np.minimum(y2[:, None], y2) - np.maximum(y1[:, None], y1), 0, None)
    inter = ix * iy
    area = (x2 - x1) * (y2 - y1)
    u = area[:, None] + area - inter
    out = np.where(u > 0, inter / np.maximum(u, 1e-9), 0.0)
    np.fill_diagonal(out, 0.0)
    return out


def overlap_by_box(frames: list[list[Box]]) -> dict[tuple[int, int], float]:
    """(cuadro, track) -> mayor IoU con otra caja del mismo cuadro (todas, también fuera de la cancha)."""
    out = {}
    for row in frames:
        if not row:
            continue
        b = np.array([[x.x1, x.y1, x.x2, x.y2] for x in row], dtype=float)
        m = _iou_matrix(b).max(axis=1) if len(row) > 1 else np.zeros(1)
        for x, v in zip(row, m):
            out[(x.frame, x.track)] = float(v)
    return out


def pick_boxes(t: Tracklet, overlap: dict, image_w: float, image_h: float, n: int = SAMPLES) -> list[Box]:
    """Hasta n cajas del trozo: las más altas entre las que no se solapan ni tocan el borde; repartidas en el tiempo."""
    def score(b: Box) -> float:
        clean = overlap.get((b.frame, b.track), 0.0) <= ISO_IOU
        inside = b.x1 > EDGE_PX and b.y1 > EDGE_PX and b.x2 < image_w - EDGE_PX and b.y2 < image_h - EDGE_PX
        return b.h * (1.0 if clean else 0.3) * (1.0 if inside else 0.5)

    order = sorted(t.boxes, key=lambda b: -score(b))
    gap = max(1, (t.end - t.start) // (2 * n)) if len(t.boxes) > n else 0
    out: list[Box] = []
    for b in order:
        if all(abs(b.frame - o.frame) >= gap for o in out):
            out.append(b)
        if len(out) == n:
            break
    return out


# --------------------------------------------------------------------------------------------- descriptores

def classic_descriptor(crop_bgr: np.ndarray) -> np.ndarray:
    """Lab (4 + 8 + 8 cajones) y 8 orientaciones de gradiente por franja, cada bloque en raíz (Hellinger)."""
    import cv2

    img = cv2.resize(crop_bgr, (CROP_W, CROP_H), interpolation=cv2.INTER_AREA)
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB).astype(np.float32)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32)
    gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=1)
    gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=1)
    mag = np.hypot(gx, gy)
    ang = (np.arctan2(gy, gx) % np.pi) / np.pi * 8
    c0, c1 = int(CENTER[0] * CROP_W), int(CENTER[1] * CROP_W)
    blocks = []
    for lo, hi in STRIPES:
        r0, r1 = int(lo * CROP_H), int(hi * CROP_H)
        p = lab[r0:r1, c0:c1].reshape(-1, 3)
        for ch, bins in ((0, 4), (1, 8), (2, 8)):
            h = np.bincount(np.minimum((p[:, ch] / 256 * bins).astype(int), bins - 1), minlength=bins).astype(float)
            blocks.append(np.sqrt(h / max(h.sum(), 1)))
        a = ang[r0:r1].ravel().astype(int) % 8
        g = np.bincount(a, weights=mag[r0:r1].ravel(), minlength=8)
        blocks.append(0.7 * np.sqrt(g / max(g.sum(), 1e-6)))
    v = np.concatenate(blocks)
    return v / max(np.linalg.norm(v), 1e-9)


class OnnxReid:
    def __init__(self, path: Path):
        import onnxruntime as ort

        self.sess = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])

    def __call__(self, crops: list[np.ndarray]) -> np.ndarray:
        import cv2

        if not crops:
            return np.zeros((0, 512), dtype=np.float32)
        x = np.stack([cv2.cvtColor(cv2.resize(c, (ONNX_W, ONNX_H)), cv2.COLOR_BGR2RGB) for c in crops]).astype(np.float32) / 255
        out = self.sess.run(None, {"images": x.transpose(0, 3, 1, 2)})[0]
        return out / np.maximum(np.linalg.norm(out, axis=1, keepdims=True), 1e-9)


# --------------------------------------------------------------------------------------------- video y caché

def extract(video: Path, wanted: dict[int, list[Box]], onnx: OnnxReid | None = None, progress=None) -> dict:
    """Lee los cuadros pedidos en orden (salta con set si el hueco es grande) y describe cada caja."""
    import cv2

    cap = cv2.VideoCapture(str(video))
    keys, cl, on, hs = [], [], [], []
    pos = -1
    frames = sorted(wanted)
    for i, f in enumerate(frames):
        if f - pos > 200 or pos < 0:
            cap.set(cv2.CAP_PROP_POS_FRAMES, f)
            pos = f
        while pos < f:
            cap.grab()
            pos += 1
        ok, img = cap.read()
        pos += 1
        if not ok:
            continue
        crops = []
        for b in wanted[f]:
            x1, y1 = max(0, int(b.x1)), max(0, int(b.y1))
            x2, y2 = min(img.shape[1], int(np.ceil(b.x2))), min(img.shape[0], int(np.ceil(b.y2)))
            if x2 - x1 < 4 or y2 - y1 < 8:
                continue
            crop = img[y1:y2, x1:x2]
            keys.append((b.frame, b.track))
            cl.append(classic_descriptor(crop))
            hs.append(b.h)
            crops.append(crop)
        if onnx is not None and crops:
            on.append(onnx(crops))
        if progress and i % 200 == 0:
            progress(i, len(frames))
    cap.release()
    out = {"keys": np.array(keys, dtype=np.int64).reshape(-1, 2), "classic": np.array(cl, dtype=np.float32), "h": np.array(hs, dtype=np.float32)}
    if onnx is not None:
        out["onnx"] = np.vstack(on) if on else np.zeros((0, 512), dtype=np.float32)
    return out


def box_vectors(cache: Path, video: Path, tracklets: list[Tracklet], frames: list[list[Box]], image_w: float, image_h: float,
                use_onnx: bool = True, log=print) -> dict:
    """Vectores por caja elegida de cada trozo, de la caché o del video. Devuelve {"keys", "classic", "h", ["onnx"]}."""
    if cache.exists():
        d = dict(np.load(cache))
        if not use_onnx or "onnx" in d:
            return d
    overlap = overlap_by_box(frames)
    wanted: dict[int, list[Box]] = {}
    for t in tracklets:
        for b in pick_boxes(t, overlap, image_w, image_h):
            wanted.setdefault(b.frame, []).append(b)
    onnx = None
    if use_onnx:
        from sportsan.config import project_root

        w = project_root() / ONNX_WEIGHTS
        onnx = OnnxReid(w) if w.exists() else None
    t0 = time.time()
    d = extract(video, wanted, onnx, progress=lambda i, n: log(f"  {cache.stem}: {i}/{n} cuadros, {time.time() - t0:.0f} s"))
    cache.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(cache, **d)
    log(f"  {cache.stem}: {len(d['keys'])} cajas en {time.time() - t0:.0f} s")
    return d


def tracklet_vectors(tracklets: list[Tracklet], boxes: dict, method: str = "classic") -> tuple[np.ndarray, np.ndarray]:
    """Vector medio (normalizado) y alto mediano de las cajas usadas de cada trozo; NaN si no tiene ninguna."""
    idx = {(int(f), int(t)): i for i, (f, t) in enumerate(boxes["keys"])}
    D = boxes[method]
    V = np.full((len(tracklets), D.shape[1] if len(D) else 1), np.nan, dtype=np.float32)
    H = np.full(len(tracklets), np.nan)
    for i, t in enumerate(tracklets):
        rows = [idx[(b.frame, b.track)] for b in t.boxes if (b.frame, b.track) in idx]
        if rows:
            v = D[rows].mean(axis=0)
            V[i] = v / max(np.linalg.norm(v), 1e-9)
            H[i] = float(np.median(boxes["h"][rows]))
    return V, H


def reid_column(cands, V: np.ndarray, H: np.ndarray, h_min: float) -> np.ndarray:
    """Similitud de apariencia de cada candidato (a, b) si las dos cajas miden >= h_min px; si no, NO_SIM."""
    out = np.full(len(cands), NO_SIM)
    for i, c in enumerate(cands):
        if np.isfinite(H[c.a]) and np.isfinite(H[c.b]) and min(H[c.a], H[c.b]) >= h_min:
            out[i] = float(np.dot(V[c.a], V[c.b]))
    return out


def auc(pos: np.ndarray, neg: np.ndarray) -> float:
    """Área bajo la curva ROC por rangos (Mann-Whitney)."""
    if len(pos) == 0 or len(neg) == 0:
        return float("nan")
    s = np.concatenate([pos, neg])
    order = s.argsort()
    r = np.empty(len(s))
    r[order] = np.arange(1, len(s) + 1)
    # ties: average ranks
    _, inv, cnt = np.unique(s, return_inverse=True, return_counts=True)
    sums = np.bincount(inv, weights=r)
    r = (sums / cnt)[inv]
    return float((r[: len(pos)].sum() - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg)))


# --------------------------------------------------------------------------------------------- uso desde links_eval / anchors

def part_boxes(dir_: Path, match: str | None, name: str, part, tracklets: list[Tracklet], use_onnx: bool = True, log=print) -> dict:
    """Vectores por caja de una parte (`links_eval.Part`); lee la caché o el video."""
    from sportsan.config import load_config, project_root

    raw_head = _head(dir_ / f"tracks_{name}.json")
    video = project_root() / load_config(match=match, video=name.split("_")[0])["paths"]["raw_video"]
    return box_vectors(dir_ / "revision" / "reid_cache" / f"{name}.npz", video, tracklets, part.frames,
                       raw_head["image_w"], raw_head["image_h"], use_onnx=use_onnx, log=log)


def part_reid(dir_: Path, match: str | None, name: str, part, tracklets: list[Tracklet], method: str = "classic", log=print):
    """(V, H) de los trozos de una parte."""
    return tracklet_vectors(tracklets, part_boxes(dir_, match, name, part, tracklets, method == "onnx", log), method)


def _head(path: Path) -> dict:
    with open(path, encoding="utf-8") as f:
        s = f.read(2000)
    out = {}
    for k in ("image_w", "image_h"):
        i = s.find(f'"{k}": ')
        out[k] = float(s[i + len(k) + 4: s.find(",", i)]) if i >= 0 else (1920.0 if k == "image_w" else 1080.0)
    return out


# --------------------------------------------------------------------------------------------- medición

def main(argv: list[str] | None = None) -> None:
    import sys

    from sportsan.config import load_config, project_root
    from sportsan.tracking.links_eval import load_part, named_parts
    from sportsan.tracking.tracklets import candidate_labels, link_candidates, pure_tracklets, tracklet_truth

    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--match")
    ap.add_argument("--parts", default="v1_6414_13699,v1_14541_15944,v1_16648_22211,v1_23140_26173,v1_26910_32826,v1_33818_35062,"
                    "v1_36135_41389,v1_41994_43460,v1_44071_52064,v1_52933_72647,v1_73385_78596,v2_0_4259,v2_5020_10226,v3_0_6890")
    ap.add_argument("--no-onnx", action="store_true")
    ap.add_argument("--max-pairs", type=int, default=300_000)
    ap.add_argument("--report", default="reid_auc.md")
    args = ap.parse_args(argv)
    cfg = load_config(match=args.match)
    dir_ = project_root() / cfg["paths"]["tracking_dir"]
    avail = set(named_parts(dir_))
    names = [p for p in args.parts.split(",") if p in avail]
    methods = ["classic"] + ([] if args.no_onnx else ["onnx"])
    rng = np.random.default_rng(0)
    t_all = time.time()
    # Per bucket and method: similarity of same / different player, all pairs and phase-1 candidates.
    acc = {(m, kind, k): ([], []) for m in methods for kind in ("pairs", "cands") for k in range(len(H_BUCKETS) - 1)}
    sizes_tl, sizes_box = [], []
    for n in names:
        p = load_part(dir_, n, feet=True)
        tl = pure_tracklets(p.frames, p.fps)
        sizes_box += [b.h for row in p.frames for b in row if b.on_pitch]
        labels = json.loads((dir_ / f"labels_{n}.json").read_text(encoding="utf-8"))
        team_of = {int(x["label"]): x.get("team") or "unk" for x in labels["people"]}
        who = np.array([(lambda w: w if isinstance(w, int) else -1)(tracklet_truth(t, p.truth)[0]) for t in tl])
        team = np.array([team_of.get(int(w), "unk") for w in who])
        cands = link_candidates(tl, p.fps)
        y = candidate_labels(cands, tl, p.truth)
        bx = part_boxes(dir_, args.match, n, p, tl, "onnx" in methods)
        for m in methods:
            V, H = tracklet_vectors(tl, bx, m)
            if m == "classic":
                sizes_tl += [h for h in H if np.isfinite(h)]
            ok = np.where((who >= 0) & np.isfinite(H))[0]
            i, j = np.triu_indices(len(ok), 1)
            if len(i) > args.max_pairs // len(names):
                s = rng.choice(len(i), args.max_pairs // len(names), replace=False)
                i, j = i[s], j[s]
            a, b = ok[i], ok[j]
            same_team = team[a] == team[b]
            a, b = a[same_team], b[same_team]
            sim = np.einsum("ij,ij->i", V[a], V[b])
            hm = np.minimum(H[a], H[b])
            same = who[a] == who[b]
            for k in range(len(H_BUCKETS) - 1):
                sel = (hm >= H_BUCKETS[k]) & (hm < H_BUCKETS[k + 1])
                acc[(m, "pairs", k)][0].append(sim[sel & same])
                acc[(m, "pairs", k)][1].append(sim[sel & ~same])
            col = reid_column(cands, V, H, 0.0)
            hc = np.array([min(H[c.a], H[c.b]) for c in cands]) if cands else np.zeros(0)
            for k in range(len(H_BUCKETS) - 1):
                sel = (hc >= H_BUCKETS[k]) & (hc < H_BUCKETS[k + 1]) & (col > NO_SIM)
                acc[(m, "cands", k)][0].append(col[sel & (y == 1)])
                acc[(m, "cands", k)][1].append(col[sel & (y == 0)])
        print(f"{n}: {len(tl)} trozos, {time.time() - t_all:.0f} s", flush=True)
    lines = ["# AUC de la apariencia por alto de caja", "", "| Método | Pares | Alto mínimo del par (px) | Misma | Distinta | AUC |", "|---|---|---|---|---|---|"]
    res = {}
    for (m, kind, k), (ps, ns) in acc.items():
        pos, neg = np.concatenate(ps), np.concatenate(ns)
        res[(m, kind, k)] = auc(pos, neg)
        lines.append(f"| {m} | {kind} | {H_BUCKETS[k]}–{H_BUCKETS[k + 1] if k < len(H_BUCKETS) - 2 else '∞'} | {len(pos)} | {len(neg)} | {res[(m, kind, k)]:.3f} |")
    sb, st = np.array(sizes_box), np.array(sizes_tl)
    lines += ["", "| Alto (px) | Cajas en la cancha | Trozos (alto mediano de sus cajas usadas) |", "|---|---|---|"]
    for th in (60, 100, 150):
        lines.append(f"| ≥ {th} | {100 * (sb >= th).mean():.1f} % | {100 * (st >= th).mean():.1f} % |")
    lines += ["", f"Cajas: mediana {np.median(sb):.0f} px, p10 {np.percentile(sb, 10):.0f}, p90 {np.percentile(sb, 90):.0f}. Tiempo: {time.time() - t_all:.0f} s.", ""]
    out = dir_ / "revision" / args.report
    out.write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines))


if __name__ == "__main__":
    main()

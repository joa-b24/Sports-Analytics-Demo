"""Tracker automático de balón: aprende de las marcas a mano y solo marca donde está muy seguro.

Flujo pensado para la mesa de corrección: se revisa a mano el balón de un tramo mediano, se entrena con todas las marcas
que haya (`train`) y se corre sobre las partes que faltan (`run`). Escribe `ball_auto_<video>_<inicio>_<fin>.json`
junto a la parte; la app lo muestra en la vista Balón como marcas automáticas y pide a mano lo que falta.

Cómo decide, por cuadro procesado de la parte (1 de cada `stride`):
1. Candidatos: manchas blancas pequeñas (top-hat sobre la blancura) dentro de la cancha proyectada con la H del cuadro.
2. Clasificador: una red pequeña (torch, CPU) sobre un recorte de 32 x 32 del cuadro y de la diferencia con el cuadro
   procesado anterior llevado a este con las dos H (así las líneas pintadas, que no se mueven, se borran).
3. Solo lo seguro: el mejor candidato del cuadro con probabilidad alta y apoyado por candidatos coherentes en los
   cuadros vecinos (a una distancia que el balón puede recorrer). Lo demás queda vacío: nunca se rellena.

Uso (desde la raíz del repo, con `pip install -e ".[detect]"`):
    python -m sportsan.tracking.ball train [--match <id> ...]          # modelo con las marcas a mano de esos partidos
    python -m sportsan.tracking.ball run --match <id> [--video v1] [--part tracks_v1_<ini>_<fin>.json] [--force]
    python -m sportsan.tracking.ball eval --match <id> --part tracks_v1_<ini>_<fin>.json   # contra las marcas a mano
"""
from __future__ import annotations

import argparse
import json
import math
import random
import re
import time
from pathlib import Path

import numpy as np

from ..config import list_matches, project_root

PATCH = 32
# Candidatos: radio del top-hat (px), umbral de blancura sobre su entorno y tamaño de la mancha.
TOPHAT_R = 5
TOPHAT_THR = 22
BLOB_AREA = (3, 260)
BLOB_MAX_SIDE = 26
BLOB_MAX_RATIO = 4.0
# Como mucho, los candidatos más blancos de cada cuadro (el balón casi siempre está entre ellos y así va rápido).
MAX_CANDIDATES = 200
# Margen alrededor de la cancha donde se busca (m reales).
PITCH_MARGIN_M = 3.0
# Entrenamiento: una marca vale si un candidato cae a esta distancia (las marcas aproximadas se dejan fuera), y los
# negativos se toman a partir de esta otra.
POS_R_PX = 8.0
NEG_R_PX = 40.0
NEG_PER_FRAME = 80
# Decisión: probabilidad para aceptar, para apoyar desde un cuadro vecino, y cuánto puede moverse el balón (px por
# cuadro procesado, a 1080 de alto).
# Con 0.90 y 2 vecinos, en dos partes de 2026-09-25 no usadas al entrenar: 94 % de acierto contra las marcas a mano
# limpias y la mitad de marcas pedidas que sin tracker (con 0.95: 98 % y un tercio menos; con 0.80: 80 %).
ACCEPT_P = 0.90
SUPPORT_P = 0.5
MAX_STEP_PX = 90.0
# Cuadros procesados vecinos que se miran a cada lado, y cuántos deben apoyar.
SUPPORT_SPAN = 2
SUPPORT_MIN = 2
# Huecos: se pide una marca cada tantos segundos dentro de un hueco sin balón seguro.
ASK_EVERY_S = 1.0
MODEL_NAME = "ball_model.pt"


# ------------------------------------------------------------------------------------------------- geometría

def pitch_polygon(H, venue: dict, margin_m: float = PITCH_MARGIN_M) -> np.ndarray | None:
    """Contorno de la cancha (con margen) en píxeles, o None si no se puede proyectar delante de la cámara."""
    if H is None:
        return None
    inv = np.linalg.inv(np.asarray(H, float).reshape(3, 3))
    L, W = float(venue["length_m"]), float(venue["width_m"])
    if inv[2] @ np.array([L / 2, W / 2, 1.0]) < 0:
        inv = -inv
    pts = []
    m = margin_m
    for x, y in [(-m, -m), (L / 2, -m), (L + m, -m), (L + m, W / 2), (L + m, W + m), (L / 2, W + m), (-m, W + m), (-m, W / 2)]:
        q = inv @ np.array([x, y, 1.0])
        if q[2] <= 1e-9:
            return None
        pts.append((q[0] / q[2], q[1] / q[2]))
    return np.array(pts, np.float32)


def to_pixel(H, venue: dict, x: float, y: float) -> tuple[float, float] | None:
    """Punto de la cancha normalizada (105 x 68) -> píxel, con H de imagen a metros reales."""
    inv = np.linalg.inv(np.asarray(H, float).reshape(3, 3))
    L, W = float(venue["length_m"]), float(venue["width_m"])
    if inv[2] @ np.array([L / 2, W / 2, 1.0]) < 0:
        inv = -inv
    q = inv @ np.array([x * L / 105, y * W / 68, 1.0])
    return (q[0] / q[2], q[1] / q[2]) if q[2] > 1e-9 else None


def candidates(img: np.ndarray, polygon: np.ndarray | None, cap: int | None = MAX_CANDIDATES) -> np.ndarray:
    """Manchas blancas pequeñas dentro de la cancha: centros (N, 2) en píxeles. Al correr se quedan las `cap` más
    blancas; al entrenar van todas (cap=None): el modelo aprende de los negativos difíciles que el tope dejaría fuera."""
    import cv2

    # Solo el rectángulo que ocupa la cancha (más un borde para el top-hat): el cielo y la grada no se miran.
    x0 = y0 = 0
    if polygon is not None:
        h, w = img.shape[:2]
        pad = 2 * TOPHAT_R + 2
        x0 = int(max(0, np.floor(polygon[:, 0].min()) - pad))
        y0 = int(max(0, np.floor(polygon[:, 1].min()) - pad))
        x1 = int(min(w, np.ceil(polygon[:, 0].max()) + pad))
        y1 = int(min(h, np.ceil(polygon[:, 1].max()) + pad))
        if x1 <= x0 or y1 <= y0:
            return np.zeros((0, 2), np.float32)
        img = img[y0:y1, x0:x1]
    white = img.min(axis=2)
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * TOPHAT_R + 1, 2 * TOPHAT_R + 1))
    th = cv2.morphologyEx(white, cv2.MORPH_TOPHAT, k)
    if polygon is not None:
        mask = np.zeros(white.shape, np.uint8)
        cv2.fillPoly(mask, [np.round(polygon - np.array([x0, y0], np.float32)).astype(np.int32)], 255)
        th = cv2.bitwise_and(th, mask)
    _, bw = cv2.threshold(th, TOPHAT_THR, 255, cv2.THRESH_BINARY)
    n, lab, st, cen = cv2.connectedComponentsWithStats(bw, connectivity=8)
    if n <= 1:
        return np.zeros((0, 2), np.float32)
    w, h, a = st[1:, 2], st[1:, 3], st[1:, 4]
    big, small = np.maximum(w, h), np.maximum(1, np.minimum(w, h))
    ok = (a >= BLOB_AREA[0]) & (a <= BLOB_AREA[1]) & (big <= BLOB_MAX_SIDE) & (big <= BLOB_MAX_RATIO * small)
    pts = cen[1:][ok].astype(np.float32)
    if cap is not None and len(pts) > cap:
        # Las más blancas primero, por su punto más blanco (el centro de un balón puede caer en un panel oscuro).
        peak = np.zeros(n, np.float32)
        np.maximum.at(peak, lab.ravel(), th.ravel())
        pts = pts[np.argsort(-peak[1:][ok], kind="stable")[:cap]]
    return (pts + np.array([x0, y0], np.float32)).reshape(-1, 2)


def motion_image(img: np.ndarray, prev: np.ndarray | None, H, H_prev) -> np.ndarray:
    """Diferencia con el cuadro procesado anterior llevado a este por el plano del césped (gris, 0..255)."""
    import cv2

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    if prev is None or H is None or H_prev is None:
        return np.zeros_like(gray)
    M = np.linalg.inv(np.asarray(H, float).reshape(3, 3)) @ np.asarray(H_prev, float).reshape(3, 3)
    warped = cv2.warpPerspective(cv2.cvtColor(prev, cv2.COLOR_BGR2GRAY), M, (gray.shape[1], gray.shape[0]), flags=cv2.INTER_LINEAR)
    diff = cv2.absdiff(cv2.GaussianBlur(gray, (3, 3), 0), cv2.GaussianBlur(warped, (3, 3), 0))
    # La H no es perfecta: un desajuste de un par de píxeles deja el borde de las líneas. El mínimo en un entorno
    # pequeño lo borra y deja lo que de verdad se movió más que eso.
    return cv2.erode(diff, np.ones((3, 3), np.uint8))


def patches(img: np.ndarray, motion: np.ndarray, pts: np.ndarray) -> np.ndarray:
    """Recortes (N, 4, PATCH, PATCH) en float32 0..1: color BGR y movimiento."""
    import cv2

    half = PATCH // 2
    if len(pts) == 0:
        return np.zeros((0, 4, PATCH, PATCH), np.float32)
    pad_img = cv2.copyMakeBorder(img, half, half, half, half, cv2.BORDER_REFLECT)
    pad_mot = cv2.copyMakeBorder(motion, half, half, half, half, cv2.BORDER_CONSTANT, value=0)
    # Todos los recortes de una vez: índices (N, PATCH, PATCH) de filas y columnas.
    cx = np.round(pts[:, 0]).astype(int)
    cy = np.round(pts[:, 1]).astype(int)
    off = np.arange(PATCH)
    rows = (cy[:, None] + off[None, :])[:, :, None]
    cols = (cx[:, None] + off[None, :])[:, None, :]
    rows = np.clip(rows, 0, pad_img.shape[0] - 1)
    cols = np.clip(cols, 0, pad_img.shape[1] - 1)
    color = pad_img[rows, cols]  # (N, PATCH, PATCH, 3)
    mot = pad_mot[rows, cols]  # (N, PATCH, PATCH)
    out = np.empty((len(pts), 4, PATCH, PATCH), np.float32)
    out[:, :3] = color.transpose(0, 3, 1, 2) / 255.0
    out[:, 3] = mot / 255.0
    return out


# ------------------------------------------------------------------------------------------------ el modelo

def _net():
    import torch.nn as nn

    return nn.Sequential(
        nn.Conv2d(4, 16, 3, padding=1), nn.ReLU(), nn.MaxPool2d(2),
        nn.Conv2d(16, 32, 3, padding=1), nn.ReLU(), nn.MaxPool2d(2),
        nn.Conv2d(32, 64, 3, padding=1), nn.ReLU(), nn.MaxPool2d(2),
        nn.Flatten(), nn.Linear(64 * (PATCH // 8) ** 2, 64), nn.ReLU(), nn.Dropout(0.2), nn.Linear(64, 1),
    )


class BallModel:
    def __init__(self, path: Path):
        import torch

        state = torch.load(path, map_location="cpu", weights_only=False)
        self.meta = state["meta"]
        self.net = _net()
        self.net.load_state_dict(state["weights"])
        self.net.eval()
        torch.set_num_threads(max(1, (torch.get_num_threads() or 2)))

    def predict(self, x: np.ndarray) -> np.ndarray:
        import torch

        if len(x) == 0:
            return np.zeros(0, np.float32)
        with torch.no_grad():
            return torch.sigmoid(self.net(torch.from_numpy(x))).numpy().ravel()


# ------------------------------------------------------------------------------------------------- partes

def match_dir(match: str) -> Path:
    return project_root() / "matches" / match


PART_RE = re.compile(r"^tracks_(v\d+)_(\d+)_(\d+)\.json$")


def parts_of(folder: Path, video: str | None = None) -> list[Path]:
    out = []
    for p in sorted((folder / "tracking").glob("tracks_v*_*_*.json")):
        m = PART_RE.match(p.name)
        if m and (video is None or m.group(1) == video):
            out.append(p)
    return sorted(out, key=lambda p: (PART_RE.match(p.name).group(1), int(PART_RE.match(p.name).group(2))))


def venue_of(folder: Path, tracks: dict) -> dict | None:
    v = tracks.get("venue") or {}
    if v.get("length_m") and v.get("width_m"):
        return {"length_m": float(v["length_m"]), "width_m": float(v["width_m"])}
    import yaml

    m = (yaml.safe_load((folder / "match.yaml").read_text(encoding="utf-8")) or {}).get("venue") or {}
    if m.get("pitch_length_m") and m.get("pitch_width_m"):
        return {"length_m": float(m["pitch_length_m"]), "width_m": float(m["pitch_width_m"])}
    return None


def video_of(folder: Path, video_id: str) -> Path:
    for ext in (".mp4", ".mkv", ".webm", ".mov"):
        p = folder / "video" / f"{video_id}{ext}"
        if p.exists():
            return p
    raise SystemExit(f"No está el video {video_id} en {folder / 'video'}")


def hand_marks(folder: Path, part: Path) -> dict[int, tuple[float, float]]:
    """Marcas de balón a mano de una parte (de su tracks_fixed), en píxeles del cuadro."""
    fixed = part.with_name(part.name.replace("tracks_", "tracks_fixed_", 1))
    if not fixed.exists():
        return {}
    fx = json.loads(fixed.read_text(encoding="utf-8"))
    tr = json.loads(part.read_text(encoding="utf-8"))
    venue = fx.get("venue") or venue_of(folder, tr)
    Hs = {f["frame"]: f.get("H") for f in tr["frames"]}
    out = {}
    for b in fx.get("ball", []):
        if b.get("source") != "manual" or Hs.get(b["frame"]) is None or not venue:
            continue
        q = to_pixel(Hs[b["frame"]], venue, b["x"], b["y"])
        if q is not None:
            out[b["frame"]] = q
    return out


class FrameWalker:
    """Recorre los cuadros procesados de una parte en orden, con el anterior para el movimiento."""

    def __init__(self, video: Path):
        import cv2

        self.cv2 = cv2
        self.cap = cv2.VideoCapture(str(video))
        self.pos = 0

    def read(self, frame: int) -> np.ndarray | None:
        if frame < self.pos or frame - self.pos > 120:
            self.cap.set(self.cv2.CAP_PROP_POS_FRAMES, frame)
            self.pos = frame
        while self.pos < frame:
            self.cap.grab()
            self.pos += 1
        ok, img = self.cap.read()
        self.pos += 1
        return img if ok else None


def feet_regions(boxes: list, k: float = 1.0) -> np.ndarray:
    """Zona de los pies de cada caja (x0, y0, x1, y1): el tercio de abajo, un poco más ancha y algo por debajo."""
    out = []
    for b in boxes or []:
        x1, y1, x2, y2 = b[1], b[2], b[3], b[4]
        w, h = x2 - x1, y2 - y1
        out.append((x1 - 0.35 * w - 4 * k, y2 - 0.3 * h, x2 + 0.35 * w + 4 * k, y2 + 0.12 * h + 6 * k))
    return np.array(out, np.float32).reshape(-1, 4)


def at_feet(pts: np.ndarray, regions: np.ndarray) -> np.ndarray:
    """Qué puntos caen en la zona de los pies de alguna caja."""
    if len(pts) == 0 or len(regions) == 0:
        return np.zeros(len(pts), bool)
    x, y = pts[:, 0:1], pts[:, 1:2]
    r = regions[None]
    return ((x >= r[..., 0]) & (x <= r[..., 2]) & (y >= r[..., 1]) & (y <= r[..., 3])).any(axis=1)


def frame_features(walker: FrameWalker, frames: list[dict], venue: dict, only: set[int] | None = None, search: str = "pitch", k: float = 1.0,
                   cap: int | None = MAX_CANDIDATES):
    """Por cuadro procesado (o solo los de `only`): candidatos y recortes. Genera (frame, pts, patches).

    search: "pitch" busca en toda la cancha; "feet" solo en la zona de los pies de las cajas detectadas.
    """
    need = None
    if only is not None:
        order = [fr["frame"] for fr in frames]
        prev_of = {b: a for a, b in zip(order[:-1], order[1:])}
        need = set(only) | {prev_of[f] for f in only if f in prev_of}
    prev = prev_H = None
    last = None
    for fr in frames:
        f = fr["frame"]
        if need is not None and f not in need:
            continue
        img = walker.read(f)
        if img is None:
            break
        H = fr.get("H")
        if only is None or f in only:
            pts = candidates(img, pitch_polygon(H, venue), cap)
            if search == "feet":
                pts = pts[at_feet(pts, feet_regions(fr.get("boxes"), k))]
            # El movimiento solo con el cuadro procesado justo anterior.
            ok_prev = last is not None and frames_gap(frames, last, f)
            mot = motion_image(img, prev if ok_prev else None, H, prev_H)
            yield f, pts, patches(img, mot, pts)
        prev, prev_H, last = img, H, f


def frames_gap(frames: list[dict], a: int, b: int) -> bool:
    """b es el cuadro procesado siguiente a `a`."""
    if len(frames) < 2:
        return False
    stride = frames[1]["frame"] - frames[0]["frame"]
    return 0 < b - a <= stride


# --------------------------------------------------------------------------------------------- entrenamiento

def collect(folders: list[Path], max_frames_per_part: int = 400, seed: int = 0, exclude: set[str] = frozenset(), positives: str = "all", search: str = "pitch"):
    """Recortes positivos (el candidato sobre una marca a mano) y negativos (lejos) de las partes revisadas.

    positives: "all" usa todas las marcas; "feet" solo las que caen a los pies de una caja (balón en el suelo, donde la
    proyección a la cancha es correcta).
    """
    rng = random.Random(seed)
    X, y, groups = [], [], []
    used = skipped = 0
    for folder in folders:
        for part in parts_of(folder):
            if part.name in exclude:
                continue
            marks = hand_marks(folder, part)
            if not marks:
                continue
            tr = json.loads(part.read_text(encoding="utf-8"))
            venue = venue_of(folder, tr)
            if not venue:
                continue
            frames = tr["frames"]
            k = tr["image_h"] / 1080
            if positives == "feet":
                boxes = {fr["frame"]: fr.get("boxes") for fr in frames}
                marks = {f: q for f, q in marks.items() if at_feet(np.array([q], np.float32), feet_regions(boxes.get(f), k))[0]}
            chosen = sorted(marks)
            if len(chosen) > max_frames_per_part:
                chosen = sorted(rng.sample(chosen, max_frames_per_part))
            walker = FrameWalker(video_of(folder, tr["video_id"]))
            for f, pts, P in frame_features(walker, frames, venue, set(chosen), search, k, cap=None):
                mx, my = marks[f]
                if len(pts) == 0:
                    skipped += 1
                    continue
                d = np.hypot(pts[:, 0] - mx, pts[:, 1] - my)
                i = int(np.argmin(d))
                if d[i] > POS_R_PX:
                    skipped += 1
                    continue
                used += 1
                X.append(P[i:i + 1])
                y.append(1)
                neg = np.where(d > NEG_R_PX)[0]
                if len(neg) > NEG_PER_FRAME:
                    neg = np.array(rng.sample(list(neg), NEG_PER_FRAME))
                if len(neg):
                    X.append(P[neg])
                    y += [0] * len(neg)
                groups.append(part.name)
            print(f"  {folder.name}/{part.name}: marcas {len(marks)}")
    if not X:
        raise SystemExit("No hay marcas de balón a mano utilizables: revisa a mano el balón de un tramo y guarda la parte (tracks_fixed).")
    return np.concatenate(X), np.array(y, np.float32), {"used_marks": used, "skipped_marks": skipped}


def fit(X: np.ndarray, y: np.ndarray, epochs: int = 12, seed: int = 0):
    import torch
    import torch.nn as nn

    torch.manual_seed(seed)
    net = _net()
    opt = torch.optim.Adam(net.parameters(), lr=2e-3, weight_decay=1e-4)
    pos = np.where(y == 1)[0]
    neg = np.where(y == 0)[0]
    loss_fn = nn.BCEWithLogitsLoss()
    rng = np.random.default_rng(seed)
    for ep in range(epochs):
        # Cada época: todos los positivos (con giros) y tantos negativos como 8 veces los positivos.
        idx = np.concatenate([np.repeat(pos, 4), rng.choice(neg, size=min(len(neg), 8 * len(pos) * 4), replace=False)])
        rng.shuffle(idx)
        net.train()
        total = 0.0
        for s in range(0, len(idx), 256):
            b = idx[s:s + 256]
            xb = torch.from_numpy(X[b].copy())
            if rng.random() < 0.5:
                xb = torch.flip(xb, dims=[3])
            if rng.random() < 0.5:
                xb = torch.flip(xb, dims=[2])
            xb[:, :3] *= float(rng.uniform(0.85, 1.15))
            yb = torch.from_numpy(y[b]).unsqueeze(1)
            opt.zero_grad()
            loss = loss_fn(net(xb), yb)
            loss.backward()
            opt.step()
            total += float(loss) * len(b)
        print(f"  época {ep + 1}/{epochs}: pérdida {total / len(idx):.4f}")
    net.eval()
    return net


def train(matches: list[str], out: Path | None = None, exclude: set[str] = frozenset(), positives: str = "all", search: str = "pitch") -> Path:
    import torch

    folders = [match_dir(m) for m in matches]
    t0 = time.time()
    print("Recortes de las partes revisadas…")
    X, y, info = collect(folders, exclude=exclude, positives=positives, search=search)
    print(f"  {int(y.sum())} positivos (marcas sobre un candidato), {int((1 - y).sum())} negativos; "
          f"{info['skipped_marks']} marcas sin candidato cerca quedaron fuera")
    net = fit(X, y)
    out = out or project_root() / "weights" / MODEL_NAME
    out.parent.mkdir(parents=True, exist_ok=True)
    meta = {"matches": matches, "positives": int(y.sum()), "negatives": int((1 - y).sum()), "excluded": sorted(exclude),
            "trained": time.strftime("%Y-%m-%d %H:%M"), "patch": PATCH, "positives_from": positives, "search": search, **info}
    torch.save({"weights": net.state_dict(), "meta": meta}, out)
    print(f"Modelo en {out} ({time.time() - t0:.0f} s)")
    return out


# --------------------------------------------------------------------------------------------------- decidir

def decide(per_frame: list[tuple[int, np.ndarray, np.ndarray]], k: float = 1.0) -> list[dict]:
    """Balón seguro por cuadro: el mejor candidato con p >= ACCEPT_P y apoyado por SUPPORT_MIN cuadros vecinos.

    per_frame: (frame, pts (N, 2), p (N,)) en orden. Un vecino apoya si tiene un candidato con p >= SUPPORT_P a una
    distancia que el balón puede recorrer en ese tiempo (MAX_STEP_PX por cuadro procesado, escalado por k = alto/1080).
    """
    out = []
    for i, (f, pts, p) in enumerate(per_frame):
        if len(p) == 0:
            continue
        j = int(np.argmax(p))
        if p[j] < ACCEPT_P:
            continue
        support = 0
        for di in list(range(-SUPPORT_SPAN, 0)) + list(range(1, SUPPORT_SPAN + 1)):
            n = i + di
            if n < 0 or n >= len(per_frame):
                continue
            _, q, pq = per_frame[n]
            ok = pq >= SUPPORT_P
            if not ok.any():
                continue
            d = np.hypot(q[ok, 0] - pts[j, 0], q[ok, 1] - pts[j, 1])
            if (d <= MAX_STEP_PX * k * abs(di)).any():
                support += 1
        if support >= SUPPORT_MIN:
            out.append({"frame": int(f), "px": round(float(pts[j, 0]), 1), "py": round(float(pts[j, 1]), 1), "p": round(float(p[j]), 3)})
    return out


def ask_frames(found: list[int], frames: list[int], fps: float, segments: list[tuple[int, int]] | None = None) -> list[int]:
    """Dónde hace falta una marca a mano: cuadros de juego sin balón seguro a menos de medio paso (ASK_EVERY_S / 2),
    como mucho uno cada ASK_EVERY_S. Así un hueco corto entre dos detecciones no pide nada.

    `segments`: tramos de juego en cuadros [inicio, fin); fuera de ellos no se pide nada. Sin ellos, toda la parte.
    """
    have = np.array(sorted(found), dtype=np.int64)
    step = max(1, round(ASK_EVERY_S * fps))
    half = step / 2
    out: list[int] = []
    for f in frames:
        if segments is not None and not any(a <= f < b for a, b in segments):
            continue
        if len(have):
            i = int(np.searchsorted(have, f))
            near = min(abs(have[j] - f) for j in (i - 1, i) if 0 <= j < len(have))
            if near <= half:
                continue
        if not out or f - out[-1] >= step:
            out.append(f)
    return out


def play_segments(folder: Path, video: str, fps: float) -> list[tuple[int, int]] | None:
    csv = folder / "segments.csv"
    if not csv.exists():
        return None
    from ..timebase import load_segments, parse_hms

    seg = load_segments(csv, video)
    rows = seg[seg["tipo"] == "juego"]
    if rows.empty:
        return None
    return [(round(parse_hms(r.start) * fps), round(parse_hms(r.end) * fps)) for r in rows.itertuples()]


def run_part(part: Path, model: BallModel, folder: Path) -> dict:
    tr = json.loads(part.read_text(encoding="utf-8"))
    venue = venue_of(folder, tr)
    if venue is None:
        raise SystemExit(f"{part.name}: falta la medida de la sede (venue en match.yaml)")
    walker = FrameWalker(video_of(folder, tr["video_id"]))
    k = tr["image_h"] / 1080
    per = []
    t0 = time.time()
    search = model.meta.get("search", "pitch")
    for f, pts, P in frame_features(walker, tr["frames"], venue, search=search, k=k):
        per.append((f, pts, model.predict(P)))
    found = decide(per, k)
    frames = [f for f, _, _ in per]
    asks = ask_frames([b["frame"] for b in found], frames, tr["fps"], play_segments(folder, tr["video_id"], tr["fps"]))
    return {
        "schema_version": 1,
        "kind": "ball_auto",
        "match_id": tr["match_id"],
        "video_id": tr["video_id"],
        "fps": tr["fps"],
        "stride": tr["stride"],
        "start_frame": tr["start_frame"],
        "end_frame": tr["end_frame"],
        "image_w": tr["image_w"],
        "image_h": tr["image_h"],
        "model": model.meta,
        "rules": {"accept_p": ACCEPT_P, "support_p": SUPPORT_P, "support_min": SUPPORT_MIN, "max_step_px": MAX_STEP_PX, "ask_every_s": ASK_EVERY_S},
        "frames": found,
        "ask": asks,
        "quality": {"processed": len(frames), "found": len(found), "found_share": round(len(found) / max(1, len(frames)), 3),
                    "seconds": round(time.time() - t0, 1)},
    }


def out_name(part: Path) -> str:
    return part.name.replace("tracks_", "ball_auto_", 1)


def run(match: str, video: str | None = None, part_name: str | None = None, force: bool = False, model_path: Path | None = None,
        accept: float | None = None, support: int | None = None) -> list[Path]:
    global ACCEPT_P, SUPPORT_MIN
    if accept is not None:
        ACCEPT_P = accept
    if support is not None:
        SUPPORT_MIN = support
    folder = match_dir(match)
    model_path = model_path or project_root() / "weights" / MODEL_NAME
    if not model_path.exists():
        raise SystemExit(f"No hay modelo en {model_path}: primero `python -m sportsan.tracking.ball train`.")
    model = BallModel(model_path)
    parts = [folder / "tracking" / part_name] if part_name else parts_of(folder, video)
    done = []
    for p in parts:
        out = p.with_name(out_name(p))
        if out.exists() and not force:
            print(f"ya existe, salto: {out.name}")
            continue
        r = run_part(p, model, folder)
        out.write_text(json.dumps(r), encoding="utf-8")
        q = r["quality"]
        print(f"listo: {out.name}: balón seguro en {q['found']} de {q['processed']} cuadros ({q['found_share']:.0%}), "
              f"{len(r['ask'])} marcas pedidas, {q['seconds']} s")
        done.append(out)
    return done


def evaluate(match: str, part_name: str, model_path: Path | None = None, radius: float = 15.0) -> dict:
    """Compara lo que marca el tracker con las marcas a mano de la parte (que no deben haberse usado al entrenar)."""
    folder = match_dir(match)
    part = folder / "tracking" / part_name
    model = BallModel(model_path or project_root() / "weights" / MODEL_NAME)
    if part_name not in (model.meta.get("excluded") or []):
        print(f"aviso: {part_name} se usó para entrenar este modelo; la comparación sale optimista")
    r = run_part(part, model, folder)
    marks = hand_marks(folder, part)
    found = {b["frame"]: (b["px"], b["py"]) for b in r["frames"]}
    both = [f for f in marks if f in found]
    near = [f for f in both if math.hypot(found[f][0] - marks[f][0], found[f][1] - marks[f][1]) <= radius]
    res = {"marks": len(marks), "found": len(found), "processed": r["quality"]["processed"], "found_on_marked": len(both),
           "agree": len(near), "agree_share": round(len(near) / max(1, len(both)), 3), "seconds": r["quality"]["seconds"]}
    print(json.dumps(res, indent=1))
    return res


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="Tracker de balón: entrena con las marcas a mano y marca solo lo seguro.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("train", help="entrena con las marcas a mano de los partidos dados (por defecto, todos)")
    t.add_argument("--match", action="append", default=None)
    t.add_argument("--exclude", action="append", default=[], help="parte que no se usa (para evaluarla después)")
    t.add_argument("--out", default=None)
    t.add_argument("--positives", choices=["all", "feet"], default="all", help="feet: solo marcas a los pies de una jugadora")
    t.add_argument("--search", choices=["pitch", "feet"], default="pitch", help="feet: buscar solo cerca de los pies")
    r = sub.add_parser("run", help="marca el balón de las partes de un partido")
    r.add_argument("--match", required=True)
    r.add_argument("--video", default=None)
    r.add_argument("--part", default=None, help="tracks_<video>_<ini>_<fin>.json")
    r.add_argument("--model", default=None)
    r.add_argument("--force", action="store_true")
    r.add_argument("--accept", type=float, default=None, help=f"probabilidad para aceptar (por defecto {ACCEPT_P}); más alta, menos balones y más seguros")
    r.add_argument("--support", type=int, default=None, help=f"cuadros vecinos que deben apoyar (por defecto {SUPPORT_MIN})")
    e = sub.add_parser("eval", help="compara con las marcas a mano de una parte")
    e.add_argument("--match", required=True)
    e.add_argument("--part", required=True)
    e.add_argument("--model", default=None)
    a = ap.parse_args(argv)
    if a.cmd == "train":
        train(a.match or list_matches(), Path(a.out) if a.out else None, set(a.exclude), a.positives, a.search)
    elif a.cmd == "run":
        run(a.match, a.video, a.part, a.force, Path(a.model) if a.model else None, a.accept, a.support)
    else:
        evaluate(a.match, a.part, Path(a.model) if a.model else None)


if __name__ == "__main__":
    main()

"""Dibujos de un clip: la misma lógica que la app (`web/lib/annotations.ts` y `web/lib/clips.ts`), en Python puro.

Un dibujo se guarda en metros de la cancha normalizada (105 x 68) o pegado a una identidad del tracking, nunca en
píxeles; aquí se resuelve en un instante y se proyecta sobre el cuadro con su H. Si algo no se puede colocar, el
dibujo se oculta: nunca se inventa una posición. Los tests comparan la proyección con la de la app en
`tests/fixtures/projection_cases.json`.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Callable

import numpy as np

Pt = tuple[float, float]
ToImage = Callable[[Pt], "Pt | None"]

# Una jugadora que no se vio menos de esto se coloca en la recta entre donde se perdió y donde reaparece.
MAX_HOLE_S = 1.0
# Tamaños para un cuadro de 1080 px de alto (se escalan con la altura) y sobre el césped, en metros normalizados.
DRAW_PX = {"stroke": 5, "text": 40, "label": 30, "outline": 6}
DRAW_M = {"ring": 1.2, "head": 2.0}
ARITY = {"highlight": (1, 1), "arrow": (2, math.inf), "line": (2, math.inf), "zone": (3, math.inf), "text": (1, 1)}


# ------------------------------------------------------------------------------------------------- anclas

def is_valid(a: dict) -> bool:
    lo, hi = ARITY.get(a.get("kind"), (math.inf, 0))
    anchors = a.get("anchors") or []
    if not (lo <= len(anchors) <= hi) or not (a["t_out"] > a["t_in"]):
        return False
    if a["kind"] == "highlight" and anchors[0]["kind"] != "player":
        return False
    return a["kind"] == "text" or all(x["kind"] != "screen" for x in anchors)


def visible_at(a: dict, t: float) -> bool:
    return a["t_in"] <= t < a["t_out"]


@dataclass
class Resolved:
    id: str
    kind: str
    style: dict
    space: str  # "pitch" o "screen"
    points: list[Pt]
    players: list = field(default_factory=list)


def hull(points: list[Pt]) -> list[Pt]:
    """Contorno convexo (cadena monótona), sin puntos repetidos ni colineales."""
    ps = sorted(points)
    if len(ps) < 3:
        return ps

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower: list[Pt] = []
    for p in ps:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    upper: list[Pt] = []
    for p in reversed(ps):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


def resolve(a: dict, t: float, position_of: Callable[[object, float], "Pt | None"]) -> Resolved | None:
    """Geometría del dibujo en el instante t, o None si está oculto (fuera de t_in..t_out o sin posición)."""
    if not visible_at(a, t):
        return None
    pts: list[tuple[Pt, object]] = []
    for an in a["anchors"]:
        if an["kind"] == "player":
            p = position_of(an["identity"], t)
            if p is None:
                return None
            pts.append(((float(p[0]), float(p[1])), an["identity"]))
        else:
            pts.append(((float(an["x"]), float(an["y"])), None))
    if a["kind"] == "line" and all(w is not None for _, w in pts):
        pts.sort(key=lambda q: (q[0][1], q[0][0]))
    if a["kind"] == "zone" and any(w is not None for _, w in pts):
        h = hull([p for p, _ in pts])
        pts = [next(q for q in pts if q[0] == p) for p in h]
    space = "screen" if any(x["kind"] == "screen" for x in a["anchors"]) else "pitch"
    return Resolved(a["id"], a["kind"], a.get("style") or {}, space, [p for p, _ in pts], [w for _, w in pts])


def sample_curve(points: list[Pt], per_stretch: int = 12) -> list[Pt]:
    """La misma curva que dibuja la app (Catmull-Rom como Bézier cúbicas); recta con dos puntos."""
    if len(points) <= 2:
        return [tuple(p) for p in points]
    out = [tuple(points[0])]
    n = len(points)
    for i in range(n - 1):
        p0, p1, p2, p3 = points[max(0, i - 1)], points[i], points[i + 1], points[min(n - 1, i + 2)]
        c1 = (p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6)
        c2 = (p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6)
        for k in range(1, per_stretch + 1):
            u = k / per_stretch
            a, b, c, d = (1 - u) ** 3, 3 * (1 - u) ** 2 * u, 3 * (1 - u) * u ** 2, u ** 3
            out.append((a * p1[0] + b * c1[0] + c * c2[0] + d * p2[0], a * p1[1] + b * c1[1] + c * c2[1] + d * p2[1]))
    return out


def arrow_head(points: list[Pt], size: float) -> list[Pt] | None:
    if len(points) < 2:
        return None
    tip, frm = points[-1], points[-2]
    dx, dy = tip[0] - frm[0], tip[1] - frm[1]
    length = math.hypot(dx, dy)
    if length == 0:
        return None
    ux, uy = dx / length, dy / length
    back = (tip[0] - ux * size, tip[1] - uy * size)
    w = size * 0.55
    return [tip, (back[0] - uy * w, back[1] + ux * w), (back[0] + uy * w, back[1] - ux * w)]


def label_point(kind: str, ps: list[Pt]) -> Pt:
    if kind == "zone":
        return (sum(p[0] for p in ps) / len(ps), sum(p[1] for p in ps) / len(ps))
    if kind in ("arrow", "line"):
        i = (len(ps) - 1) // 2
        a, b = ps[i], ps[min(len(ps) - 1, i + 1)]
        return ps[i] if len(ps) % 2 == 1 and len(ps) > 2 else ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
    return ps[0]


# --------------------------------------------------------------------------------------------- proyección

def pitch_to_image(H, venue: dict) -> ToImage | None:
    """Cancha normalizada -> píxeles, con H de imagen a metros reales. None sin H."""
    if H is None:
        return None
    M = np.asarray(H, dtype=float).reshape(3, 3)
    # El mismo umbral que `invert` de la app: una matriz casi singular no es una calibración.
    if abs(np.linalg.det(M)) < 1e-14:
        return None
    inv = np.linalg.inv(M)
    L, W = float(venue["length_m"]), float(venue["width_m"])
    if inv[2] @ np.array([L / 2, W / 2, 1.0]) < 0:
        inv = -inv
    sx, sy = L / 105.0, W / 68.0

    def to(p: Pt) -> Pt | None:
        X, Y = p[0] * sx, p[1] * sy
        w = inv[2, 0] * X + inv[2, 1] * Y + inv[2, 2]
        if not w > 1e-9:
            return None
        return ((inv[0, 0] * X + inv[0, 1] * Y + inv[0, 2]) / w, (inv[1, 0] * X + inv[1, 1] * Y + inv[1, 2]) / w)

    return to


@dataclass
class Projected:
    id: str
    kind: str
    style: dict
    paths: list[list[Pt]]
    closed: bool
    head: list[Pt] | None
    text: tuple[Pt, str] | None


def project(r: Resolved, to_image: ToImage | None, image: tuple[int, int], label_of=None, ring_m: float | None = None) -> Projected | None:
    """El dibujo sobre el cuadro (píxeles). image = (ancho, alto). Igual que `project` de la app."""
    w, h = image
    k = h / 1080
    style = r.style
    if r.space == "screen":
        return Projected(r.id, r.kind, style, [], False, None, ((r.points[0][0] * w, r.points[0][1] * h), style.get("label") or "Texto"))
    if to_image is None:
        return None

    def proj(ps):
        out = []
        for p in ps:
            q = to_image(p)
            if q is None:
                return None
            out.append(q)
        return out

    def label_at(p, who):
        value = " · ".join(v for v in (who, style.get("label")) if v)
        return (p, value) if value and p is not None else None

    def above(p):
        return (p[0], p[1] - 12 * k) if p is not None else None

    if r.kind == "text":
        at = to_image(r.points[0])
        return Projected(r.id, r.kind, style, [], False, None, (at, style.get("label") or "Texto")) if at else None
    if r.kind == "highlight":
        cx, cy = r.points[0]
        rad = DRAW_M["ring"] if ring_m is None else ring_m
        ring = proj([(cx + rad * math.cos(i / 32 * 2 * math.pi), cy + rad * math.sin(i / 32 * 2 * math.pi)) for i in range(32)])
        if ring is None:
            return None
        top = min(ring, key=lambda p: p[1])
        who = label_of(r.players[0]) if label_of and r.players and r.players[0] is not None else None
        return Projected(r.id, r.kind, style, [ring], True, None, label_at(above(top), who))
    if r.kind == "arrow":
        curve = sample_curve(r.points)
        head = arrow_head(curve, DRAW_M["head"])
        if head is None:
            return None
        body = curve[:-1] + [((head[1][0] + head[2][0]) / 2, (head[1][1] + head[2][1]) / 2)]
        pb, ph = proj(body), proj(head)
        if pb is None or ph is None:
            return None
        return Projected(r.id, r.kind, style, [pb], False, ph, label_at(above(to_image(label_point(r.kind, r.points))), None))
    pts = proj(r.points)
    if pts is None:
        return None
    return Projected(r.id, r.kind, style, [pts], r.kind == "zone", None, label_at(above(to_image(label_point(r.kind, r.points))), None))


# ------------------------------------------------------------------------------------------- línea de tiempo

def clip_freezes(edit: dict) -> list[dict]:
    out: list[dict] = []
    for f in sorted(edit.get("freezes") or [], key=lambda f: f["t"]):
        if edit["t_start"] <= f["t"] <= edit["t_end"] and f["duration_s"] > 0 and not any(abs(g["t"] - f["t"]) < 1e-6 for g in out):
            out.append(f)
    return out


def reveal_count(f: dict, elapsed: float) -> int:
    n = len(f.get("reveal") or [])
    if n == 0:
        return 0
    return max(0, min(n, math.floor(elapsed / (f["duration_s"] / (n + 1)))))


def frame_plan(edit: dict, fps: float) -> list[tuple[int, float, dict | None, float]]:
    """Cuadros del clip de salida, en orden: (cuadro del video, t_video, pausa o None, segundos dentro de la pausa).

    El video va de round(t_start·fps) a round(t_end·fps) sin incluirlo; cada pausa repite el cuadro de su instante
    round(duration_s·fps) veces. Las pausas no cuentan como tiempo de video.
    """
    plan: list[tuple[int, float, dict | None, float]] = []
    cur = round(edit["t_start"] * fps)
    # Tras una pausa el video sigue desde su instante: el primer cuadro puede caer un poco antes (round), y no debe
    # esconder lo que apareció en la pausa (que empieza justo en ella).
    floor_t = edit["t_start"]

    def video(to_t: float):
        nonlocal cur
        end = round(to_t * fps)
        for f in range(cur, end):
            plan.append((f, max(f / fps, floor_t), None, 0.0))
        cur = max(cur, end)

    for fz in clip_freezes(edit):
        video(fz["t"])
        src = round(fz["t"] * fps)
        for i in range(round(fz["duration_s"] * fps)):
            plan.append((src, fz["t"], fz, i / fps))
        floor_t = fz["t"]
    video(edit["t_end"])
    return plan


# ------------------------------------------------------------------------------- datos del tramo (snapshot)

def homography_at(hs: list, frame: float, max_gap: float):
    a = b = None
    for f, H in hs:
        if H is None:
            continue
        if f <= frame and (a is None or f > a[0]):
            a = (f, H)
        if f >= frame and (b is None or f < b[0]):
            b = (f, H)
    if a is not None and a[0] == frame:
        return a[1]
    if a is not None and b is not None and b[0] - a[0] <= max_gap:
        na = np.asarray(a[1], float)
        na = na / (np.linalg.norm(na) or 1)
        nb = np.asarray(b[1], float)
        nb = nb / (np.linalg.norm(nb) or 1)
        if na @ nb < 0:
            nb = -nb
        w = (frame - a[0]) / (b[0] - a[0])
        return list(na * (1 - w) + nb * w)
    near = sorted([x for x in (a, b) if x is not None], key=lambda x: abs(x[0] - frame))
    return near[0][1] if near and abs(near[0][0] - frame) <= max_gap / 2 else None


def h_gap(snap: dict) -> float:
    return max(2 * snap["stride"], round(snap["fps"] / 2))


def snapshot_positions(snap: dict) -> Callable[[object, float], "Pt | None"]:
    """Posición de cada identidad en el instante t, con la regla de 1 s; lo `interpolated` no cuenta."""
    fps, step = snap["fps"], snap["stride"] / snap["fps"]
    seen = {
        str(i): sorted(((r[0], r[1], r[2]) for r in rows if r[3] != "interpolated"), key=lambda r: r[0])
        for i, rows in (snap.get("tracks") or {}).items()
    }

    def position_of(identity, t: float):
        rows = seen.get(str(identity))
        if not rows:
            return None
        f = t * fps
        i = 0
        while i < len(rows) and rows[i][0] <= f:
            i += 1
        a = rows[i - 1] if i > 0 else None
        b = rows[i] if i < len(rows) else None
        if a is not None and a[0] == f:
            return (a[1], a[2])
        if a is not None and b is not None:
            if (b[0] - a[0]) / fps - step >= MAX_HOLE_S:
                return None
            w = (f - a[0]) / (b[0] - a[0])
            return (a[1] + (b[1] - a[1]) * w, a[2] + (b[2] - a[2]) * w)
        end = a or b
        return (end[1], end[2]) if abs(end[0] - f) / fps <= step else None

    return position_of


def label_for(identity, mode: str, snap: dict | None) -> str | None:
    """Rótulo de una jugadora: dorsal (number), nombre o dorsal si no tiene (name), nada (none)."""
    if mode == "none" or not snap:
        return None
    p = next((x for x in snap.get("people") or [] if str(x["id"]) == str(identity)), None)
    if p is None:
        return None
    number = str(p["number"]) if p.get("number") is not None else None
    if mode == "name":
        return p["player_id"] if p.get("player_id") is not None else number
    return number


def drawings_at(edit: dict, t_video: float, position_of, stop: dict | None, shown: int) -> list[Resolved]:
    """Dibujos visibles en ese instante, sin los de la pausa actual que aún no aparecen."""
    hidden = set((stop.get("reveal") or [])[shown:]) if stop else set()
    out = []
    for a in edit.get("annotations") or []:
        if a["id"] in hidden or not is_valid(a):
            continue
        r = resolve(a, t_video, position_of)
        if r is not None:
            out.append(r)
    return out

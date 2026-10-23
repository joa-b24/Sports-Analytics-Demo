"""Fase 1 de la unión de tracks con mínima intervención (docs/propuesta_union_tracks.md).

Tres pasos sobre las cajas de una parte (`tracks_*.json`), sin leer archivos:

1. **Trozos puros** (`pure_tracklets`): cada track del seguidor se corta donde podría cambiar de persona (cruce con otra
   caja, salto de tamaño, velocidad imposible, cambio sostenido de color). Las cajas sueltas (ids >= 1 000 000) son trozos
   de una caja. Mejor diez trozos de una jugadora que uno de dos.
2. **Candidatos de unión** (`link_candidates`): el final de un trozo con el inicio de otro del mismo equipo hasta
   `MAX_LINK_S` después, con las variables que describen el paso (hueco, distancia a la posición predicha, tamaño,
   color, cruces, competidores).
3. **Unión con abstención** (`accept_greedy`): árboles de gradiente en numpy (`TreeModel`, entrenados con lo que la
   persona ya corrigió) dan la probabilidad de cada candidato y se une uno a uno, del más probable al menos, solo por
   encima de `P_ACCEPT`. Antes, otro modelo aparta los trozos que no son de jugadora (`player_features`). Lo demás queda
   como hueco: manda la certeza, no cerrar todo.

La verdad para entrenar y medir sale de `labels_*.json`: cada caja con la persona final que le dio la mesa de corrección.
Solo cuentan las personas con nombre (revisadas); las demás cajas son desconocidas y no entran en las cifras.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

# Un track del seguidor por encima de este id es una caja suelta (process le da uno propio a cada caja que el seguidor
# no siguió).
LOOSE_ID = 1_000_000

# Reglas de corte (R1-R4 de la propuesta).
CROSS_IOU = 0.2          # otra caja que se solapa más que esto
CROSS_M = 1.2            # u otra posición más cerca que esto (m)
SIZE_JUMP = 0.35         # cambio relativo de la altura de la caja entre cuadros procesados
MAX_SPEED_MS = 9.0       # m/s
SPEED_SLACK_M = 1.0      # holgura por ruido de calibración (m)
COLOR_WINDOW = 10        # cuadros procesados a cada lado para comparar el color
COLOR_JUMP = 28.0        # diferencia de medianas Lab (luminosidad a la mitad)

# Unión local.
MAX_LINK_S = 2.0
LINK_MAX_SPEED_MS = 9.0
LINK_SLACK_M = 2.5
P_ACCEPT = 0.99          # probabilidad mínima para unir

# Límites físicos del equipo (los mismos que web/lib/jumpReview.ts; docs/propuesta_union_tracks.md, 8c y 8d): velocidad
# máxima S0 y perfil aceleración-velocidad lineal, a_max(v) = A0 * (1 - v / S0); frenada hasta MAX_DECEL_MS2, más una
# holgura por el ruido que queda de la calibración.
TEAM_S0_MS = 8.5
TEAM_A0_MS2 = 7.0
MAX_DECEL_MS2 = 8.0
ACCEL_SLACK_MS2 = 1.0
# Ruido de posición que no exige aceleración (m): una caja que tiembla no es un arranque.
ACCEL_NOISE_M = 1.0


@dataclass
class Box:
    frame: int
    track: int
    x1: float
    y1: float
    x2: float
    y2: float
    lab: tuple[float, float, float]
    xm: float               # posición en metros reales
    ym: float
    team: str
    on_pitch: bool

    @property
    def h(self) -> float:
        return self.y2 - self.y1


def boxes_from_part(raw: dict, feet: dict[tuple[int, int], tuple[float, float]] | None = None) -> list[list[Box]]:
    """Cajas por cuadro procesado de un `tracks_*.json`, con la posición en metros de la sede. `feet`: (cuadro, track) ->
    posición en metros con los pies corregidos (feet.corrected_meters), que reemplaza a la del archivo."""
    c = {name: i for i, name in enumerate(raw["box_columns"])}
    venue = raw.get("venue") or {}
    mx = (venue.get("length_m") or 105) / 105
    my = (venue.get("width_m") or 68) / 68
    out = []
    for fr in raw["frames"]:
        row = []
        for b in fr["boxes"]:
            x, y = b[c["x"]], b[c["y"]]
            fixed = feet.get((fr["frame"], int(b[c["track_id"]]))) if feet else None
            row.append(Box(
                frame=fr["frame"], track=int(b[c["track_id"]]),
                x1=b[c["x1"]], y1=b[c["y1"]], x2=b[c["x2"]], y2=b[c["y2"]],
                lab=(b[c["lab_l"]], b[c["lab_a"]], b[c["lab_b"]]),
                xm=fixed[0] if fixed else (x if x is not None else np.nan) * mx,
                ym=fixed[1] if fixed else (y if y is not None else np.nan) * my,
                team=b[c["team"]] or "unk", on_pitch=bool(b[c["on_pitch"]]),
            ))
        out.append(row)
    return out


def truth_from_labels(labels: dict) -> dict[tuple[int, int], int | str]:
    """(cuadro, track) -> persona con nombre, "no" (quitada o soltada: no es jugadora) o ausente (sin revisar)."""
    named = {p["label"] for p in labels.get("people", []) if p.get("named")}
    out: dict[tuple[int, int], int | str] = {}
    for fr in labels["frames"]:
        for b in fr["boxes"]:
            key = (fr["frame"], int(b["track"]))
            if b["status"] in ("removed", "dropped"):
                out[key] = "no"
            elif b["status"] == "player" and b["label"] in named:
                out[key] = int(b["label"])
    return out


def color_distance(a, b, l_weight: float = 0.5) -> float:
    d = np.asarray(a, dtype=float) - np.asarray(b, dtype=float)
    return float(np.sqrt((l_weight * d[0]) ** 2 + d[1] ** 2 + d[2] ** 2))


def _iou(a: Box, b: Box) -> float:
    ix = max(0.0, min(a.x2, b.x2) - max(a.x1, b.x1))
    iy = max(0.0, min(a.y2, b.y2) - max(a.y1, b.y1))
    inter = ix * iy
    u = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter
    return inter / u if u > 0 else 0.0


def crowded(row: list[Box]) -> set[int]:
    """Tracks de un cuadro que se cruzan con otra caja en la cancha (R1)."""
    on = [b for b in row if b.on_pitch]
    out: set[int] = set()
    for i in range(len(on)):
        for j in range(i + 1, len(on)):
            a, b = on[i], on[j]
            near = np.isfinite(a.xm) and np.isfinite(b.xm) and np.hypot(a.xm - b.xm, a.ym - b.ym) < CROSS_M
            if near or _iou(a, b) > CROSS_IOU:
                out.add(a.track)
                out.add(b.track)
    return out


@dataclass
class Tracklet:
    id: int
    track: int
    boxes: list[Box] = field(default_factory=list)
    # El trozo empieza o termina en un cuadro con cruce (el corte o el final pasó en medio de otras).
    crowded_start: bool = False
    crowded_end: bool = False

    @property
    def start(self) -> int:
        return self.boxes[0].frame

    @property
    def end(self) -> int:
        return self.boxes[-1].frame

    @property
    def team(self) -> str:
        teams = [b.team for b in self.boxes]
        return max(set(teams), key=teams.count)

    @property
    def lab(self) -> np.ndarray:
        return np.median(np.array([b.lab for b in self.boxes], dtype=float), axis=0)


def pure_tracklets(frames: list[list[Box]], fps: float, rules: dict | None = None) -> list[Tracklet]:
    """Corta cada track del seguidor donde podría cambiar de persona. Solo cajas en la cancha.

    `rules` desactiva reglas para medirlas por separado: {"cross": False, "size": False, "speed": False, "color": False}.
    """
    r = {"cross": True, "size": True, "speed": True, "color": True, **(rules or {})}
    by_track: dict[int, list[Box]] = {}
    crowd_at: dict[int, set[int]] = {}
    for row in frames:
        if not row:
            continue
        crowd_at[row[0].frame] = crowded(row) if r["cross"] else set()
        for b in row:
            if b.on_pitch:
                by_track.setdefault(b.track, []).append(b)
    out: list[Tracklet] = []
    for track, boxes in by_track.items():
        boxes.sort(key=lambda b: b.frame)
        cuts = set()
        if track < LOOSE_ID:
            for i in range(1, len(boxes)):
                a, b = boxes[i - 1], boxes[i]
                dt = (b.frame - a.frame) / fps
                # A cut before b: b may be someone else.
                if r["cross"] and (b.track in crowd_at.get(b.frame, ()) and a.track not in crowd_at.get(a.frame, ())):
                    cuts.add(i)
                if r["cross"] and (a.track in crowd_at.get(a.frame, ()) and b.track not in crowd_at.get(b.frame, ())):
                    cuts.add(i)
                if r["size"] and a.h > 0 and abs(b.h - a.h) / a.h > SIZE_JUMP:
                    cuts.add(i)
                if r["speed"] and np.isfinite(a.xm) and np.isfinite(b.xm):
                    if np.hypot(b.xm - a.xm, b.ym - a.ym) > MAX_SPEED_MS * dt + SPEED_SLACK_M:
                        cuts.add(i)
            if r["color"] and len(boxes) > 2 * COLOR_WINDOW:
                labs = np.array([b.lab for b in boxes], dtype=float)
                i = COLOR_WINDOW
                while i < len(boxes) - COLOR_WINDOW:
                    before = np.median(labs[i - COLOR_WINDOW:i], axis=0)
                    after = np.median(labs[i:i + COLOR_WINDOW], axis=0)
                    if color_distance(before, after) > COLOR_JUMP:
                        cuts.add(i)
                        i += COLOR_WINDOW
                    else:
                        i += 1
        start = 0
        for i in sorted(cuts) + [len(boxes)]:
            if i <= start:
                continue
            piece = boxes[start:i]
            t = Tracklet(id=len(out), track=track, boxes=piece)
            t.crowded_start = piece[0].track in crowd_at.get(piece[0].frame, ())
            t.crowded_end = piece[-1].track in crowd_at.get(piece[-1].frame, ())
            out.append(t)
            start = i
    out.sort(key=lambda t: (t.start, t.track))
    for i, t in enumerate(out):
        t.id = i
    return out


def tracklet_truth(t: Tracklet, truth: dict) -> tuple[int | str | None, float]:
    """Persona mayoritaria del trozo entre sus cajas con verdad y la fracción de cajas que son de ella."""
    vals = [truth[(b.frame, b.track)] for b in t.boxes if (b.frame, b.track) in truth]
    if not vals:
        return None, 1.0
    best = max(set(vals), key=vals.count)
    return best, vals.count(best) / len(vals)


# --------------------------------------------------------------------------------------------- candidatos

FEATURES = [
    "gap_s", "dist_pred_m", "dist_last_m", "size_log", "color", "len_a_log", "len_b_log", "loose_a", "loose_b",
    "crowd", "n_succ", "n_pred", "team_unk", "same_track",
    # Competition: is it the nearest for each side, and how far is the next one (a link is safe when it is clearly the
    # only one, not when it is merely close).
    "rank_a", "rank_b", "gap_to_2nd_a", "gap_to_2nd_b", "norm_dist",
    # How far the join exceeds what a player can accelerate or brake (m/s², > 0 = impossible; see accel_excess).
    "accel_excess",
]
# The identity proposed by process is deliberately not a feature: 98.5 % of its joins are right, so a model that sees it
# copies it and never questions the 1.5 % that contaminate whole identities.
# Confianza mínima para unir dos trozos (fase 1). Era 0.99; se bajó a 0.95 (2026-10-21) y el resto se corrige en las fases siguientes.
# Para probar 0.9: cambiar este valor (o pasar p_min=0.9 a accept_greedy) y correr links_eval; informe: union_f1.md, fila «≥ 0.9».
LINK_P_MIN = 0.95
# Candidates kept per tracklet end and per tracklet start (nearest to the prediction).
TOP_K = 6


def _velocity(t: Tracklet, fps: float, at_end: bool) -> np.ndarray:
    return _velocity_at(t, fps, at_end)[0]


def _velocity_at(t: Tracklet, fps: float, at_end: bool) -> tuple[np.ndarray, float, bool]:
    """Velocidad (m/s) al final o al inicio del trozo, a qué distancia en el tiempo (s) del borde está medida (el centro de
    la ventana) y si se pudo medir (3 cajas o más)."""
    bs = [b for b in t.boxes if np.isfinite(b.xm)]
    if len(bs) < 3:
        return np.zeros(2), 0.0, False
    bs = bs[-int(fps // 3 + 1):] if at_end else bs[: int(fps // 3 + 1)]
    tt = np.array([b.frame / fps for b in bs])
    if tt[-1] - tt[0] <= 0:
        return np.zeros(2), 0.0, False
    xy = np.array([[b.xm, b.ym] for b in bs])
    offset = float(tt[-1] - tt.mean()) if at_end else float(tt.mean() - tt[0])
    return np.polyfit(tt - tt[0], xy, 1)[0], offset, True


def accel_excess(dt: float, gap_m: np.ndarray, v_a: np.ndarray, off_a: float, ok_a: bool, v_b: np.ndarray, off_b: float, ok_b: bool) -> float:
    """Cuánto pasa (m/s²) una unión de lo que una jugadora puede acelerar o frenar; <= 0 es posible.

    Dos medidas, la peor manda:
    - de velocidad: pasar de la rapidez del final de a a la del inicio de b en el tiempo entre los centros de sus ventanas;
      al acelerar, el límite es A0 * (1 - v / S0) desde la rapidez de partida; al frenar, MAX_DECEL_MS2;
    - de posición: con la velocidad del final de a, dónde estaría al empezar b; llegar al inicio de b exige una aceleración
      media 2 * (error - ACCEL_NOISE_M) / dt² (como vector, el límite es MAX_DECEL_MS2, el mayor).
    Sin velocidad medida de un lado (trozo de menos de 3 cajas) esa medida no cuenta: no hay de qué partir."""
    out = -np.inf
    if ok_a and ok_b:
        sa, sb = float(np.hypot(*v_a)), float(np.hypot(*v_b))
        span = dt + off_a + off_b
        if span > 0:
            acc = (sb - sa) / span
            limit = TEAM_A0_MS2 * max(0.0, 1 - sa / TEAM_S0_MS) if acc > 0 else MAX_DECEL_MS2
            out = max(out, abs(acc) - limit - ACCEL_SLACK_MS2)
    if ok_a and dt > 0:
        err = float(np.hypot(*(gap_m - v_a * dt)))
        need = 2 * max(0.0, err - ACCEL_NOISE_M) / dt**2
        out = max(out, need - MAX_DECEL_MS2 - ACCEL_SLACK_MS2)
    return float(out) if np.isfinite(out) else 0.0


@dataclass
class Candidate:
    a: int
    b: int
    x: np.ndarray            # variables, en el orden de FEATURES
    p: float = 0.0


def link_candidates(tracklets: list[Tracklet], fps: float, max_gap_s: float = MAX_LINK_S, accel_veto: bool = False) -> list[Candidate]:
    """Pares (final de a, inicio de b) físicamente posibles hasta `max_gap_s` de hueco, del mismo equipo. Con
    `accel_veto`, además se descartan los que exigen un arranque o una frenada imposible (accel_excess > 0)."""
    ends: dict[int, list[Tracklet]] = {}
    for t in tracklets:
        ends.setdefault(t.end, []).append(t)
    starts = sorted(tracklets, key=lambda t: t.start)
    start_frames = np.array([t.start for t in starts])
    vel = {t.id: _velocity(t, fps, True) for t in tracklets}
    v_end = {t.id: _velocity_at(t, fps, True) for t in tracklets}
    v_start = {t.id: _velocity_at(t, fps, False) for t in tracklets}
    raw: list[tuple[Tracklet, Tracklet, float, float, float]] = []
    for a in tracklets:
        ea = a.boxes[-1]
        if not np.isfinite(ea.xm):
            continue
        lo = np.searchsorted(start_frames, a.end + 1)
        hi = np.searchsorted(start_frames, a.end + max_gap_s * fps, side="right")
        for b in starts[lo:hi]:
            sb = b.boxes[0]
            if not np.isfinite(sb.xm):
                continue
            if a.team != b.team and "unk" not in (a.team, b.team):
                continue
            dt = (b.start - a.end) / fps
            last = float(np.hypot(sb.xm - ea.xm, sb.ym - ea.ym))
            if last > LINK_MAX_SPEED_MS * dt + LINK_SLACK_M:
                continue
            pred = np.array([ea.xm, ea.ym]) + vel[a.id] * min(dt, 1.0)
            raw.append((a, b, dt, last, float(np.hypot(sb.xm - pred[0], sb.ym - pred[1]))))
    n_succ: dict[int, int] = {}
    n_pred: dict[int, int] = {}
    for a, b, *_ in raw:
        n_succ[a.id] = n_succ.get(a.id, 0) + 1
        n_pred[b.id] = n_pred.get(b.id, 0) + 1
    # Rank of each candidate among those of its end and of its start, by distance to the prediction, and the margin to
    # the next one (m). Only the TOP_K nearest of each side are kept.
    by_a: dict[int, list[int]] = {}
    by_b: dict[int, list[int]] = {}
    for i, (a, b, *_rest) in enumerate(raw):
        by_a.setdefault(a.id, []).append(i)
        by_b.setdefault(b.id, []).append(i)
    rank_a, rank_b, m_a, m_b = {}, {}, {}, {}
    for groups, rank, margin in ((by_a, rank_a, m_a), (by_b, rank_b, m_b)):
        for idx in groups.values():
            idx.sort(key=lambda i: raw[i][4])
            for r, i in enumerate(idx):
                rank[i] = r
                other = raw[idx[1]][4] if r == 0 and len(idx) > 1 else raw[idx[0]][4] if r > 0 else 99.0
                margin[i] = min(99.0, other - raw[i][4])
    out = []
    for i, (a, b, dt, last, pred) in enumerate(raw):
        if rank_a[i] >= TOP_K or rank_b[i] >= TOP_K:
            continue
        ha, hb = a.boxes[-1].h, b.boxes[0].h
        ea, sb = a.boxes[-1], b.boxes[0]
        excess = accel_excess(dt, np.array([sb.xm - ea.xm, sb.ym - ea.ym]), *v_end[a.id], *v_start[b.id])
        if accel_veto and excess > 0:
            continue
        x = np.array([
            dt, pred, last,
            abs(np.log(max(hb, 1) / max(ha, 1))),
            color_distance(a.lab, b.lab),
            np.log1p(len(a.boxes)), np.log1p(len(b.boxes)),
            float(a.track >= LOOSE_ID), float(b.track >= LOOSE_ID),
            float(a.crowded_end or b.crowded_start),
            float(n_succ[a.id]), float(n_pred[b.id]),
            float("unk" in (a.team, b.team)),
            float(a.track == b.track),
            float(rank_a[i]), float(rank_b[i]), m_a[i], m_b[i],
            pred / (LINK_SLACK_M * 0.4 + 3.0 * dt),
            excess,
        ])
        out.append(Candidate(a.id, b.id, x))
    return out


def candidate_labels(cands: list[Candidate], tracklets: list[Tracklet], truth: dict) -> np.ndarray:
    """1 misma jugadora con nombre, 0 jugadoras distintas, -1 desconocido. Un trozo que no es de jugadora (quitado o
    soltado en la mesa) no entra: eso lo decide la clasificación de trozos (`player_features`), antes de unir."""
    who = {t.id: tracklet_truth(t, truth)[0] for t in tracklets}
    y = np.full(len(cands), -1, dtype=int)
    for i, c in enumerate(cands):
        a, b = who[c.a], who[c.b]
        if a is None or b is None or "no" in (a, b):
            continue
        y[i] = int(a == b)
    return y


# --------------------------------------------------------------------------------------------- modelo

class TreeModel:
    """Árboles de gradiente pequeños (pérdida logística) en numpy: los cortes de cada variable se toman de sus cuantiles.
    Captan reglas que una regresión lineal no ve («hueco corto y sin competidor cerca»)."""

    def __init__(self, trees: int = 150, depth: int = 3, rate: float = 0.15, bins: int = 32, min_leaf: int = 50):
        self.trees, self.depth, self.rate, self.bins, self.min_leaf = trees, depth, rate, bins, min_leaf
        self.cuts: list[np.ndarray] = []
        self.forest: list[list] = []
        self.base = 0.0

    def _bin(self, X: np.ndarray) -> np.ndarray:
        return np.stack([np.searchsorted(c, X[:, j], side="right") for j, c in enumerate(self.cuts)], axis=1).astype(np.int16)

    def _grow(self, B, g, h, idx, d):
        G, H = g[idx].sum(), h[idx].sum()
        leaf = ("leaf", -G / (H + 1.0))
        if d == self.depth or len(idx) < 2 * self.min_leaf:
            return leaf
        best = None
        for j in range(B.shape[1]):
            gb = np.bincount(B[idx, j], weights=g[idx], minlength=self.bins + 1)
            hb = np.bincount(B[idx, j], weights=h[idx], minlength=self.bins + 1)
            nb = np.bincount(B[idx, j], minlength=self.bins + 1)
            gl, hl, nl = np.cumsum(gb)[:-1], np.cumsum(hb)[:-1], np.cumsum(nb)[:-1]
            ok = (nl >= self.min_leaf) & (len(idx) - nl >= self.min_leaf)
            if not ok.any():
                continue
            gain = gl**2 / (hl + 1) + (G - gl) ** 2 / (H - hl + 1) - G**2 / (H + 1)
            gain[~ok] = -np.inf
            k = int(np.argmax(gain))
            if best is None or gain[k] > best[0]:
                best = (gain[k], j, k)
        if best is None or best[0] <= 0:
            return leaf
        _, j, k = best
        left = idx[B[idx, j] <= k]
        right = idx[B[idx, j] > k]
        return ("split", j, k, self._grow(B, g, h, left, d + 1), self._grow(B, g, h, right, d + 1))

    def _apply(self, node, B):
        out = np.empty(len(B))
        stack = [(node, np.arange(len(B)))]
        while stack:
            n, idx = stack.pop()
            if n[0] == "leaf":
                out[idx] = n[1]
            else:
                m = B[idx, n[1]] <= n[2]
                stack += [(n[3], idx[m]), (n[4], idx[~m])]
        return out

    def fit(self, X: np.ndarray, y: np.ndarray) -> "TreeModel":
        self.cuts = [np.unique(np.quantile(X[:, j], np.linspace(0, 1, self.bins + 1)[1:-1])) for j in range(X.shape[1])]
        B = self._bin(X)
        p0 = min(max(y.mean(), 1e-3), 1 - 1e-3)
        self.base = float(np.log(p0 / (1 - p0)))
        f = np.full(len(y), self.base)
        idx = np.arange(len(y))
        for _ in range(self.trees):
            p = 1 / (1 + np.exp(-f))
            tree = self._grow(B, p - y, p * (1 - p), idx, 0)
            f += self.rate * self._apply(tree, B)
            self.forest.append(tree)
        return self

    def predict(self, X: np.ndarray) -> np.ndarray:
        if len(X) == 0:
            return np.zeros(0)
        B = self._bin(X)
        f = np.full(len(X), self.base)
        for t in self.forest:
            f += self.rate * self._apply(t, B)
        return 1 / (1 + np.exp(-f))

    def to_dict(self) -> dict:
        return {"kind": "trees", "features": FEATURES, "cuts": [c.tolist() for c in self.cuts], "forest": self.forest,
                "base": self.base, "rate": self.rate, "bins": self.bins}

    @classmethod
    def from_dict(cls, d: dict) -> "TreeModel":
        m = cls(rate=d["rate"], bins=d["bins"])
        m.cuts = [np.array(c) for c in d["cuts"]]
        to_t = lambda n: ("leaf", n[1]) if n[0] == "leaf" else ("split", n[1], n[2], to_t(n[3]), to_t(n[4]))  # noqa: E731
        m.forest = [to_t(t) for t in d["forest"]]
        m.base = d["base"]
        return m


def accept_greedy(cands: list[Candidate], p_min: float = P_ACCEPT, allowed: set[int] | None = None) -> list[Candidate]:
    """Uniones uno a uno, de la más probable a la menos, mientras pasen de p_min. `allowed`: trozos que se pueden unir
    (los clasificados como jugadora); los demás se quedan solos."""
    used_a: set[int] = set()
    used_b: set[int] = set()
    out = []
    for c in sorted(cands, key=lambda c: -c.p):
        if c.p < p_min:
            break
        if c.a in used_a or c.b in used_b or (allowed is not None and (c.a not in allowed or c.b not in allowed)):
            continue
        used_a.add(c.a)
        used_b.add(c.b)
        out.append(c)
    return out


# --------------------------------------------------------------------------------------------- ¿es jugadora?

PLAYER_FEATURES = [
    "len_log", "loose", "team_own", "team_opp", "team_ref", "team_unk", "lab_l", "lab_a", "lab_b", "edge_m", "h_px",
    "speed_ms", "x_m", "y_m",
]


def player_features(t: Tracklet, length_m: float, width_m: float, fps: float) -> np.ndarray:
    """Variables de un trozo para decidir si es una jugadora (y no árbitro, banca, público o una detección suelta)."""
    xs = np.array([b.xm for b in t.boxes], dtype=float)
    ys = np.array([b.ym for b in t.boxes], dtype=float)
    x, y = float(np.nanmedian(xs)) if np.isfinite(xs).any() else -10.0, float(np.nanmedian(ys)) if np.isfinite(ys).any() else -10.0
    # Distance to the nearest line, negative outside the pitch.
    edge = min(x, length_m - x, y, width_m - y)
    dur = (t.end - t.start) / fps
    speed = float(np.hypot(xs[-1] - xs[0], ys[-1] - ys[0]) / dur) if dur > 0 and np.isfinite(xs[[0, -1]]).all() else 0.0
    lab = t.lab
    team = t.team
    return np.array([
        np.log1p(len(t.boxes)), float(t.track >= LOOSE_ID),
        float(team == "own"), float(team == "opp"), float(team == "ref"), float(team not in ("own", "opp", "ref")),
        lab[0], lab[1], lab[2], edge, float(np.median([b.h for b in t.boxes])), speed, x, y,
    ])


def player_labels(tracklets: list[Tracklet], truth: dict) -> np.ndarray:
    """1 jugadora con nombre, 0 no es jugadora (quitada o soltada en la mesa), -1 sin revisar."""
    out = np.full(len(tracklets), -1, dtype=int)
    for i, t in enumerate(tracklets):
        who, _ = tracklet_truth(t, truth)
        if who is not None:
            out[i] = int(who != "no")
    return out


def chains(n: int, links: list[Candidate]) -> np.ndarray:
    """Identidad de cada trozo después de las uniones (unión de conjuntos)."""
    parent = list(range(n))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for c in links:
        parent[find(c.b)] = find(c.a)
    return np.array([find(i) for i in range(n)])


# --------------------------------------------------------------------------------------------- medidas

@dataclass
class Score:
    boxes_known: int = 0          # cajas de jugadoras con nombre
    impure_boxes: int = 0         # de esas, en un trozo/identidad cuya mayoría es otra persona
    pieces: int = 0               # trozos o identidades que contienen jugadoras con nombre
    joins_needed: int = 0         # uniones que faltarían para que cada persona sea una sola identidad (por parte)
    cuts_needed: int = 0          # cortes que faltarían: veces que un grupo pasa de una persona a otra en el tiempo
    people: int = 0

    def add(self, o: "Score") -> "Score":
        return Score(*(getattr(self, k) + getattr(o, k) for k in self.__dataclass_fields__))

    @property
    def purity(self) -> float:
        return 1 - self.impure_boxes / self.boxes_known if self.boxes_known else float("nan")


def score_groups(groups: dict[tuple[int, int], int], truth: dict) -> Score:
    """Pureza y trabajo pendiente de una asignación (cuadro, track) -> grupo, frente a la verdad. Cada grupo se recorre
    en el tiempo: cada cambio de persona es un corte, y cada persona debe acabar en un solo tramo, así que sus tramos
    sueltos (en grupos distintos o separados por un corte) son uniones."""
    members: dict[int, list[int]] = {}
    timeline: dict[int, list[tuple[int, int]]] = {}
    for key, g in groups.items():
        v = truth.get(key)
        if isinstance(v, int):
            members.setdefault(g, []).append(v)
            timeline.setdefault(g, []).append((key[0], v))
    s = Score()
    runs_of: dict[int, int] = {}
    for g, vals in members.items():
        best = max(set(vals), key=vals.count)
        s.boxes_known += len(vals)
        s.impure_boxes += len(vals) - vals.count(best)
        s.pieces += 1
        seq = sorted(timeline[g])
        runs = [seq[0][1]] + [b for (_, a), (_, b) in zip(seq, seq[1:]) if a != b]
        s.cuts_needed += len(runs) - 1
        for person in runs:
            runs_of[person] = runs_of.get(person, 0) + 1
    s.people = len(runs_of)
    s.joins_needed = sum(n - 1 for n in runs_of.values())
    return s

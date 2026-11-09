"""Dobles cajas: segunda pasada sobre las identidades que arma `fill` (anchors_cli).

En la app una identidad es un conjunto de tracks completos (`editsFromLinks`), así que en un cuadro puede tener dos cajas:
dos cadenas suyas que se solapan, o un track suyo que en otro tramo pertenece a otra cadena. Aquí se resuelve con un
corte duro por cuadro, sin volver a los trozos del seguidor ni partir o unir nada:

1. Por jugadora, una ruta por programación dinámica (Viterbi) sobre sus cuadros: costo de continuidad = metros entre
   cajas elegidas en cuadros consecutivos (salto más allá de S0 * dt + holgura = costo enorme) menos bonos por caja de
   una cadena con ancla de ella, de una cadena que `fill` le dio, por cadena larga y por confianza del detector.
   La aceleración no entra en la ruta: con un paso de 0.1 s el ruido de la calibración ya supera A0 por sí solo.
2. Por cada tramo seguido en que otra caja acompaña a la de la ruta: si forzar la ruta por la otra cuesta al menos
   el margen más, se queda la de la ruta y se descarta la otra (`ruta`). El margen se calibró con la verdad para que lo
   elegido acierte al menos el 95 % (`doubles_eval`). Si no llega: hasta BOTH_MAX_S se descartan las dos en esos cuadros
   (`ambas`: no se elige a nadie; la exportación rellena huecos <= 4 s si son posibles) y, más largo, duda `dos_sitios`.

`second_pass` mide, antes y después, los saltos imposibles (regla de la mesa: > 3 m y > 9 m/s entre posiciones
seguidas, tras quitar picos de un punto como la exportación) y los huecos > 4 s.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

S0_MS = 8.5            # velocidad máxima del equipo
REACH_SLACK_M = 1.5    # holgura de la calibración para el límite de velocidad
JUMP_COST = 1000.0     # salto imposible
NAN_STEP_COST = 1.0    # paso hacia o desde una caja sin posición en la cancha
ROUTE_MARGIN = 2000.0   # calibrado en doubles_eval (precisión de lo elegido >= 95 %: solo separa dos saltos imposibles)
W_ANCHOR = 6.0         # caja de una cadena con ancla de esa jugadora
W_OWN = 1.5            # caja de una cadena que fill le asignó (y no de un track suyo que en otro tramo es otra cadena)
W_LEN = 1.0            # por cadena larga (satura a LEN_SAT_S)
LEN_SAT_S = 20.0
W_CONF = 1.0
JUMP_M, JUMP_MS, PAIR_MAX_S = 3.0, 9.0, 1.0   # como web/lib/cuts.ts y jumpReview.ts
HOLE_S = 4.0
BOTH_MAX_S = 4.0       # solape sin decidir hasta tanto: se quitan las dos cajas (el relleno <= 4 s cierra el hueco)
REASONS = ("ruta", "ambas")


def box_entry(frame: int, track: int, player: "str | None", role: str, fps: float) -> dict:
    """Una caja implicada en una duda: cuadro exacto, track, jugadora (o None), papel y tiempo en segundos de video."""
    return {"frame": int(frame), "track": int(track), "player": player, "role": role, "t": round(float(frame) / fps, 3)}


def jump_info(a, b, fps: float) -> dict:
    """Salto entre dos posiciones (cuadro, x, y, ...): distancia en m, tiempo en s, velocidad en m/s y extremos."""
    d = float(np.hypot(b[1] - a[1], b[2] - a[2]))
    dt = abs(b[0] - a[0]) / fps
    return {"dist_m": round(d, 2), "dt_s": round(dt, 3), "speed_ms": round(d / dt, 2) if dt > 0 else None,
            "from": [round(float(a[1]), 2), round(float(a[2]), 2)], "to": [round(float(b[1]), 2), round(float(b[2]), 2)]}


@dataclass
class Cand:
    frame: int
    track: int
    xm: float
    ym: float
    unary: float           # costo propio (negativo = bono)


@dataclass
class DoublesResult:
    drops: list[dict] = field(default_factory=list)        # {"frame","track","player","reason"}
    doubts: list[dict] = field(default_factory=list)       # dos_sitios sin resolver
    frames_before: int = 0                                 # cuadros con dos o más cajas de la misma identidad
    frames_after: int = 0
    by_reason: dict[str, int] = field(default_factory=dict)  # cajas descartadas por motivo


def player_tracks(identities: list[dict]) -> dict[str, set[int]]:
    """Tracks de cada jugadora como los aplica la app (editsFromLinks): un track que reclaman dos jugadoras no es de ninguna."""
    owners: dict[int, set[str]] = {}
    for idt in identities:
        for t in idt["tracks"]:
            owners.setdefault(int(t), set()).add(idt["player"])
    bad = {t for t, s in owners.items() if len(s) > 1}
    return {idt["player"]: {int(t) for t in idt["tracks"]} - bad for idt in identities if idt.get("player")}


def _dist(a: Cand, b: Cand) -> float:
    if not (np.isfinite(a.xm) and np.isfinite(a.ym) and np.isfinite(b.xm) and np.isfinite(b.ym)):
        return float("nan")
    return float(np.hypot(a.xm - b.xm, a.ym - b.ym))


def step_cost(a: Cand, b: Cand, fps: float) -> float:
    d = _dist(a, b)
    if not np.isfinite(d):
        return NAN_STEP_COST
    dt = abs(b.frame - a.frame) / fps
    if d > S0_MS * dt + REACH_SLACK_M:
        return JUMP_COST + d
    return d


def viterbi(layers: list[list[Cand]], fps: float):
    """Ruta de menor costo. Devuelve (índice elegido por capa, costo óptimo, F, B): F[i][s] = mejor costo hasta la caja s
    de la capa i (incluida), B[i][s] = mejor costo desde la capa i+1 en adelante saliendo de s."""
    n = len(layers)
    F = [np.array([c.unary for c in layers[0]])]
    back = [np.zeros(len(layers[0]), dtype=int)]
    for i in range(1, n):
        cur = np.empty(len(layers[i]))
        bk = np.empty(len(layers[i]), dtype=int)
        for s, c in enumerate(layers[i]):
            opts = [F[i - 1][r] + step_cost(p, c, fps) for r, p in enumerate(layers[i - 1])]
            r = int(np.argmin(opts))
            cur[s], bk[s] = opts[r] + c.unary, r
        F.append(cur)
        back.append(bk)
    B = [None] * n
    B[n - 1] = np.zeros(len(layers[n - 1]))
    for i in range(n - 2, -1, -1):
        B[i] = np.array([min(step_cost(c, q, fps) + q.unary + B[i + 1][t] for t, q in enumerate(layers[i + 1]))
                         for c in layers[i]])
    path = [0] * n
    path[-1] = int(np.argmin(F[-1]))
    for i in range(n - 1, 0, -1):
        path[i - 1] = int(back[i][path[i]])
    return path, float(F[-1].min()), F, B


def forced_cost(layers, F, B, a: int, b: int, track: int, fps: float) -> float:
    """Mejor costo total si en las capas a..b se toma siempre la caja de `track`."""
    seq = [next(c for c in layers[i] if c.track == track) for i in range(a, b + 1)]
    inner = sum(c.unary for c in seq) + sum(step_cost(x, y, fps) for x, y in zip(seq, seq[1:]))
    before = min(F[a - 1][r] + step_cost(p, seq[0], fps) for r, p in enumerate(layers[a - 1])) if a > 0 else 0.0
    after = min(step_cost(seq[-1], q, fps) + q.unary + B[b + 1][t] for t, q in enumerate(layers[b + 1])) if b + 1 < len(layers) else 0.0
    return float(before + inner + after)


@dataclass
class Weights:
    """Bonos de la ruta (se restan del costo de una caja) y margen para elegir."""
    anchor: float = W_ANCHOR
    own: float = W_OWN
    length: float = W_LEN
    conf: float = W_CONF
    margin: float = ROUTE_MARGIN


def resolve_player(player: str, layers: list[list[Cand]], fps: float, stride: int, margin: float = ROUTE_MARGIN,
                   runs_out: list | None = None) -> tuple[list[dict], list[dict], int, int]:
    """Cortes de una jugadora. `layers`: sus cuadros en orden, cada uno con sus cajas candidatas.

    Por cada tramo seguido en que otra caja acompaña a la de la ruta: si forzar la ruta por la otra cuesta al menos
    `margin` más, se descarta la otra (`ruta`); si no, y el tramo dura <= BOTH_MAX_S, se descartan las dos en esos cuadros
    (`ambas`: no se elige a nadie y el relleno de la exportación cierra el hueco); si dura más, duda `dos_sitios`.
    `runs_out` recibe (cuadros, tracks elegidos, otro track, margen) de cada tramo, para calibrar."""
    drops: list[dict] = []
    doubts: list[dict] = []
    if not layers:
        return drops, doubts, 0, 0
    before = sum(len(L) > 1 for L in layers)
    if before == 0:
        return drops, doubts, 0, 0
    path, opt, F, B = viterbi(layers, fps)
    chosen = [layers[i][path[i]] for i in range(len(layers))]
    others_at: dict[int, list[int]] = {}
    for i, L in enumerate(layers):
        for o in L:
            if o is not chosen[i]:
                others_at.setdefault(o.track, []).append(i)
    gap = 1.5 * stride
    seen: set[tuple[int, int]] = set()

    def add(c: Cand, reason: str) -> None:
        if (c.frame, c.track) not in seen:
            seen.add((c.frame, c.track))
            drops.append(dict(frame=int(c.frame), track=int(c.track), player=player, reason=reason))

    for track, idx in others_at.items():
        runs, cur = [], [idx[0]]
        for i in idx[1:]:
            if i == cur[-1] + 1 and layers[i][0].frame - layers[cur[-1]][0].frame <= gap:
                cur.append(i)
            else:
                runs.append(cur)
                cur = [i]
        runs.append(cur)
        for run in runs:
            a, b = run[0], run[-1]
            m = forced_cost(layers, F, B, a, b, track, fps) - opt
            others = [next(c for c in layers[i] if c.track == track) for i in run]
            if runs_out is not None:
                runs_out.append(([layers[i][0].frame for i in run], [chosen[i].track for i in run], track, m))
            if m >= margin:
                for o in others:
                    add(o, "ruta")
                continue
            dur = (layers[b][0].frame - layers[a][0].frame + stride) / fps
            if dur <= BOTH_MAX_S:
                for i, o in zip(run, others):
                    add(o, "ambas")
                    add(chosen[i], "ambas")
                continue
            other_a = next(c for c in layers[a] if c.track == track)
            doubts.append(dict(kind="dos_sitios", frame=int(others[0].frame), track=int(track), players=[player], task=True,
                               boxes=[box_entry(chosen[a].frame, chosen[a].track, player, "a", fps),
                                      box_entry(other_a.frame, other_a.track, player, "b", fps)],
                               note=f"{player} en dos sitios {dur:.1f} s (tracks {chosen[a].track} y {track}) y la ruta no "
                                    f"distingue cuál es ella (diferencia {m:.1f})"))
    left = {L[0].frame: len(L) for L in layers}
    for d in drops:
        left[d["frame"]] -= 1
    after = sum(n > 1 for n in left.values())
    drops.sort(key=lambda d: (d["frame"], d["track"]))
    return drops, doubts, before, after


def resolve(rows: dict[int, list], tracks_of: dict[str, set[int]], fps: float, stride: int,
            anchored: dict[str, set[tuple[int, int]]], own: dict[str, set[tuple[int, int]]],
            chain_s: dict[tuple[int, int], float], conf: dict[tuple[int, int], float],
            w: Weights | None = None, runs_out: dict | None = None) -> DoublesResult:
    """`rows`: cuadro -> cajas (Box). `anchored[p]` / `own[p]`: (cuadro, track) de las cadenas con ancla de p / que fill le dio.
    `chain_s`: (cuadro, track) -> duración en s de su cadena. `conf`: confianza del detector."""
    w = w or Weights()
    res = DoublesResult(by_reason={r: 0 for r in REASONS})
    for p, tracks in tracks_of.items():
        layers = []
        for f in sorted(rows):
            L = []
            for b in rows[f]:
                if b.track not in tracks:
                    continue
                k = (f, b.track)
                u = -(w.anchor * (k in anchored.get(p, ())) + w.own * (k in own.get(p, ()))
                      + w.length * min(chain_s.get(k, 0.0) / LEN_SAT_S, 1.0) + w.conf * conf.get(k, 0.0))
                L.append(Cand(f, b.track, b.xm, b.ym, u))
            if L:
                layers.append(L)
        ro = runs_out.setdefault(p, []) if runs_out is not None else None
        drops, doubts, before, after = resolve_player(p, layers, fps, stride, w.margin, ro)
        res.drops.extend(drops)
        res.doubts.extend(doubts)
        res.frames_before += before
        res.frames_after += after
        for d in drops:
            res.by_reason[d["reason"]] = res.by_reason.get(d["reason"], 0) + 1
    res.drops.sort(key=lambda d: (d["frame"], d["track"]))
    return res


# --------------------------------------------------------------------------------------- segunda pasada (medida)

def path_of(rows: dict[int, list], tracks: set[int], dropped: set[tuple[int, int]], conf: dict) -> list[tuple[int, float, float]]:
    """Una posición por cuadro (la caja de mayor confianza que queda), como la exportación."""
    out = []
    for f in sorted(rows):
        bs = [b for b in rows[f] if b.track in tracks and (f, b.track) not in dropped]
        if not bs:
            continue
        b = max(bs, key=lambda b: conf.get((f, b.track), 0.0))
        out.append((f, b.xm, b.ym))
    return out


def _is_jump(a, b, fps) -> bool:
    dt = (b[0] - a[0]) / fps
    if not (np.isfinite(a[1]) and np.isfinite(b[1])) or dt <= 0 or dt > PAIR_MAX_S:
        return False
    d = np.hypot(b[1] - a[1], b[2] - a[2])
    return d > JUMP_M and d / dt > JUMP_MS


def second_pass(path: list[tuple[int, float, float]], fps: float) -> dict:
    """Saltos imposibles tras quitar picos de un punto (entrar y salir imposibles, pasar de largo posible: lib/smooth.ts) y
    huecos de más de HOLE_S (los de hasta HOLE_S los rellena la exportación si son posibles)."""
    pts = [p for p in path if np.isfinite(p[1])]
    keep = []
    for i, p in enumerate(pts):
        if 0 < i < len(pts) - 1 and _is_jump(pts[i - 1], p, fps) and _is_jump(p, pts[i + 1], fps) and not _is_jump(pts[i - 1], pts[i + 1], fps):
            continue
        keep.append(p)
    jumps = sum(_is_jump(a, b, fps) for a, b in zip(keep, keep[1:]))
    frames = [p[0] for p in path]
    holes = sum((b - a) / fps > HOLE_S for a, b in zip(frames, frames[1:]))
    return {"jumps": int(jumps), "holes_long": int(holes), "frames": len(frames)}


# --------------------------------------------------------------------------------- variante B (fill --variant exp)
# Pasadas 3 y 4 sobre la ruta que queda de cada jugadora tras la exclusión y las dobles cajas. Mismas reglas que la app:
# salto = > JUMP_M y > JUMP_MS entre posiciones seguidas a <= PAIR_MAX_S; excursión de <= EXCURSION_S que vuelve a donde
# podía estar = posiciones equivocadas (lib/smooth.ts); arranque/frenada con los límites de lib/jumpReview.ts.
EXCURSION_S = 0.8
A0_MS2, MAX_DECEL_MS2, ACCEL_SLACK_MS2, WINDOW_S = 7.0, 8.0, 1.0, 1.0


def route(rows: dict[int, list], tracks: set[int], dropped: set[tuple[int, int]], conf: dict,
          only: "set[tuple[int, int]] | None" = None) -> list[tuple[int, float, float, int]]:
    """(cuadro, x, y, track) por cuadro con posición: la caja de mayor confianza que queda (como `path_of`).
    `only`: si se da, solo cuentan esas cajas (cuadro, track) (relleno por tramos); `tracks` se ignora."""
    out = []
    for f in sorted(rows):
        if only is not None:
            bs = [b for b in rows[f] if (f, b.track) in only and (f, b.track) not in dropped]
        else:
            bs = [b for b in rows[f] if b.track in tracks and (f, b.track) not in dropped]
        if not bs:
            continue
        b = max(bs, key=lambda b: conf.get((f, b.track), 0.0))
        if np.isfinite(b.xm) and np.isfinite(b.ym):
            out.append((f, float(b.xm), float(b.ym), int(b.track)))
    return out


def _possible(a, b, fps) -> bool:
    dt = abs(b[0] - a[0]) / fps
    return float(np.hypot(b[1] - a[1], b[2] - a[2])) <= S0_MS * dt + REACH_SLACK_M


def jump_pass(path: list, fps: float, stride: int) -> tuple[list, list, list]:
    """Pasada 3. Devuelve (posiciones descartadas, saltos que quedan como (antes, después), ruta limpia). Se descartan los
    picos de un punto (entrar y salir imposibles, pasar de largo posible) y las excursiones de <= EXCURSION_S que saltan y
    vuelven a un sitio alcanzable desde la posición anterior."""
    pts = list(path)
    out = []
    for _ in range(3):
        keep = [p for i, p in enumerate(pts) if not (0 < i < len(pts) - 1 and _is_jump(pts[i - 1], p, fps)
                                                       and _is_jump(p, pts[i + 1], fps) and not _is_jump(pts[i - 1], pts[i + 1], fps))]
        if len(keep) == len(pts):
            break
        out += [p for p in pts if p not in keep]
        pts = keep
    max_pts = max(2, round(EXCURSION_S * fps / max(1, stride)))
    i = 1
    while i < len(pts) - 1:
        a = pts[i - 1]
        if _is_jump(a, pts[i], fps):
            for k in range(i + 1, min(len(pts), i + max_pts + 1)):
                if (pts[k - 1][0] - pts[i][0]) / fps > EXCURSION_S:
                    break
                if _is_jump(pts[k - 1], pts[k], fps) and _possible(a, pts[k], fps):
                    out += pts[i:k]
                    pts = pts[:i] + pts[k:]
                    break
        i += 1
    left = [(a, b) for a, b in zip(pts, pts[1:]) if _is_jump(a, b, fps)]
    out.sort()
    return out, left, pts


def accel_violations(path: list, fps: float) -> int:
    """Ventanas de 1 s con arranque o frenada imposibles (lib/jumpReview.ts: profile + verdict), en tramos sin huecos."""
    t = np.array([p[0] / fps for p in path])
    xy = np.array([[p[1], p[2]] for p in path]) if path else np.zeros((0, 2))
    win = []
    for i in range(len(path)):
        j = i
        while j + 1 < len(path) and t[j + 1] - t[j] <= 0.35 and t[j + 1] - t[i] <= WINDOW_S + 0.01:
            j += 1
        dt = t[j] - t[i]
        if dt >= 0.8 * WINDOW_S:
            win.append(((t[i] + t[j]) / 2, float(np.hypot(*(xy[j] - xy[i]))) / dt))
    tm = np.array([w[0] for w in win])
    bad = 0
    for tc, v in win:
        k = int(np.searchsorted(tm, tc + WINDOW_S - 0.06))
        if k >= len(win) or abs(tm[k] - (tc + WINDOW_S)) >= 0.06:
            continue
        a = (win[k][1] - v) / (tm[k] - tc)
        bad += a > A0_MS2 * max(0.0, 1 - v / S0_MS) + ACCEL_SLACK_MS2 or a < -MAX_DECEL_MS2
    return int(bad)


def holes_pass(path: list, fps: float, stride: int, bridge_s: float = HOLE_S):
    """Pasada 4. Huecos entre posiciones: (rellenables [(t0, t1)], imposibles [(a, b)], largos [(a, b)])."""
    fill, impossible, long_ = [], [], []
    for a, b in zip(path, path[1:]):
        if b[0] - a[0] <= 1.5 * stride:
            continue
        dt = (b[0] - a[0]) / fps
        if dt > bridge_s:
            long_.append((a, b))
        elif _possible(a, b, fps):
            fill.append((round(a[0] / fps, 3), round(b[0] / fps, 3)))
        else:
            impossible.append((a, b))
    return fill, impossible, long_


def measure(rows: dict[int, list], identities: list[dict], drops: list[dict], fps: float, stride: int, conf: dict) -> dict:
    """Lo que ve la mesa con unas identidades (tracks completos) y unas cajas descartadas: cuadros con doble caja, saltos
    imposibles (tras quitar picos de un punto, como la exportación), huecos > 4 s y segundos con nombre."""
    tracks_of = player_tracks(identities)
    dropped = {(int(d["frame"]), int(d["track"])) for d in drops}
    dbl = jumps = holes = n = 0
    for p, tracks in tracks_of.items():
        for f, r in rows.items():
            dbl += sum(b.track in tracks and (f, b.track) not in dropped for b in r) > 1
        path = path_of(rows, tracks, dropped, conf)
        sp = second_pass(path, fps)
        jumps += sp["jumps"]
        holes += sp["holes_long"]
        n += len(path)
    return {"double_frames": int(dbl), "jumps": int(jumps), "holes_long": int(holes), "named_s": round(n * stride / fps, 1)}

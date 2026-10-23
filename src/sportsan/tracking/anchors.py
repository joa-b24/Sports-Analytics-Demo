"""Fase 3 de la unión de tracks: anclas y relleno entre anclas (docs/propuesta_union_tracks.md, 5.5 y 7).

Sin interfaz. Sobre una parte:

1. Unión de la fase 1 (`tracklets`): trozos puros unidos al umbral `LINK_P_MIN` -> **cadenas**.
2. **Anclas**: (cadena, jugadora). En la app las pondrá la persona con un clic; aquí se simulan desde la verdad
   (`labels_*.json`), k por minuto y jugadora, en cadenas de al menos `ANCHOR_MIN_S` y aisladas (nadie a menos de
   `ANCHOR_ISOLATION_M` en su cuadro central).
3. **Relleno**: se recorre la parte en el tiempo, por ventanas de `WINDOW_S`; en cada ventana las cadenas que empiezan se
   reparten entre todas las jugadoras a la vez con asignación húngara (una cadena es de una sola persona, o de nadie).
   Costo de dar la cadena c a la jugadora j: −log p del modelo de unión entre la última cadena de j y c (si hay candidato
   de la fase 1) o un costo a priori que crece con el hueco, más el movimiento físico (S0 = 8.5 m/s, A0 = 7 m/s²). Solo se
   puede si después j llega a tiempo a su siguiente ancla. Nunca se une entre equipos distintos. Antes del primer ancla
   de cada jugadora no se rellena (solo hacia delante).
4. **Dudas**: asignaciones caras o casi empatadas con otra jugadora, misma jugadora en dos sitios a la vez y saltos
   imposibles que quedan. Horas ≈ 2 s por ancla + 3 s por duda.

Equipo de cada cadena: mientras no exista la clasificación en grupos (F2), se toma de `labels` (el equipo de la persona
mayoritaria) y, si no tiene, el de process. Es una ventaja frente a lo real: las cifras de la F3 suponen una F2 perfecta.
Las rivales no tienen nombre en la verdad (solo equipo y rol), así que solo se miden las propias con nombre.

    python -m sportsan.tracking.anchors --match 2026_09_25_tec_ccm_vs_anahuac --feet
"""
from __future__ import annotations

import argparse
import json
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from scipy.optimize import linear_sum_assignment

from sportsan.tracking.tracklets import (
    FEATURES,
    LINK_P_MIN,
    LINK_SLACK_M,
    TEAM_S0_MS,
    Box,
    Score,
    Tracklet,
    TreeModel,
    _velocity_at,
    accel_excess,
    accept_greedy,
    candidate_labels,
    chains,
    link_candidates,
    player_features,
    player_labels,
    pure_tracklets,
    score_groups,
    tracklet_truth,
)

ANCHOR_MIN_S = 3.0
ANCHOR_ISOLATION_M = 2.0
WINDOW_S = 1.0
# Costo a priori de una unión sin candidato de la fase 1 (hueco > MAX_LINK_S o fuera del TOP_K): base + por segundo.
PRIOR_COST = 1.5
GAP_COST_S = 0.3
PHYS_W = 3.0
ACCEL_PENALTY = 2.0
UNNAMED_COST = 6.0        # por encima de esto la cadena se queda sin nombre
DOUBT_COST = 3.0          # una asignación más cara que esto es duda
DOUBT_MARGIN = 0.7        # o si otra jugadora queda a menos de esto
SECONDS_PER_ANCHOR = 2.0
SECONDS_PER_DOUBT = 3.0
SECONDS_PER_PENDING = 3.0  # unión o corte que queda a mano
MATCH_MIN = 90.0
NAMED_OFFSET = 10_000_000  # grupo de una jugadora en score_groups


@dataclass
class Chain:
    id: int
    tl: Tracklet                       # todas las cajas de la cadena, como un trozo
    first: int                         # trozo inicial y final (para buscar p del modelo de unión)
    last: int
    team: str

    @property
    def start(self) -> int:
        return self.tl.start

    @property
    def end(self) -> int:
        return self.tl.end


def build_chains(tracklets: list[Tracklet], links, team_of=None) -> list[Chain]:
    """Cadenas de trozos según las uniones de la fase 1. `team_of(tracklet) -> equipo` (por defecto, el de process)."""
    root = chains(len(tracklets), links)
    groups: dict[int, list[Tracklet]] = {}
    for t, r in zip(tracklets, root):
        groups.setdefault(int(r), []).append(t)
    out = []
    for members in groups.values():
        members.sort(key=lambda t: t.start)
        boxes = sorted((b for t in members for b in t.boxes), key=lambda b: b.frame)
        tl = Tracklet(id=-1, track=members[0].track, boxes=boxes)
        out.append(Chain(len(out), tl, members[0].id, members[-1].id, team_of(tl) if team_of else tl.team))
    out.sort(key=lambda c: (c.start, c.end))
    for i, c in enumerate(out):
        c.id = i
    return out


def _finite_end(t: Tracklet, at_end: bool):
    seq = reversed(t.boxes) if at_end else t.boxes
    for b in seq:
        if np.isfinite(b.xm) and np.isfinite(b.ym):
            return b
    return None


def isolated(c: Chain, rows: dict[int, list], radius: float = ANCHOR_ISOLATION_M):
    """Cuadro central de la cadena si en él nadie está a menos de `radius`; si no, None."""
    b = c.tl.boxes[len(c.tl.boxes) // 2]
    if not np.isfinite(b.xm):
        return None
    for o in rows.get(b.frame, []):
        if o.track != b.track and o.on_pitch and np.isfinite(o.xm) and np.hypot(o.xm - b.xm, o.ym - b.ym) < radius:
            return None
    return b.frame


# ---------------------------------------------------------------------------------------- densidad híbrida
# La cámara está de un lado de la cancha: quien juega en el lado cercano casi nunca se pierde, quien juega en la banda
# lejana se pierde más (cajas pequeñas, tapadas). La densidad de anclas sigue esa franja (docs/mapa_del_repo.md).
ZONES = ("near", "center", "far")
HYBRID_RATES = {"near": 2.0, "center": 3.0, "far": 4.0}
GK_RATE = 2.0             # la portera pide esto aunque su franja pida más
GK_X_M = 10.0             # a menos de esto de una línea de meta (posición media) ...
GK_Y_M = 12.0             # ... y a menos de esto del centro del ancho: zona de portería


def camera_sign(rows) -> int:
    """+1 si la coordenada `ym` crece hacia la cámara, -1 si decrece. Se mide con la altura en píxeles de la parte baja
    de la caja (y2: más abajo en la imagen = más cerca) frente a `ym`. `rows`: iterable de listas de Box. Sin datos: +1."""
    ys, y2 = [], []
    for r in rows:
        for b in r:
            if b.on_pitch and np.isfinite(b.ym):
                ys.append(b.ym)
                y2.append(b.y2)
    if len(ys) < 10 or np.std(ys) == 0 or np.std(y2) == 0:
        return 1
    return 1 if np.corrcoef(y2, ys)[0, 1] >= 0 else -1


def lateral(ym: float, width: float, sign: int) -> float:
    """0 = banda cercana a la cámara, 1 = banda lejana."""
    u = 1.0 - ym / width if sign > 0 else ym / width
    return float(min(max(u, 0.0), 1.0))


def zone_edges(us, mode: str = "thirds") -> tuple[float, float]:
    """Cortes entre cercana/centro y centro/lejana sobre `lateral`. `thirds`: tercios del ancho. `quantiles`: terciles de
    las posiciones medias dadas (reparte igual número de cadenas o jugadoras por franja)."""
    us = [u for u in us if np.isfinite(u)]
    if mode == "quantiles" and len(us) >= 3:
        a, b = np.quantile(us, [1 / 3, 2 / 3])
        return float(a), float(b)
    return 1 / 3, 2 / 3


def zone_of(u: float, edges: tuple[float, float] = (1 / 3, 2 / 3)) -> str:
    return "near" if u < edges[0] else "center" if u < edges[1] else "far"


def mean_position(boxes) -> tuple[float, float]:
    xs = np.array([b.xm for b in boxes], dtype=float)
    ys = np.array([b.ym for b in boxes], dtype=float)
    k = np.isfinite(xs) & np.isfinite(ys)
    return (float(xs[k].mean()), float(ys[k].mean())) if k.any() else (float("nan"), float("nan"))


def in_goal_zone(x: float, y: float, length: float, width: float) -> bool:
    return bool(np.isfinite(x) and np.isfinite(y) and min(x, length - x) <= GK_X_M and abs(y - width / 2) <= GK_Y_M)


def hybrid_rate(u: float, goal: bool, zone_rates: dict[str, float], edges=(1 / 3, 2 / 3)) -> float:
    """Anclas por minuto de quien está en `u` (si es de la zona de portería, a lo más GK_RATE)."""
    r = zone_rates[zone_of(u, edges)]
    return min(r, GK_RATE) if goal else r


def person_hybrid_rates(chs: list[Chain], truth: dict, people: set[int], sign: int, length: float, width: float,
                        zone_rates: dict[str, float] | None = None, mode: str = "thirds"):
    """Simulación: cuota de cada jugadora según su posición media (cajas de sus cadenas en la verdad). Devuelve
    (cuotas, franja de cada una, cortes)."""
    zone_rates = zone_rates or HYBRID_RATES
    pos: dict[int, list] = {}
    for c in chs:
        who, _ = tracklet_truth(c.tl, truth)
        if who in people:
            pos.setdefault(int(who), []).extend(c.tl.boxes)
    mean = {p: mean_position(bx) for p, bx in pos.items()}
    us = {p: lateral(y, width, sign) for p, (x, y) in mean.items() if np.isfinite(y)}
    edges = zone_edges(list(us.values()), mode)
    rates, zones = {}, {}
    for p in people:
        if p not in us:
            rates[p], zones[p] = zone_rates["center"], "center"
            continue
        zones[p] = zone_of(us[p], edges)
        rates[p] = hybrid_rate(us[p], in_goal_zone(*mean[p], length, width), zone_rates, edges)
    return rates, zones, edges


def pick_anchors(chs: list[Chain], truth: dict, rows: dict[int, list], fps: float, start: int, end: int,
                 per_min: "float | dict[int, float]", people: set[int]) -> tuple[dict[int, int], int]:
    """Anclas simuladas: cadena -> jugadora. En cada tramo de 60/per_min s y por jugadora, la cadena más larga de ella
    (por mayoría en la verdad) de al menos ANCHOR_MIN_S y aislada cuyo cuadro central cae en el tramo. `per_min` puede ser
    un número o un dict jugadora -> anclas/min (política híbrida). Devuelve también cuántos tramos se quedaron sin ancla
    posible."""
    cand: dict[int, list[tuple[int, Chain]]] = {}
    for c in chs:
        if (c.end - c.start) / fps < ANCHOR_MIN_S:
            continue
        who, _ = tracklet_truth(c.tl, truth)
        if who not in people:
            continue
        mid = isolated(c, rows)
        if mid is not None:
            cand.setdefault(int(who), []).append((mid, c))
    out: dict[int, int] = {}
    empty = 0
    for person in people:
        rate = per_min[person] if isinstance(per_min, dict) else per_min
        slot = 60.0 / rate * fps
        n_slots = max(1, int(np.ceil((end - start) / slot)))
        for k in range(n_slots):
            lo, hi = start + k * slot, start + (k + 1) * slot
            options = [c for mid, c in cand.get(person, []) if lo <= mid < hi and c.id not in out]
            if not options:
                empty += 1
                continue
            best = max(options, key=lambda c: c.end - c.start)
            out[best.id] = person
    return out, empty


@dataclass
class Fill:
    owner: dict[int, int] = field(default_factory=dict)     # cadena -> jugadora
    cost: dict[int, float] = field(default_factory=dict)    # costo de la asignación (las anclas no tienen)
    doubts_cost: int = 0
    doubts_close: int = 0
    doubts_overlap: int = 0
    doubts_jump: int = 0
    close: set[int] = field(default_factory=set)            # cadenas asignadas con otra jugadora casi empatada
    excluded: int = 0       # pares cadena-jugadora vetados por la exclusión (solo con exclusive=True)

    @property
    def doubts(self) -> int:
        return self.doubts_cost + self.doubts_close + self.doubts_overlap + self.doubts_jump


def transition_cost(a: Chain, c: Chain, fps: float, link_p: dict[tuple[int, int], float]) -> float:
    """Costo de que c siga a a en la misma persona; inf si no es posible."""
    dt = (c.start - a.end) / fps
    if dt <= 0:
        return np.inf
    ea, sc = _finite_end(a.tl, True), _finite_end(c.tl, False)
    if ea is None or sc is None:
        return np.inf
    gap = np.array([sc.xm - ea.xm, sc.ym - ea.ym])
    d = float(np.hypot(*gap))
    reach = TEAM_S0_MS * dt + LINK_SLACK_M
    if d > reach:
        return np.inf
    p = link_p.get((a.last, c.first))
    model = -np.log(min(max(p, 1e-3), 1 - 1e-6)) if p is not None else PRIOR_COST + GAP_COST_S * dt
    phys = PHYS_W * (d / reach) ** 2
    if dt <= 3.0:
        excess = accel_excess(dt, gap, *_velocity_at(a.tl, fps, True), *_velocity_at(c.tl, fps, False))
        if excess > 0:
            phys += ACCEL_PENALTY + excess
    return float(model + phys)


def _reaches(c: Chain, nxt: Chain | None, fps: float) -> bool:
    if nxt is None:
        return True
    if c.end >= nxt.start:
        return False
    e, s = _finite_end(c.tl, True), _finite_end(nxt.tl, False)
    if e is None or s is None:
        return True
    return np.hypot(s.xm - e.xm, s.ym - e.ym) <= TEAM_S0_MS * (nxt.start - c.end) / fps + LINK_SLACK_M


def fill_between(chs: list[Chain], anchors: dict[int, int], fps: float, link_p: dict[tuple[int, int], float],
                 team_of_person: dict[int, str], allowed: set[int] | None = None, unnamed_cost: float = UNNAMED_COST,
                 check: bool = True, extra_cost=None, exclusive: bool = False) -> Fill:
    """Reparte las cadenas entre las jugadoras ancladas, hacia delante en el tiempo y todas a la vez (húngaro por
    ventanas de WINDOW_S). `allowed`: cadenas que pueden ser de jugadora (las demás se quedan solas).
    `exclusive` (variante B): una jugadora no puede recibir una cadena que se solape en el tiempo con otra suya (sus anclas
    cuentan desde el principio: el ancla manda); la cadena vetada queda libre para otra jugadora o sin nombre."""
    by_id = {c.id: c for c in chs}
    anchor_list: dict[int, list[Chain]] = {}
    for cid, person in anchors.items():
        anchor_list.setdefault(person, []).append(by_id[cid])
    for v in anchor_list.values():
        v.sort(key=lambda c: c.start)
    next_idx = {p: 0 for p in anchor_list}
    tail: dict[int, Chain] = {}
    res = Fill(owner=dict(anchors))
    order = sorted(chs, key=lambda c: c.start)
    i = 0
    win = WINDOW_S * fps
    busy: dict[int, list[tuple[int, int]]] = {p: [(c.start, c.end) for c in v] for p, v in anchor_list.items()}

    def next_anchor(person: int) -> Chain | None:
        lst = anchor_list[person]
        k = next_idx[person]
        return lst[k] if k < len(lst) else None

    while i < len(order):
        c0 = order[i]
        if c0.id in anchors:
            person = anchors[c0.id]
            tail[person] = c0 if person not in tail or c0.end > tail[person].end else tail[person]
            next_idx[person] += 1
            i += 1
            continue
        batch = []
        while i < len(order) and order[i].start < c0.start + win and order[i].id not in anchors:
            c = order[i]
            if allowed is None or c.id in allowed:
                batch.append(c)
            i += 1
        players = list(tail)
        if not batch or not players:
            continue
        big = 1e9
        M = np.full((len(batch), len(players) + len(batch)), big)
        for r, c in enumerate(batch):
            M[r, len(players) + r] = unnamed_cost
            for k, person in enumerate(players):
                if c.team != "unk" and team_of_person.get(person, c.team) != c.team:
                    continue
                if not _reaches(c, next_anchor(person), fps):
                    continue
                if exclusive and overlaps(c, busy.get(person, ())):
                    res.excluded += 1
                    continue
                # extra_cost(chain_id, person): costo opcional por par (p. ej. team_seq).
                M[r, k] = transition_cost(tail[person], c, fps, link_p) + (extra_cost(c.id, person) if extra_cost else 0.0)
        M[~np.isfinite(M)] = big
        rows_, cols = linear_sum_assignment(M)
        for r, k in zip(rows_, cols):
            if k >= len(players) or M[r, k] >= unnamed_cost:
                continue
            c, person = batch[r], players[k]
            res.owner[c.id] = person
            res.cost[c.id] = float(M[r, k])
            tail[person] = c
            busy.setdefault(person, []).append((c.start, c.end))
            row = np.sort(M[r, : len(players)])
            if M[r, k] > DOUBT_COST:
                res.doubts_cost += 1
            elif len(row) > 1 and row[1] < big and row[1] - row[0] < DOUBT_MARGIN:
                res.doubts_close += 1
                res.close.add(c.id)
    if check:
        check_sequences(chs, res, fps)
    return res


def overlaps(c: Chain, intervals) -> bool:
    """Si la cadena comparte algún cuadro con alguno de los intervalos (inicio, fin) dados."""
    return any(c.start <= e and s <= c.end for s, e in intervals)


def check_sequences(chs: list[Chain], res: Fill, fps: float) -> None:
    """Dudas sobre la secuencia final de cada persona: dos sitios a la vez y saltos imposibles."""
    by_id = {c.id: c for c in chs}
    seqs: dict[int, list[Chain]] = {}
    for cid, person in res.owner.items():
        seqs.setdefault(person, []).append(by_id[cid])
    for person, seq in seqs.items():
        seq.sort(key=lambda c: c.start)
        for a, b in zip(seq, seq[1:]):
            if b.start <= a.end:
                res.doubts_overlap += 1
                continue
            e, s = _finite_end(a.tl, True), _finite_end(b.tl, False)
            if e is None or s is None:
                continue
            dt = (b.start - a.end) / fps
            gap = np.array([s.xm - e.xm, s.ym - e.ym])
            if np.hypot(*gap) > TEAM_S0_MS * dt + LINK_SLACK_M or (
                    dt <= 3.0 and accel_excess(dt, gap, *_velocity_at(a.tl, fps, True), *_velocity_at(b.tl, fps, False)) > 0):
                res.doubts_jump += 1


def _mirror(c: Chain) -> Chain:
    boxes = [Box(**{**b.__dict__, "frame": -b.frame}) for b in reversed(c.tl.boxes)]
    return Chain(c.id, Tracklet(id=-1, track=c.tl.track, boxes=boxes), c.last, c.first, c.team)


def fill_both(chs: list[Chain], anchors: dict[int, int], fps: float, link_p: dict[tuple[int, int], float],
              team_of_person: dict[int, str], allowed: set[int] | None = None, unnamed_cost: float = UNNAMED_COST,
              extra_cost=None, exclusive: bool = False) -> Fill:
    """Relleno hacia delante desde cada ancla y, después, hacia atrás desde la primera ancla de cada jugadora (en el
    tiempo invertido, solo con las cadenas que quedaron sin nombre y que terminan antes de esa primera ancla)."""
    fwd = fill_between(chs, anchors, fps, link_p, team_of_person, allowed, unnamed_cost, check=False, extra_cost=extra_cost,
                       exclusive=exclusive)
    by_id = {c.id: c for c in chs}
    first: dict[int, Chain] = {}
    for cid, person in anchors.items():
        if person not in first or by_id[cid].start < first[person].start:
            first[person] = by_id[cid]
    if first:
        cut = max(c.start for c in first.values())
        free = {c.id for c in chs if c.id not in fwd.owner and c.start < cut and (allowed is None or c.id in allowed)}
        mirrored = [_mirror(c) for c in chs if c.id in free or c.id in {f.id for f in first.values()}]
        back_link = {(b, a): p for (a, b), p in link_p.items()}
        # Each person may only take chains before its own first anchor: in mirrored time, after it. A chain that starts
        # before another person's first anchor but after this one's is filtered after the pass.
        bwd = fill_between(mirrored, {c.id: p for p, c in first.items()}, fps, back_link, team_of_person, None, unnamed_cost, check=False,
                           extra_cost=extra_cost, exclusive=exclusive)
        busy: dict[int, list[tuple[int, int]]] = {}
        if exclusive:
            for cid, person in fwd.owner.items():
                busy.setdefault(person, []).append((by_id[cid].start, by_id[cid].end))
            fwd.excluded += bwd.excluded
        for cid, person in bwd.owner.items():
            if cid in fwd.owner or by_id[cid].end >= first[person].start:
                continue
            if exclusive:
                if overlaps(by_id[cid], busy.get(person, ())):
                    fwd.excluded += 1
                    continue
                busy.setdefault(person, []).append((by_id[cid].start, by_id[cid].end))
            fwd.owner[cid] = person
            fwd.cost[cid] = bwd.cost.get(cid, 0.0)
        fwd.doubts_cost += bwd.doubts_cost
        fwd.doubts_close += bwd.doubts_close
        fwd.close |= {cid for cid in bwd.close if cid in fwd.owner}
    check_sequences(chs, fwd, fps)
    return fwd


def groups_after_fill(chs: list[Chain], owner: dict[int, int]) -> dict[tuple[int, int], int]:
    out = {}
    for c in chs:
        g = NAMED_OFFSET + owner[c.id] if c.id in owner else c.id
        for b in c.tl.boxes:
            out[(b.frame, b.track)] = g
    return out


def named_correct(chs: list[Chain], owner: dict[int, int], truth: dict, people: set[int]) -> tuple[int, int, int]:
    """Cajas de las jugadoras medidas: total, con su nombre correcto, con el nombre de otra."""
    tot = ok = bad = 0
    for c in chs:
        o = owner.get(c.id)
        for b in c.tl.boxes:
            v = truth.get((b.frame, b.track))
            if v in people:
                tot += 1
                if o is not None:
                    ok += o == v
                    bad += o != v
    return tot, ok, bad


# --------------------------------------------------------------------------------------------- evaluación

def _fit(Xs, ys) -> TreeModel:
    X, y = np.vstack(Xs), np.concatenate(ys)
    k = y >= 0
    return TreeModel().fit(X[k], y[k].astype(float))


def main(argv: list[str] | None = None) -> None:
    import sys

    from sportsan.config import load_config, project_root
    from sportsan.tracking.links_eval import _venue, load_part, named_parts

    sys.stdout.reconfigure(encoding="utf-8")
    argv = sys.argv[1:] if argv is None else argv
    if argv and argv[0] in ("suggest", "fill"):       # modo real: ver anchors_cli.py
        from sportsan.tracking.anchors_cli import cli

        return cli(argv)
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--match")
    ap.add_argument("--train", default="v1_6414_13699,v1_14541_15944,v1_16648_22211,v1_23140_26173,v1_26910_32826,v1_33818_35062,v1_36135_41389")
    ap.add_argument("--test", default="v1_41994_43460,v1_44071_52064,v1_52933_72647,v1_73385_78596")
    ap.add_argument("--test2", default="v2_0_4259,v2_5020_10226,v3_0_6890", help="partes completas de otro ángulo")
    ap.add_argument("--p-min", type=float, default=LINK_P_MIN)
    ap.add_argument("--rates", default="1,2,3")
    ap.add_argument("--costs", default="2,3,4,6,9,12,16", help="valores de unnamed_cost a barrer")
    ap.add_argument("--feet", action="store_true")
    ap.add_argument("--report", default="anclas_f3.md")
    ap.add_argument("--reid", default="", choices=["", "classic", "onnx"], help="similitud de apariencia (reid.py) como variable extra del modelo de unión")
    ap.add_argument("--reid-hmin", type=float, default=0.0, help="alto mínimo (px) de las dos cajas para usar la similitud")
    args = ap.parse_args(argv)
    cfg = load_config(match=args.match)
    dir_ = project_root() / cfg["paths"]["tracking_dir"]
    avail = set(named_parts(dir_))
    split = lambda s: [p for p in s.split(",") if p in avail]  # noqa: E731
    train, test, test2 = split(args.train), split(args.test), split(args.test2)
    names = train + test + test2
    print(f"Entrenamiento {train}\nPrueba {test}\nPrueba 2 {test2}")
    parts = {n: load_part(dir_, n, args.feet) for n in names}
    tl, pdata, ldata = {}, {}, {}
    for n in names:
        p = parts[n]
        tl[n] = pure_tracklets(p.frames, p.fps)
        L, W = _venue(dir_, n)
        pdata[n] = (np.array([player_features(t, L, W, p.fps) for t in tl[n]]), player_labels(tl[n], p.truth))
        cands = link_candidates(tl[n], p.fps)
        X = np.array([c.x for c in cands]) if cands else np.zeros((0, len(FEATURES)))
        if args.reid:
            from sportsan.tracking.reid import part_reid, reid_column

            V, H = part_reid(dir_, args.match, n, p, tl[n], args.reid)
            X = np.hstack([X, reid_column(cands, V, H, args.reid_hmin)[:, None]]) if cands else np.zeros((0, len(FEATURES) + 1))
        ldata[n] = (cands, X, candidate_labels(cands, tl[n], p.truth))
    pm = _fit([pdata[m][0] for m in train], [pdata[m][1] for m in train])
    lm = _fit([ldata[m][1] for m in train], [ldata[m][2] for m in train])
    rates = [float(r) for r in args.rates.split(",")]
    costs = [float(u) for u in args.costs.split(",")]

    def run(n: str):
        p = parts[n]
        labels = json.loads((dir_ / f"labels_{n}.json").read_text(encoding="utf-8"))
        team_of_label = {int(x["label"]): x.get("team") or "unk" for x in labels["people"]}
        people = {int(x["label"]) for x in labels["people"] if x.get("named") and x.get("team") == "own"}
        cands, X, _ = ldata[n]
        for c, pr in zip(cands, lm.predict(X)):
            c.p = float(pr)
        player_ok = {t.id for t, pp in zip(tl[n], pm.predict(pdata[n][0])) if pp >= 0.5}
        links = accept_greedy(cands, p_min=args.p_min, allowed=player_ok)
        link_p = {(c.a, c.b): c.p for c in cands}

        def team_of(t: Tracklet) -> str:
            who, _ = tracklet_truth(t, p.truth)
            return team_of_label.get(who, t.team) if isinstance(who, int) else t.team

        chs = build_chains(tl[n], links, team_of)
        allowed = {c.id for c in chs if c.first in player_ok}
        rows = {r[0].frame: r for r in p.frames if r}
        frames = sorted(rows)
        base = score_groups(groups_after_fill(chs, {}), p.truth)
        out = {"minutes": p.seconds / 60, "people": len(people), "phase1": base}
        for k in rates:
            anchors, empty = pick_anchors(chs, p.truth, rows, p.fps, frames[0], frames[-1] + 1, k, people)
            for u in costs:
                f = fill_both(chs, anchors, p.fps, link_p, team_of_label, allowed, u)
                sc = score_groups(groups_after_fill(chs, f.owner), p.truth)
                tot, ok, bad = named_correct(chs, f.owner, p.truth, people)
                out[(u, k)] = dict(anchors=len(anchors), empty=empty, score=sc, tot=tot, ok=ok, bad=bad, fill=f)
        return out

    res = {n: run(n) for n in names if n not in train}

    def total(group: list[str], key) -> dict:
        a = dict(anchors=0, empty=0, tot=0, ok=0, bad=0, score=Score(), d=[0, 0, 0, 0], minutes=0.0)
        for n in group:
            a["minutes"] += res[n]["minutes"]
            if key is None:
                a["score"] = a["score"].add(res[n]["phase1"])
                continue
            r = res[n][key]
            f = r["fill"]
            for x in ("anchors", "empty", "tot", "ok", "bad"):
                a[x] += r[x]
            a["score"] = a["score"].add(r["score"])
            a["d"] = [x + y for x, y in zip(a["d"], [f.doubts_cost, f.doubts_close, f.doubts_overlap, f.doubts_jump])]
        return a

    def hours(a: dict) -> tuple[float, float]:
        scale = MATCH_MIN / a["minutes"] / 3600
        h = (SECONDS_PER_ANCHOR * a["anchors"] + SECONDS_PER_DOUBT * sum(a["d"])) * scale
        return h, h + SECONDS_PER_PENDING * (a["score"].joins_needed + a["score"].cuts_needed) * scale

    def row(name: str, k, a: dict) -> str:
        sc, d = a["score"], a["d"]
        h, h2 = hours(a)
        return (f"| {name} | {k:g} | {a['anchors']} | {a['empty']} | {100 * sc.purity:.2f} % | {100 * a['ok'] / max(1, a['tot']):.1f} % | "
                f"{100 * a['bad'] / max(1, a['tot']):.2f} % | {sc.joins_needed} | {sc.cuts_needed} | {sum(d)} ({' / '.join(map(str, d))}) | {h:.2f} | {h2:.2f} |")

    head = ["| Parte | Anclas/min | Anclas | Tramos sin ancla posible | Pureza | Cajas con nombre correcto | Con nombre de otra | Uniones pend. | Cortes pend. | Dudas (costo / empate / dos sitios / salto) | h (anclas + dudas) | h (+ pendientes) |",
            "|---|---|---|---|---|---|---|---|---|---|---|---|"]
    # Choice of unnamed_cost on the v1 test parts at the highest rate: highest purity without leaving more pending
    # actions than phase 1 alone.
    sel_group = test or test2
    kmax = max(rates)
    base = total(sel_group, None)["score"]

    def pend(s: Score) -> int:
        return s.joins_needed + s.cuts_needed

    ok_u = [u for u in costs if pend(total(sel_group, (u, kmax))["score"]) <= pend(base)] or costs
    chosen = max(ok_u, key=lambda u: total(sel_group, (u, kmax))["score"].purity)
    lines = [f"# Anclas y relleno entre anclas (F3) · {cfg.get('match_id', args.match)}", "",
             f"Fase 1 al umbral {args.p_min} (`LINK_P_MIN`), pies {'corregidos (feet.py)' if args.feet else 'sin corregir'}. "
             f"Modelos de unión y de «¿es jugadora?» entrenados con {len(train)} partes de v1: {', '.join(train)}.", "",
             "Anclas simuladas desde la verdad: por jugadora propia con nombre y por tramo de 60/k s, la cadena más larga de ella "
             f"(≥ {ANCHOR_MIN_S:.0f} s, nadie a < {ANCHOR_ISOLATION_M:.0f} m en su cuadro central). Relleno hacia delante desde cada "
             "ancla y hacia atrás desde la primera, todas las jugadoras a la vez (húngaro por ventanas de 1 s). Equipo de cada "
             "cadena tomado de labels (supone una F2 perfecta). Rivales: no tienen nombre en la verdad, no se miden.", "",
             f"Horas llevadas a un partido de {MATCH_MIN:.0f} min: «h (anclas + dudas)» = {SECONDS_PER_ANCHOR:.0f} s × ancla + "
             f"{SECONDS_PER_DOUBT:.0f} s × duda; «h (+ pendientes)» suma {SECONDS_PER_PENDING:.0f} s por cada unión o corte pendiente. "
             "Criterio F3: ≤ 4 h con 3 anclas/min.", "",
             "## Barrido del costo de dejar una cadena sin nombre (`unnamed_cost`)", "",
             f"Se elige con la prueba de v1 a {kmax:g} anclas/min: la mayor pureza sin dejar más uniones + cortes pendientes que la "
             f"fase 1 sola. **Elegido: {chosen:g}.** v2/v3 no se usan para elegir.", "",
             "| Partes | unnamed_cost | Anclas/min | Pureza | Nombre correcto | Nombre de otra | Pendientes | Dudas | h (anclas + dudas) | h (+ pendientes) |",
             "|---|---|---|---|---|---|---|---|---|---|"]
    for lbl, g in (("v1 prueba", test), ("v2+v3", test2)):
        if not g:
            continue
        b = total(g, None)["score"]
        lines.append(f"| {lbl} | solo fase 1 | — | {100 * b.purity:.2f} % | — | — | {pend(b)} | — | — | — |")
        for k in rates:
            for u in costs:
                a = total(g, (u, k))
                h, h2 = hours(a)
                lines.append(f"| {lbl} | {u:g}{' ←' if u == chosen else ''} | {k:g} | {100 * a['score'].purity:.2f} % | {100 * a['ok'] / max(1, a['tot']):.1f} % | "
                             f"{100 * a['bad'] / max(1, a['tot']):.2f} % | {pend(a['score'])} | {sum(a['d'])} | {h:.2f} | {h2:.2f} |")
    lines.append("")
    verdict = {}
    for label, group in (("Prueba v1 (4 partes)", test), ("Prueba v2 y v3 (otro ángulo)", test2)):
        if not group:
            continue
        b = total(group, None)["score"]
        lines += [f"## {label} · {total(group, None)['minutes']:.1f} min · unnamed_cost {chosen:g}", "",
                  f"Solo fase 1: pureza {100 * b.purity:.2f} %, uniones pendientes {b.joins_needed}, cortes pendientes {b.cuts_needed}.", ""] + head
        for k in rates:
            for n in group:
                lines.append(row(n, k, total([n], (chosen, k))))
            a = total(group, (chosen, k))
            lines.append(row("**total**", k, a))
            verdict[(label, k)] = (hours(a), a["score"].purity, b.purity)
        lines.append("")
    lines += ["## Veredicto", ""]
    for (label, k), ((h, h2), pur, pur1) in verdict.items():
        if k == kmax:
            lines.append(f"- {label}, {k:g} anclas/min: {h:.2f} h solo anclas y dudas, {h2:.2f} h con pendientes "
                         f"({'cumple' if h2 <= 4 else 'no cumple'} ≤ 4 h contando pendientes). Pureza {100 * pur:.2f} % "
                         f"(fase 1 sola {100 * pur1:.2f} %).")
    lines += ["", "Para repetir con la fase 1 a 0.9: `python -m sportsan.tracking.anchors --feet --p-min 0.9 --report anclas_f3_09.md`.",
              "No probado: el tiempo real por ancla, por duda y por pendiente (2 s y 3 s son supuestos).", ""]
    out = dir_ / "revision" / args.report
    out.parent.mkdir(exist_ok=True)
    out.write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines))
    print(f"\nInforme: {out}")


if __name__ == "__main__":
    main()

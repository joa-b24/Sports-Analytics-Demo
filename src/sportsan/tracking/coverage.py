"""Informe de cobertura y de tiempo de la analista sobre la salida de `anchors` (fase 1 + pies + relleno F3).

Mide lo que importa a la analista, no uniones pendientes. Por parte y por jugadora propia con nombre (en `labels_*.json`):

a) COBERTURA = segundos con la identidad correcta / segundos que estuvo en cuadro según labels. Cuenta como correcto un
   cuadro cuya caja tiene su nombre, y un cuadro sin nombre dentro de un hueco de hasta `BRIDGE_MAX_S` entre dos cadenas
   de la misma jugadora (nombre y verdad coinciden) que una persona pudo recorrer (velocidad S0 = 8.5 m/s, aceleración
   A0 = 7 m/s², como `accel_excess`): ahí la posición se rellena por interpolación y el hueco no es un error.
b) ERRORES: segundos de la jugadora con el nombre de otra.
c) HUECOS que quedan (cuadros en cuadro, sin nombre y sin puente) por duración: ≤ 4 s, 4-15 s, > 15 s, y cuántos son por
   salir de cuadro. Regla de fuera de cámara: la misma de `offCamera` (web/lib/tracks.ts): la jugadora tiene la caja a
   menos de EDGE_SHARE (3 %) del borde de la imagen justo antes de perderla o justo después de volver a encontrarla. Aquí
   se mira su caja (según labels) en los extremos del hueco y en los cuadros vecinos. Es una aproximación: en la app la
   regla usa la identidad corregida, aquí la verdad.

TIEMPO DE LA ANALISTA (meta <= 8 h por partido): anclas x 2 s + revisión final: saltos imposibles que quedan x 3 s +
huecos > 4 s que no son por fuera de cuadro x 3 s + cambios de jugadora sin identificar (cadenas de mi equipo, de
jugadora, sin nombre, >= 3 s, que no son de una jugadora medida: los entrantes) x 3 s. Se reporta con 1, 2 y 3 anclas/min y se
escala linealmente a 90 min. El entrenamiento del modelo no cuenta.

    python -m sportsan.tracking.coverage --match 2026_09_25_tec_ccm_vs_anahuac
"""
from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass, field

import numpy as np

from sportsan.tracking.anchors import (
    ANCHOR_ISOLATION_M,
    ANCHOR_MIN_S,
    MATCH_MIN,
    SECONDS_PER_ANCHOR,
    HYBRID_RATES,
    UNNAMED_COST,
    ZONES,
    Chain,
    _finite_end,
    build_chains,
    camera_sign,
    fill_both,
    person_hybrid_rates,
    pick_anchors,
)
from sportsan.tracking.tracklets import (
    ACCEL_NOISE_M,
    FEATURES,
    LINK_P_MIN,
    TEAM_S0_MS,
    Box,
    Tracklet,
    TreeModel,
    _velocity_at,
    accel_excess,
    accept_greedy,
    candidate_labels,
    link_candidates,
    player_features,
    player_labels,
    pure_tracklets,
    tracklet_truth,
)

BRIDGE_MAX_S = 4.0
HOLE_SHORT_S = 4.0
HOLE_LONG_S = 15.0
EDGE_SHARE = 0.03               # como web/lib/tracks.ts
UNIDENTIFIED_MIN_S = 3.0
SECONDS_PER_REVIEW = 3.0        # salto imposible, hueco > 4 s o cambio sin identificar
GAP_FACTOR = 1.5                # dos cuadros de la verdad separados más de esto (en pasos) rompen un hueco

OK, FILL, ERR, HOLE = "ok", "fill", "err", "hole"


# ------------------------------------------------------------------------------------------ funciones puras

def bridge_possible(a: Chain, b: Chain, fps: float, max_s: float = BRIDGE_MAX_S) -> bool:
    """Una persona pudo ir del final de `a` al inicio de `b` (hueco de hasta `max_s`): distancia <= S0 x dt (más el ruido
    de posición) y, con huecos de hasta 3 s, sin una aceleración imposible (A0)."""
    dt = (b.start - a.end) / fps
    if dt <= 0 or dt > max_s:
        return False
    ea, sb = _finite_end(a.tl, True), _finite_end(b.tl, False)
    if ea is None or sb is None:
        return False
    gap = np.array([sb.xm - ea.xm, sb.ym - ea.ym])
    if float(np.hypot(*gap)) > TEAM_S0_MS * dt + ACCEL_NOISE_M:
        return False
    if dt <= 3.0 and accel_excess(dt, gap, *_velocity_at(a.tl, fps, True), *_velocity_at(b.tl, fps, False)) > 0:
        return False
    return True


def bridges(chains_of_person: list[Chain], fps: float, max_s: float = BRIDGE_MAX_S) -> list[tuple[int, int]]:
    """Huecos (cuadro final de una cadena, cuadro inicial de la siguiente) entre cadenas consecutivas de la misma
    jugadora que se pueden rellenar por interpolación."""
    seq = sorted(chains_of_person, key=lambda c: c.start)
    return [(a.end, b.start) for a, b in zip(seq, seq[1:]) if bridge_possible(a, b, fps, max_s)]


def frame_status(in_frame: list[int], owner_at: dict[int, int | None], person: int, spans: list[tuple[int, int]]) -> dict[int, str]:
    """Estado de cada cuadro en que `person` sale según labels: ok (lleva su nombre), err (nombre de otra), fill (sin nombre
    pero dentro de un hueco con puente posible) o hole."""
    out = {}
    for f in in_frame:
        o = owner_at.get(f)
        if o == person:
            out[f] = OK
        elif o is not None:
            out[f] = ERR
        elif any(a < f < b for a, b in spans):
            out[f] = FILL
        else:
            out[f] = HOLE
    return out


def hole_runs(status: dict[int, str], step: int) -> list[tuple[int, int, int]]:
    """Tramos de cuadros seguidos en estado hole: (primer cuadro, último, número de cuadros). Un salto en los cuadros con
    verdad mayor que GAP_FACTOR x paso (la jugadora salió de cuadro según labels) o cualquier otro estado los corta."""
    frames = sorted(status)
    runs: list[tuple[int, int, int]] = []
    cur: list[int] = []
    for f in frames:
        if status[f] != HOLE or (cur and f - cur[-1] > GAP_FACTOR * step):
            if cur:
                runs.append((cur[0], cur[-1], len(cur)))
            cur = []
        if status[f] == HOLE:
            cur.append(f)
    if cur:
        runs.append((cur[0], cur[-1], len(cur)))
    return runs


def at_edge(box: Box, width: float, height: float, share: float = EDGE_SHARE) -> bool:
    m = share * width
    return box.x1 <= m or box.y1 <= m or box.x2 >= width - m or box.y2 >= height - m


def hole_class(seconds: float) -> str:
    return "≤4" if seconds <= HOLE_SHORT_S else "4-15" if seconds <= HOLE_LONG_S else ">15"


@dataclass
class PersonCov:
    in_s: float = 0.0
    ok_s: float = 0.0
    fill_s: float = 0.0
    err_s: float = 0.0
    hole_s: float = 0.0
    holes: list[tuple[float, bool]] = field(default_factory=list)   # (segundos, por fuera de cuadro)

    @property
    def coverage(self) -> float:
        return (self.ok_s + self.fill_s) / self.in_s if self.in_s else float("nan")

    def add(self, o: "PersonCov") -> "PersonCov":
        return PersonCov(self.in_s + o.in_s, self.ok_s + o.ok_s, self.fill_s + o.fill_s, self.err_s + o.err_s,
                         self.hole_s + o.hole_s, self.holes + o.holes)

    def holes_by_class(self) -> dict[str, tuple[int, int]]:
        """Clase -> (número de huecos, de ellos por fuera de cuadro)."""
        out = {"≤4": [0, 0], "4-15": [0, 0], ">15": [0, 0]}
        for s, edge in self.holes:
            c = out[hole_class(s)]
            c[0] += 1
            c[1] += int(edge)
        return {k: (v[0], v[1]) for k, v in out.items()}

    def holes_to_review(self) -> int:
        """Huecos > 4 s que no son por fuera de cuadro: los que la analista tendría que mirar."""
        return sum(1 for s, edge in self.holes if s > HOLE_SHORT_S and not edge)


def person_coverage(person: int, in_frame: list[int], owner_at: dict[int, int | None], spans: list[tuple[int, int]],
                    edge_at: "callable[[int], bool]", step: int, fps: float) -> PersonCov:
    """Cobertura de una jugadora. `in_frame`: cuadros procesados en que sale (labels); `owner_at`: cuadro -> nombre que le
    dio el sistema a su caja; `spans`: puentes posibles; `edge_at(cuadro)`: su caja en ese cuadro está en el borde;
    `step`: cuadros entre dos procesados."""
    frames = sorted(in_frame)
    st = frame_status(frames, owner_at, person, spans)
    sec = step / fps
    c = PersonCov(in_s=len(frames) * sec)
    for s in st.values():
        if s == OK:
            c.ok_s += sec
        elif s == FILL:
            c.fill_s += sec
        elif s == ERR:
            c.err_s += sec
        else:
            c.hole_s += sec
    idx = {f: i for i, f in enumerate(frames)}
    for f0, f1, n in hole_runs(st, step):
        i0, i1 = idx[f0], idx[f1]
        around = [frames[i] for i in (i0 - 1, i0, i1, i1 + 1) if 0 <= i < len(frames)]
        c.holes.append((n * sec, any(edge_at(f) for f in around)))
    return c


def review_seconds(anchors: int, jumps: int, holes: int, unidentified: int) -> float:
    """Segundos de la analista: anclas x 2 s + (saltos + huecos + cambios sin identificar) x 3 s."""
    return SECONDS_PER_ANCHOR * anchors + SECONDS_PER_REVIEW * (jumps + holes + unidentified)


def to_match_hours(seconds: float, measured_s: float, match_min: float = MATCH_MIN) -> float:
    """Escala lineal de lo medido en `measured_s` segundos de video a un partido de `match_min` minutos."""
    return seconds * (match_min * 60 / measured_s) / 3600 if measured_s > 0 else float("nan")


def unidentified_changes(chs: list[Chain], owner: dict[int, int], truth: dict, people: set[int], allowed: set[int] | None,
                         fps: float, own: str = "own") -> int:
    """Cadenas de mi equipo, de jugadora, sin nombre y de >= UNIDENTIFIED_MIN_S cuya verdad no es una jugadora medida
    (las que sí lo son ya salen como hueco)."""
    n = 0
    for c in chs:
        if c.id in owner or c.team != own or (allowed is not None and c.id not in allowed):
            continue
        if (c.end - c.start) / fps < UNIDENTIFIED_MIN_S:
            continue
        who, _ = tracklet_truth(c.tl, truth)
        if who not in people:
            n += 1
    return n


# --------------------------------------------------------------------------------------------- medición

@dataclass
class PartResult:
    name: str
    seconds: float
    people: dict[int, PersonCov]
    anchors: int
    jumps: int
    overlaps: int
    unidentified: int
    zone_of: dict[int, str] = field(default_factory=dict)   # jugadora -> franja (cercana/centro/lejana)
    by_zone: dict = field(default_factory=dict)
    zone_people: dict = field(default_factory=dict)

    @property
    def total(self) -> PersonCov:
        t = PersonCov()
        for p in self.people.values():
            t = t.add(p)
        return t

    def zone_total(self, zone: str) -> PersonCov:
        t = PersonCov()
        for p, c in self.people.items():
            if self.zone_of.get(p) == zone:
                t = t.add(c)
        return t

    def review_s(self, with_overlaps: bool = False) -> float:
        return review_seconds(self.anchors, self.jumps + (self.overlaps if with_overlaps else 0),
                              self.total.holes_to_review(), self.unidentified)


def measure(chs: list[Chain], owner: dict[int, int], truth: dict, people: set[int], frames: list[list[Box]], fps: float,
            image_wh: tuple[float, float]) -> dict[int, PersonCov]:
    """Cobertura de cada jugadora con nombre dada la asignación `owner` (cadena -> jugadora)."""
    chain_of = {(b.frame, b.track): c for c in chs for b in c.tl.boxes}
    box_at = {(b.frame, b.track): b for row in frames for b in row}
    grid = sorted({row[0].frame for row in frames if row})
    step = int(np.median(np.diff(grid))) if len(grid) > 1 else 1
    by_person_chain: dict[int, list[Chain]] = {p: [] for p in people}
    for c in chs:
        o = owner.get(c.id)
        if o in people and tracklet_truth(c.tl, truth)[0] == o:
            by_person_chain[o].append(c)
    out = {}
    for p in sorted(people):
        track_at = {k[0]: k[1] for k, v in truth.items() if v == p}
        owner_at = {f: (owner.get(chain_of[(f, t)].id) if (f, t) in chain_of else None) for f, t in track_at.items()}

        def edge_at(f: int, track_at=track_at) -> bool:
            b = box_at.get((f, track_at[f]))
            return b is not None and at_edge(b, *image_wh)

        out[p] = person_coverage(p, list(track_at), owner_at, bridges(by_person_chain[p], fps), edge_at, step, fps)
    return out


def _sum_cov(items) -> PersonCov:
    t = PersonCov()
    for c in items:
        t = t.add(c)
    return t


def fmt_pct(x: float) -> str:
    return "—" if x != x else f"{100 * x:.1f} %"


def _fit(Xs, ys) -> TreeModel:
    X, y = np.vstack(Xs), np.concatenate(ys)
    k = y >= 0
    return TreeModel().fit(X[k], y[k].astype(float))


def chosen_unnamed_cost(dir_, report: str = "anclas_f3.md") -> float:
    """El `unnamed_cost` elegido por anchors (línea «Elegido: X» de su informe); UNNAMED_COST si no hay informe."""
    p = dir_ / "revision" / report
    if p.exists():
        m = re.search(r"\*\*Elegido:\s*([0-9.]+)", p.read_text(encoding="utf-8"))
        if m:
            return float(m[1])
    return UNNAMED_COST


def main(argv: list[str] | None = None) -> None:
    import sys

    from sportsan.config import load_config, project_root
    from sportsan.tracking.links_eval import _venue, load_part, named_parts

    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--match")
    ap.add_argument("--train", default="v1_6414_13699,v1_14541_15944,v1_16648_22211,v1_23140_26173,v1_26910_32826,v1_33818_35062,v1_36135_41389")
    ap.add_argument("--test", default="v1_41994_43460,v1_44071_52064,v1_52933_72647,v1_73385_78596")
    ap.add_argument("--test2", default="v2_0_4259,v2_5020_10226,v3_0_6890")
    ap.add_argument("--p-min", type=float, default=LINK_P_MIN)
    ap.add_argument("--rates", default="1,2,3", help="densidades a comparar: números y/o «hybrid» (cuota por franja: --near/--center/--far)")
    ap.add_argument("--near", type=float, default=HYBRID_RATES["near"])
    ap.add_argument("--center", type=float, default=HYBRID_RATES["center"])
    ap.add_argument("--far", type=float, default=HYBRID_RATES["far"])
    ap.add_argument("--zones", choices=["thirds", "quantiles"], default="thirds", help="cortes de franja para hybrid")
    ap.add_argument("--unnamed-cost", type=float, default=None, help="por defecto el elegido en anclas_f3.md")
    ap.add_argument("--no-feet", action="store_true")
    ap.add_argument("--report", default="cobertura.md")
    args = ap.parse_args(argv)
    cfg = load_config(match=args.match)
    dir_ = project_root() / cfg["paths"]["tracking_dir"]
    avail = set(named_parts(dir_))
    split = lambda s: [p for p in s.split(",") if p in avail]  # noqa: E731
    train, test, test2 = split(args.train), split(args.test), split(args.test2)
    names = train + test + test2
    ucost = args.unnamed_cost if args.unnamed_cost is not None else chosen_unnamed_cost(dir_)
    rates = [r.strip() if r.strip() == "hybrid" else float(r) for r in args.rates.split(",") if r.strip()]
    zone_rates = {"near": args.near, "center": args.center, "far": args.far}
    lab = lambda k: k if isinstance(k, str) else f"{k:g}"  # noqa: E731
    from sportsan.tracking.anchors_cli import Progress

    pg = Progress(dir_ / "revision" / f"progreso_{args.report.rsplit('.', 1)[0]}.log")
    feet = not args.no_feet
    print(f"Entrenamiento {train}\nPrueba {test}\nPrueba 2 {test2}\nunnamed_cost {ucost:g}")

    parts, tl, pdata, ldata = {}, {}, {}, {}
    for i, n in enumerate(names):
        pg.log("carga y modelos", i, len(names))
        p = parts[n] = load_part(dir_, n, feet)
        tl[n] = pure_tracklets(p.frames, p.fps)
        L, W = _venue(dir_, n)
        pdata[n] = (np.array([player_features(t, L, W, p.fps) for t in tl[n]]), player_labels(tl[n], p.truth))
        cands = link_candidates(tl[n], p.fps)
        X = np.array([c.x for c in cands]) if cands else np.zeros((0, len(FEATURES)))
        ldata[n] = (cands, X, candidate_labels(cands, tl[n], p.truth))
    pg.log("carga y modelos", len(names), len(names))
    pm = _fit([pdata[m][0] for m in train], [pdata[m][1] for m in train])
    lm = _fit([ldata[m][1] for m in train], [ldata[m][2] for m in train])

    def run(n: str) -> dict[float, PartResult]:
        p = parts[n]
        raw = json.loads((dir_ / f"tracks_{n}.json").read_text(encoding="utf-8"))
        wh = (float(raw.get("image_w") or 1920), float(raw.get("image_h") or 1080))
        del raw
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
        out = {}
        L, W = _venue(dir_, n)
        sign = camera_sign(p.frames)
        h_rates, zones, edges = person_hybrid_rates(chs, p.truth, people, sign, L, W, zone_rates, args.zones)
        side[n] = (sign, edges, zones)
        for k in rates:
            anchors, _ = pick_anchors(chs, p.truth, rows, p.fps, frames[0], frames[-1] + 1, h_rates if k == "hybrid" else k, people)
            f = fill_both(chs, anchors, p.fps, link_p, team_of_label, allowed, ucost)
            out[k] = PartResult(n, p.seconds, measure(chs, f.owner, p.truth, people, p.frames, p.fps, wh), len(anchors),
                                f.doubts_jump, f.doubts_overlap,
                                unidentified_changes(chs, f.owner, p.truth, people, allowed, p.fps), zones)
        return out

    side: dict = {}
    todo = test + test2
    res = {}
    for i, n in enumerate(todo):
        pg.log("simulación por parte", i, len(todo))
        res[n] = run(n)
    pg.log("simulación por parte", len(todo), len(todo))
    groups = [("v1 prueba", test), ("v2 y v3 (otro ángulo)", test2)]

    def agg(group: list[str], k: float) -> PartResult:
        rs = [res[n][k] for n in group]
        t = PersonCov()
        for r in rs:
            t = t.add(r.total)
        pr = PartResult("total", sum(r.seconds for r in rs), {0: t}, sum(r.anchors for r in rs), sum(r.jumps for r in rs),
                        sum(r.overlaps for r in rs), sum(r.unidentified for r in rs))
        pr.by_zone = {z: _sum_cov(r.zone_total(z) for r in rs) for z in ZONES}
        pr.zone_people = {z: sum(1 for r in rs for q in r.people if r.zone_of.get(q) == z) for z in ZONES}
        return pr

    lines = [f"# Cobertura y tiempo de la analista · {cfg.get('match_id', args.match)}", "",
             f"Salida de `anchors`: fase 1 al umbral {args.p_min} (`LINK_P_MIN`), pies {'corregidos (feet.py)' if feet else 'sin corregir'}, "
             f"relleno F3 con `unnamed_cost` = {ucost:g} (el elegido en `anclas_f3.md`). Modelos entrenados con {len(train)} partes de v1 "
             f"({', '.join(train)}); no se usan para medir. Anclas simuladas desde la verdad (≥ {ANCHOR_MIN_S:.0f} s, nadie a < {ANCHOR_ISOLATION_M:.0f} m).", "",
             "Solo se miden las jugadoras propias con nombre en `labels_*.json`; las rivales no tienen nombre en la verdad y no entran "
             "(ni en cobertura ni en el tiempo de revisión, que por eso es una cota baja). El equipo de cada cadena sale de labels (supone una F2 perfecta).", "",
             "## Definiciones", "",
             "- **Cobertura** = segundos con su identidad correcta / segundos en cuadro según labels. Cuenta como correcto un cuadro con su "
             f"nombre y un cuadro sin nombre dentro de un hueco ≤ {BRIDGE_MAX_S:.0f} s entre dos cadenas suyas, rellenable por interpolación "
             f"(distancia ≤ {TEAM_S0_MS} m/s × dt + {ACCEL_NOISE_M:g} m de ruido; con dt ≤ 3 s sin aceleración mayor que A0 = 7 m/s², "
             "`accel_excess`). Ese hueco no es un error.",
             "- **Errores** = segundos con el nombre de otra jugadora.",
             "- **Huecos** = tramos seguidos en cuadro, sin nombre y sin puente. «Por salir de cuadro»: su caja (según labels) está a menos "
             f"del {100 * EDGE_SHARE:.0f} % del borde en un extremo del hueco o en el cuadro vecino (aproximación de `offCamera` de `web/lib/tracks.ts`, "
             "que usa la identidad corregida; aquí la verdad).",
             f"- **Tiempo de la analista** = anclas × {SECONDS_PER_ANCHOR:.0f} s + {SECONDS_PER_REVIEW:.0f} s × (saltos imposibles que quedan + huecos > 4 s no "
             f"por fuera de cuadro + cambios sin identificar: cadenas propias de jugadora, sin nombre, ≥ {UNIDENTIFIED_MIN_S:.0f} s, que no son de una "
             "jugadora medida). «Con dos sitios» suma además las jugadoras asignadas a dos lugares a la vez (también imposibles). "
             f"**Escalado lineal a {MATCH_MIN:.0f} min** desde los minutos medidos (jugadas, no un partido seguido): es una extrapolación, no una medición de un partido. "
             "El entrenamiento del modelo no cuenta. Meta: ≤ 8 h por partido.", ""]

    if "hybrid" in rates:
        lines += ["## Política híbrida", "",
                  f"Cuotas: cercana {args.near:g}, centro {args.center:g}, lejana {args.far:g} anclas/min; la zona de portería (posición media a menos de "
                  f"10 m de una línea de meta y a menos de 12 m del centro del ancho) pide a lo más 2. Franja = posición media de la jugadora en "
                  f"`lateral` (0 = cercana a la cámara, 1 = lejana; cortes: {'tercios del ancho' if args.zones == 'thirds' else 'terciles de las jugadoras'}). "
                  "Lado cercano: signo de la correlación entre la parte baja de la caja en píxeles (y2) y `ym` (más abajo = más cerca).", "",
                  "| Parte | `ym` crece hacia la cámara | Cortes | Jugadoras (cercana / centro / lejana) |", "|---|---|---|---|"]
        for n in test + test2:
            sg, ed, zn = side[n]
            cnt = [sum(1 for z in zn.values() if z == zz) for zz in ZONES]
            lines.append(f"| {n} | {'sí' if sg > 0 else 'no'} | {ed[0]:.2f} / {ed[1]:.2f} | {cnt[0]} / {cnt[1]} / {cnt[2]} |")
        lines.append("")
    verdict = []
    for label, group in groups:
        if not group:
            continue
        minutes = sum(parts[n].seconds for n in group) / 60
        lines += [f"## {label} · {minutes:.1f} min medidos", "", "### Resumen", "",
                  "| Anclas/min | Cobertura | Errores | Huecos ≤4 s (fuera de cuadro) | 4-15 s (fuera) | >15 s (fuera) | Anclas | Saltos | Huecos >4 s a revisar | Sin identificar | h a 90 min | h con dos sitios |",
                  "|---|---|---|---|---|---|---|---|---|---|---|---|"]
        for k in rates:
            a = agg(group, k)
            t = a.total
            hc = t.holes_by_class()
            h = to_match_hours(a.review_s(), a.seconds)
            h2 = to_match_hours(a.review_s(True), a.seconds)
            lines.append(f"| {lab(k)} | {fmt_pct(t.coverage)} | {fmt_pct(t.err_s / t.in_s if t.in_s else float('nan'))} | "
                         f"{hc['≤4'][0]} ({hc['≤4'][1]}) | {hc['4-15'][0]} ({hc['4-15'][1]}) | {hc['>15'][0]} ({hc['>15'][1]}) | "
                         f"{a.anchors} | {a.jumps} | {t.holes_to_review()} | {a.unidentified} | {h:.2f} | {h2:.2f} |")
            verdict.append((label, k, t.coverage, h, h2, a.seconds))
        lines += ["", "### Por franja de la cancha (jugadoras propias según su posición media; cercana = lado de la cámara)", "",
                  "| Anclas/min | Franja | Jugadoras | Cobertura | Errores | Huecos >4 s a revisar | Huecos ≤4 s |", "|---|---|---|---|---|---|---|"]
        for k in rates:
            a = agg(group, k)
            for z in ZONES:
                zc = a.by_zone[z]
                hc = zc.holes_by_class()
                lines.append(f"| {lab(k)} | {z} | {a.zone_people[z]} | {fmt_pct(zc.coverage)} | "
                             f"{fmt_pct(zc.err_s / zc.in_s if zc.in_s else float('nan'))} | {zc.holes_to_review()} | {hc['≤4'][0]} |")
        lines += ["", "### Por parte", "",
                  "| Parte | Anclas/min | Cobertura | Errores | Huecos ≤4 / 4-15 / >15 (fuera de cuadro) | Anclas | Saltos | Dos sitios | Huecos >4 s a revisar | Sin identificar | h a 90 min |",
                  "|---|---|---|---|---|---|---|---|---|---|---|"]
        for k in rates:
            for n in group:
                r = res[n][k]
                t = r.total
                hc = t.holes_by_class()
                hs = " / ".join(f"{hc[c][0]} ({hc[c][1]})" for c in ("≤4", "4-15", ">15"))
                lines.append(f"| {n} | {lab(k)} | {fmt_pct(t.coverage)} | {fmt_pct(t.err_s / t.in_s if t.in_s else float('nan'))} | {hs} | "
                             f"{r.anchors} | {r.jumps} | {r.overlaps} | {t.holes_to_review()} | {r.unidentified} | {to_match_hours(r.review_s(), r.seconds):.2f} |")
        lines += ["", "### Por jugadora (cobertura con 1 / 2 / 3 anclas/min; errores y huecos con el mayor)", "",
                  f"| Parte | Jugadora | En cuadro (s) | Cobertura @{lab(rates[0])} | " + " | ".join(f"@{lab(k)}" for k in rates[1:]) +
                  f" | Errores @{lab(rates[-1])} (s) | Huecos ≤4 / 4-15 / >15 @{lab(rates[-1])} (fuera) |",
                  "|---|---|---|" + "---|" * (len(rates) + 2)]
        for n in group:
            for person in sorted(res[n][rates[0]].people):
                cs = [res[n][k].people[person] for k in rates]
                c = cs[-1]
                if c.in_s == 0:
                    continue
                hc = c.holes_by_class()
                hs = " / ".join(f"{hc[x][0]} ({hc[x][1]})" for x in ("≤4", "4-15", ">15"))
                lines.append(f"| {n} | {person} | {c.in_s:.0f} | " + " | ".join(fmt_pct(x.coverage) for x in cs) + f" | {c.err_s:.1f} | {hs} |")
        lines.append("")
    lines += ["## Veredicto", ""]
    for label, k, cov, h, h2, secs in verdict:
        lines.append(f"- {label}, {lab(k)} anclas/min: cobertura {fmt_pct(cov)}, {h:.2f} h a 90 min ({h2:.2f} h con dos sitios) "
                     f"{'dentro' if h2 <= 8 else 'fuera'} de la meta de 8 h.")
    lines += ["", "No probado: los 2 s y 3 s por acción son supuestos; las rivales no se miden; los minutos medidos son jugadas sueltas, "
              "no un partido seguido, y los huecos por fuera de cuadro usan la verdad de labels.", ""]
    out = dir_ / "revision" / args.report
    out.parent.mkdir(exist_ok=True)
    out.write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines))
    print(f"\nInforme: {out}")


if __name__ == "__main__":
    main()

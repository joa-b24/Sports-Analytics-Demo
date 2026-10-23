"""F4 de la unión de tracks: dos términos de costo aprendidos del partido ya corregido (docs/propuesta_union_tracks.md, 5.6).

- **Formación** (`FormationModel`): la posición de cada jugadora relativa al centro y a la forma de su equipo en ese
  instante (centroide, dispersión a lo largo y a lo ancho), orientada para que su equipo ataque siempre hacia +x. Por
  jugadora (equipo + `player_id`), media y dispersión de esa posición relativa; con balón, además por zona del balón
  (tercio x carril, en la misma orientación), con la global como respaldo cuando una zona tiene pocas muestras.
  `cost(team, player, r, zone)` es el costo (log-verosimilitud negativa) de «este trozo, aquí, es la jugadora X».
- **Balón** (`ball_track`): solo el balón revisado de `tracks_fixed_*.json` (marcas a mano y lo interpolado entre dos
  marcas cercanas). Nunca `ball_auto_*` ni el tracker de balón (`source == "auto"`).

Son términos de costo, no reglas: entran como variables opcionales del modelo de unión (`prior_features`), sin cambiar
`tracklets.FEATURES`. Nunca crean posiciones: sin forma del equipo o sin balón, la variable es NaN (y el modelo la ve
como un valor aparte).

    python -m sportsan.tracking.priors --match 2026_09_25_tec_ccm_vs_anahuac   # evaluación F4, informe priors_f4.md
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from sportsan.tracking.tracklets import Box, Candidate, Tracklet, _velocity

MIN_TEAM = 5            # jugadoras de un equipo en el cuadro para medir su forma
MIN_SPREAD_M = 3.0      # dispersión mínima (m) para no dividir entre casi cero
MIN_SAMPLES = 30        # muestras de una jugadora (o de una zona) para tener modelo
BALL_LINK_S = 2.0       # dos marcas a mano más separadas que esto: lo interpolado entre ellas no cuenta
NAN_FILL = -9.0         # valor de las variables que no se pudieron calcular (el modelo de árboles no admite NaN)

FORMATION_FEATURES = ["form_same", "form_dr", "form_cost_a", "form_cost_b"]
BALL_FEATURES = ["ball_d_a", "ball_d_b", "ball_dd", "ball_cos_a", "ball_cos_b", "form_same_ball"]


# --------------------------------------------------------------------------------------------- forma del equipo

Shape = tuple[float, float, float, float]   # cx, cy, sx, sy (m)


def team_shape(xy: np.ndarray) -> Shape | None:
    """Centroide y dispersión (desviación estándar) de las posiciones de un equipo; None con menos de MIN_TEAM."""
    xy = xy[np.isfinite(xy).all(axis=1)]
    if len(xy) < MIN_TEAM:
        return None
    c = xy.mean(axis=0)
    s = np.maximum(xy.std(axis=0), MIN_SPREAD_M)
    return float(c[0]), float(c[1]), float(s[0]), float(s[1])


def orientation(frames_xy: list[np.ndarray]) -> float:
    """+1 si el equipo defiende la portería de x pequeña, -1 si la de x grande. Lo da quien más se aleja del centroide a
    lo largo en cada cuadro (casi siempre la portera): su lado mediano es el propio."""
    sides = []
    for xy in frames_xy:
        xy = xy[np.isfinite(xy).all(axis=1)]
        if len(xy) < MIN_TEAM:
            continue
        dx = xy[:, 0] - xy[:, 0].mean()
        sides.append(dx[np.argmax(np.abs(dx))])
    return -1.0 if sides and np.median(sides) > 0 else 1.0


def relative(x: float, y: float, shape: Shape | None, sign: float) -> np.ndarray:
    """Posición relativa a la forma del equipo, orientada (ataca hacia +x)."""
    if shape is None or not (np.isfinite(x) and np.isfinite(y)):
        return np.array([np.nan, np.nan])
    cx, cy, sx, sy = shape
    return np.array([sign * (x - cx) / sx, sign * (y - cy) / sy])


def ball_zone(bx: float, by: float, length: float, width: float, sign: float) -> int | None:
    """Zona del balón (0-8: tercio a lo largo x 3 + carril), en la orientación del equipo."""
    if not (np.isfinite(bx) and np.isfinite(by)):
        return None
    if sign < 0:
        bx, by = length - bx, width - by
    tx = int(np.clip(bx / length * 3, 0, 2))
    ty = int(np.clip(by / width * 3, 0, 2))
    return tx * 3 + ty


# --------------------------------------------------------------------------------------------- balón revisado

def ball_track(fixed: dict) -> dict[int, tuple[float, float]]:
    """cuadro -> balón (m) revisado: marcas a mano, y lo interpolado solo entre dos marcas a mano a menos de
    BALL_LINK_S. Cualquier otra fuente (el tracker, `auto`) se ignora, y también lo interpolado que la toca."""
    fps = float(fixed.get("fps") or 30)
    rows = sorted(fixed.get("ball") or [], key=lambda b: b["frame"])
    out: dict[int, tuple[float, float]] = {}
    anchors = [i for i, b in enumerate(rows) if b.get("source") != "interpolated"]
    for i in anchors:
        if rows[i].get("source") == "manual":
            out[rows[i]["frame"]] = (float(rows[i]["x"]), float(rows[i]["y"]))
    for i, j in zip(anchors, anchors[1:]):
        a, b = rows[i], rows[j]
        if a.get("source") != "manual" or b.get("source") != "manual" or (b["frame"] - a["frame"]) / fps > BALL_LINK_S:
            continue
        for k in range(i + 1, j):
            out[rows[k]["frame"]] = (float(rows[k]["x"]), float(rows[k]["y"]))
    return out


# --------------------------------------------------------------------------------------------- modelo de formación

@dataclass
class Gauss:
    mean: np.ndarray
    std: np.ndarray
    n: int

    def cost(self, r: np.ndarray) -> float:
        z = (r - self.mean) / self.std
        return float(0.5 * (z @ z) + np.log(self.std).sum())


def _gauss(rs: list[np.ndarray]) -> Gauss | None:
    if len(rs) < MIN_SAMPLES:
        return None
    a = np.array(rs)
    return Gauss(a.mean(axis=0), np.maximum(a.std(axis=0), 0.15), len(a))


@dataclass
class FormationModel:
    """Por jugadora (equipo, player_id): gaussiana diagonal de su posición relativa; y por zona del balón."""
    players: dict[tuple[str, str], Gauss] = field(default_factory=dict)
    zones: dict[tuple[str, str, int], Gauss] = field(default_factory=dict)

    def cost(self, team: str, player: str, r: np.ndarray, zone: int | None = None) -> float:
        """Costo de que la posición relativa r sea de esa jugadora (NaN si no hay modelo o r no se midió)."""
        if not np.isfinite(r).all():
            return float("nan")
        g = self.zones.get((team, player, zone)) if zone is not None else None
        g = g or self.players.get((team, player))
        return g.cost(r) if g else float("nan")

    def posterior(self, team: str, r: np.ndarray, zone: int | None = None) -> np.ndarray | None:
        """Probabilidad de cada jugadora del equipo (en el orden de `roster(team)`) para la posición relativa r."""
        names = self.roster(team)
        if not names or not np.isfinite(r).all():
            return None
        c = np.array([self.cost(team, p, r, zone) for p in names])
        w = np.exp(-(c - c.min()))
        return w / w.sum()

    def roster(self, team: str) -> list[str]:
        return sorted(p for t, p in self.players if t == team)


def formation_samples(fixed: dict) -> list[tuple[str, str, np.ndarray, int | None]]:
    """(equipo, player_id, posición relativa, zona del balón) de cada jugadora con nombre en cada cuadro de una parte
    corregida. La forma del equipo sale de todas sus personas en ese cuadro (con nombre o no). Lo interpolado no cuenta."""
    venue = fixed.get("venue") or {}
    L, W = float(venue.get("length_m") or 105), float(venue.get("width_m") or 68)
    team_of = {p["id"]: p.get("team") for p in fixed["people"]}
    name_of = {p["id"]: p.get("player_id") for p in fixed["people"] if p.get("player_id")}
    ball = ball_track(fixed)
    per_team: dict[str, list[np.ndarray]] = {}
    rows = []
    for fr in fixed["frames"]:
        pos = [p for p in fr["positions"] if p.get("source") != "interpolated"]
        by: dict[str, list] = {}
        for p in pos:
            t = team_of.get(p["id"])
            if t in ("own", "opp"):
                by.setdefault(t, []).append(p)
        for t, ps in by.items():
            per_team.setdefault(t, []).append(np.array([[p["x"], p["y"]] for p in ps], dtype=float))
        rows.append((fr["frame"], by))
    sign = {t: orientation(v) for t, v in per_team.items()}
    out = []
    for frame, by in rows:
        b = ball.get(frame)
        for t, ps in by.items():
            shape = team_shape(np.array([[p["x"], p["y"]] for p in ps], dtype=float))
            if shape is None:
                continue
            zone = ball_zone(b[0], b[1], L, W, sign[t]) if b else None
            for p in ps:
                if p["id"] in name_of:
                    out.append((t, name_of[p["id"]], relative(p["x"], p["y"], shape, sign[t]), zone))
    return out


def fit_formation(fixed_parts: list[dict]) -> FormationModel:
    per: dict[tuple[str, str], list] = {}
    per_zone: dict[tuple[str, str, int], list] = {}
    for f in fixed_parts:
        for t, p, r, z in formation_samples(f):
            per.setdefault((t, p), []).append(r)
            if z is not None:
                per_zone.setdefault((t, p, z), []).append(r)
    m = FormationModel()
    m.players = {k: g for k, v in per.items() if (g := _gauss(v))}
    m.zones = {k: g for k, v in per_zone.items() if (g := _gauss(v)) and k[:2] in m.players}
    return m


# --------------------------------------------------------------------------------------------- variables de unión

@dataclass
class PartContext:
    """Lo que hace falta de una parte para las variables: forma de cada equipo por cuadro (de las cajas, sin nombres),
    orientación de cada equipo y balón revisado."""
    shapes: dict[int, dict[str, Shape | None]]
    sign: dict[str, float]
    ball: dict[int, tuple[float, float]]
    length: float
    width: float


def part_context(frames: list[list[Box]], ball: dict[int, tuple[float, float]] | None, length: float, width: float) -> PartContext:
    shapes: dict[int, dict[str, Shape | None]] = {}
    per_team: dict[str, list[np.ndarray]] = {}
    for row in frames:
        if not row:
            continue
        by: dict[str, list] = {}
        for b in row:
            if b.on_pitch and b.team in ("own", "opp") and np.isfinite(b.xm):
                by.setdefault(b.team, []).append((b.xm, b.ym))
        shapes[row[0].frame] = {t: team_shape(np.array(v, dtype=float)) for t, v in by.items()}
        for t, v in by.items():
            per_team.setdefault(t, []).append(np.array(v, dtype=float))
    return PartContext(shapes, {t: orientation(v) for t, v in per_team.items()}, ball or {}, length, width)


def _ball_near(ctx: PartContext, frame: int, tol: int = 3) -> tuple[float, float] | None:
    for d in range(tol + 1):
        for f in (frame - d, frame + d):
            if f in ctx.ball:
                return ctx.ball[f]
    return None


def prior_features(cands: list[Candidate], tracklets: list[Tracklet], ctx: PartContext, model: FormationModel,
                   fps: float, use_ball: bool = False) -> np.ndarray:
    """Variables de formación (FORMATION_FEATURES) y, con `use_ball`, de balón (BALL_FEATURES) de cada candidato.

    - form_same: probabilidad, según la formación, de que el final de a y el inicio de b sean la misma jugadora
      (suma sobre las jugadoras del equipo de P(X | a) * P(X | b)).
    - form_dr: distancia entre las dos posiciones relativas (en dispersiones del equipo).
    - form_cost_a/b: costo de la jugadora más probable de cada lado (qué tan «en su sitio» está alguien ahí).
    - ball_d_a/b, ball_dd: distancia al balón al final de a, al inicio de b, y su cambio.
    - ball_cos_a/b: coseno entre la dirección de su movimiento y la dirección al balón.
    - form_same_ball: form_same con la formación condicionada a la zona del balón."""
    by_id = {t.id: t for t in tracklets}
    n_cols = len(FORMATION_FEATURES) + (len(BALL_FEATURES) if use_ball else 0)
    out = np.full((len(cands), n_cols), np.nan)
    vel_end: dict[int, np.ndarray] = {}
    vel_start: dict[int, np.ndarray] = {}

    def side(t: Tracklet, at_end: bool, team: str):
        b = t.boxes[-1] if at_end else t.boxes[0]
        shape = ctx.shapes.get(b.frame, {}).get(team)
        sign = ctx.sign.get(team, 1.0)
        r = relative(b.xm, b.ym, shape, sign)
        ball = _ball_near(ctx, b.frame)
        zone = ball_zone(ball[0], ball[1], ctx.length, ctx.width, sign) if ball else None
        return b, r, ball, zone

    for i, c in enumerate(cands):
        a, b = by_id[c.a], by_id[c.b]
        team = a.team if a.team in ("own", "opp") else b.team
        if team not in ("own", "opp"):
            continue
        ea, ra, balla, za = side(a, True, team)
        sb, rb, ballb, zb = side(b, False, team)
        pa, pb = model.posterior(team, ra), model.posterior(team, rb)
        if pa is not None and pb is not None:
            out[i, 0] = float(pa @ pb) / max(float(pa @ pa), float(pb @ pb))
            out[i, 1] = float(np.hypot(*(ra - rb)))
            names = model.roster(team)
            out[i, 2] = model.cost(team, names[int(np.argmax(pa))], ra)
            out[i, 3] = model.cost(team, names[int(np.argmax(pb))], rb)
        if not use_ball:
            continue
        k = len(FORMATION_FEATURES)
        if balla:
            out[i, k] = float(np.hypot(ea.xm - balla[0], ea.ym - balla[1]))
            v = vel_end.setdefault(a.id, _velocity(a, fps, True))
            out[i, k + 3] = _cos(v, np.array([balla[0] - ea.xm, balla[1] - ea.ym]))
        if ballb:
            out[i, k + 1] = float(np.hypot(sb.xm - ballb[0], sb.ym - ballb[1]))
            v = vel_start.setdefault(b.id, _velocity(b, fps, False))
            out[i, k + 4] = _cos(v, np.array([ballb[0] - sb.xm, ballb[1] - sb.ym]))
        if balla and ballb:
            out[i, k + 2] = abs(out[i, k + 1] - out[i, k])
        if za is not None and zb is not None:
            qa, qb = model.posterior(team, ra, za), model.posterior(team, rb, zb)
            if qa is not None and qb is not None:
                out[i, k + 5] = float(qa @ qb) / max(float(qa @ qa), float(qb @ qb))
    return out


def _cos(v: np.ndarray, d: np.ndarray) -> float:
    nv, nd = float(np.hypot(*v)), float(np.hypot(*d))
    if nv < 0.5 or nd < 0.5:      # quieta o encima del balón: sin dirección
        return float("nan")
    return float(v @ d / (nv * nd))


def fill_nan(X: np.ndarray) -> np.ndarray:
    return np.where(np.isfinite(X), X, NAN_FILL)


# --------------------------------------------------------------------------------------------- evaluación

def auc(p: np.ndarray, y: np.ndarray) -> float:
    """Área bajo la curva ROC (por rangos; empates a la mitad)."""
    pos, neg = p[y == 1], p[y == 0]
    if not len(pos) or not len(neg):
        return float("nan")
    order = np.argsort(np.concatenate([pos, neg]), kind="mergesort")
    ranks = np.empty(len(order))
    vals = np.concatenate([pos, neg])[order]
    i = 0
    while i < len(vals):
        j = i
        while j + 1 < len(vals) and vals[j + 1] == vals[i]:
            j += 1
        ranks[order[i:j + 1]] = (i + j) / 2 + 1
        i = j + 1
    return float((ranks[: len(pos)].sum() - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg)))


TRAIN = ["v1_6414_13699", "v1_14541_15944", "v1_16648_22211", "v1_23140_26173", "v1_26910_32826", "v1_33818_35062", "v1_36135_41389"]
TEST_V1 = ["v1_41994_43460", "v1_44071_52064", "v1_52933_72647", "v1_73385_78596"]


def main() -> None:
    import argparse
    import sys

    from sportsan.config import load_config, project_root
    from sportsan.tracking.links_eval import _venue, groups_of, load_part, named_parts
    from sportsan.tracking.tracklets import (FEATURES, LINK_P_MIN, Score, TreeModel, accept_greedy, candidate_labels,
                                             chains, link_candidates, player_features, player_labels, pure_tracklets,
                                             score_groups)

    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--match")
    ap.add_argument("--report", default="priors_f4.md")
    args = ap.parse_args()
    cfg = load_config(match=args.match)
    dir_ = project_root() / cfg["paths"]["tracking_dir"]
    other = [n for n in named_parts(dir_) if not n.startswith("v1_")]
    names = TRAIN + TEST_V1 + other
    fixed = {n: json.loads((dir_ / f"tracks_fixed_{n}.json").read_text(encoding="utf-8")) for n in names}
    parts = {n: load_part(dir_, n, feet=True) for n in names}
    tl = {n: pure_tracklets(parts[n].frames, parts[n].fps) for n in names}
    ctx = {n: part_context(parts[n].frames, ball_track(fixed[n]), *_venue(dir_, n)) for n in names}
    print("partes cargadas", flush=True)

    # Formación: para las partes de entrenamiento, modelo sin esa parte (si no, la variable es demasiado buena en el
    # entrenamiento); para las de prueba, con las 7.
    form = {n: fit_formation([fixed[m] for m in TRAIN if m != n]) for n in TRAIN}
    full = fit_formation([fixed[m] for m in TRAIN])
    for n in names:
        form.setdefault(n, full)

    def fit(X, y):
        k = y >= 0
        return TreeModel().fit(X[k], y[k].astype(float))

    # ¿Es jugadora? (igual para las tres variantes)
    pX = {n: np.array([player_features(t, *_venue(dir_, n), parts[n].fps) for t in tl[n]]) for n in names}
    pmodel = fit(np.vstack([pX[n] for n in TRAIN]), np.concatenate([player_labels(tl[n], parts[n].truth) for n in TRAIN]))
    allowed = {n: {t.id for t, p in zip(tl[n], pmodel.predict(pX[n])) if p >= 0.5} for n in names}

    cands = {n: link_candidates(tl[n], parts[n].fps) for n in names}
    y = {n: candidate_labels(cands[n], tl[n], parts[n].truth) for n in names}
    base = {n: np.array([c.x for c in cands[n]]) if cands[n] else np.zeros((0, len(FEATURES))) for n in names}
    extra = {n: prior_features(cands[n], tl[n], ctx[n], form[n], parts[n].fps, use_ball=True) for n in names}
    k_form = len(FORMATION_FEATURES)
    variants = {
        "Base (fase 1)": lambda n: base[n],
        "+ formación": lambda n: np.hstack([base[n], fill_nan(extra[n][:, :k_form])]),
        "+ formación + balón": lambda n: np.hstack([base[n], fill_nan(extra[n])]),
        "+ balón solo": lambda n: np.hstack([base[n], fill_nan(extra[n][:, k_form:k_form + 5])]),
    }
    test_sets = {"Prueba v1 (4 partes)": TEST_V1, f"Prueba v2/v3 ({len(other)} partes)": other}
    ball_cov = {n: len(ctx[n].ball) / max(1, len(parts[n].frames)) for n in names}

    lines = [f"# Unión de tracks, F4: formación y balón · {cfg.get('match_id', args.match)}", "",
             f"Entrenamiento: {', '.join(TRAIN)}. Pies corregidos (feet.py). Umbral de unión {LINK_P_MIN}. Mismos trozos, "
             "candidatos, clasificador de jugadora y anclas en todas las variantes; solo cambian las variables del modelo de unión.", "",
             "Formación: posición relativa al centroide y a la dispersión de su equipo (de las cajas, sin nombres), orientada; "
             "modelo por jugadora de las partes con nombre (en el entrenamiento, sin la parte que se mide). Balón: solo marcas a "
             "mano de `tracks_fixed` y lo interpolado entre marcas a menos de 2 s; nunca el tracker.", "",
             "Cobertura del balón revisado (cuadros con balón / cuadros): " + ", ".join(f"{n} {100 * c:.0f} %" for n, c in ball_cov.items()), "",
             "**Dudas**: candidatos entre 0.5 y el umbral cuyos dos extremos quedaron libres (lo que se preguntaría). "
             "**Trabajo**: uniones + cortes pendientes.", ""]
    for label, test in test_sets.items():
        lines += [f"## {label}", "", ", ".join(test), "",
                  "| Variante | AUC | Uniones hechas | Erróneas | Pureza | Uniones pend. | Cortes pend. | Trabajo | Dudas |",
                  "|---|---|---|---|---|---|---|---|---|"]
        for vname, feat in variants.items():
            model = fit(np.vstack([feat(n) for n in TRAIN]), np.concatenate([y[n] for n in TRAIN]))
            tot, made, wrong, doubts, ps, ys = Score(), 0, 0, 0, [], []
            for n in test:
                p = model.predict(feat(n))
                for c, pr in zip(cands[n], p):
                    c.p = float(pr)
                acc = accept_greedy(cands[n], p_min=LINK_P_MIN, allowed=allowed[n])
                ida = {id(c): i for i, c in enumerate(cands[n])}
                made += len(acc)
                wrong += sum(1 for c in acc if y[n][ida[id(c)]] == 0)
                ua, ub = {c.a for c in acc}, {c.b for c in acc}
                doubts += sum(1 for c in cands[n] if 0.5 <= c.p < LINK_P_MIN and c.a not in ua and c.b not in ub
                              and c.a in allowed[n] and c.b in allowed[n])
                tot = tot.add(score_groups(groups_of(parts[n], "tl", tl[n], chains(len(tl[n]), acc)), parts[n].truth))
                k = y[n] >= 0
                ps.append(p[k])
                ys.append(y[n][k])
            a = auc(np.concatenate(ps), np.concatenate(ys))
            lines.append(f"| {vname} | {a:.4f} | {made} | {wrong} | {100 * tot.purity:.2f} % | {tot.joins_needed} | "
                         f"{tot.cuts_needed} | {tot.joins_needed + tot.cuts_needed} | {doubts} |")
            print(lines[-1], flush=True)
        lines.append("")
    lines += ["## Variables", "", f"Formación: {', '.join(FORMATION_FEATURES)}. Balón: {', '.join(BALL_FEATURES)} "
              "(«+ balón solo» usa las cinco primeras, sin la formación condicionada).", ""]
    out = dir_ / "revision" / args.report
    out.parent.mkdir(exist_ok=True)
    out.write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines))
    print(f"\nInforme: {out}")


if __name__ == "__main__":
    main()

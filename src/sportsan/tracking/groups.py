"""F2: clasifica cada trozo puro en un grupo (docs/propuesta_union_tracks.md, 5.3), sin leer archivos.

Grupos: propias, rivales, porteras (propia y rival), árbitros y fuera de juego (banca, público, detecciones sueltas).
Un trozo nunca se une con otro de otro grupo; si el grupo de un trozo cambia sin cruce, se marca como duda (sombra
probable), no se corta.

Verdad (`truth_groups`): sale de `labels_*.json`. La persona de cada caja trae su `team` (own/opp/ref/unk) y las cajas
quitadas o soltadas (`removed`/`dropped`) son «fuera». Los labels NO distinguen porteras (son de su equipo), así que la
portera se evalúa fusionada con su equipo y la regla de portera (`goalkeeper_group`) se apoya en `jersey_colors` + cercanía
al arco, sin verdad etiquetada. Las personas con equipo «unk» quedan sin verdad.
"""
from __future__ import annotations

import numpy as np

from sportsan.tracking.tracklets import Tracklet

GROUPS = ["propias", "rivales", "porteras_propias", "porteras_rivales", "arbitros", "fuera"]
CORE = ["propias", "rivales", "arbitros", "fuera"]       # los que tienen verdad en los labels
_TEAM_TO_GROUP = {"own": "propias", "opp": "rivales", "ref": "arbitros"}
GOAL_RADIUS_M = 16.5                                      # una portera vive dentro del área grande
FEATURES = ["lab_l", "lab_a", "lab_b", "x_m", "y_m", "goal_dist_m", "edge_m", "h_px", "speed_ms", "len_log", "team_own",
            "team_opp", "team_ref", "team_unk"]


def truth_groups(labels: dict) -> dict[tuple[int, int], str]:
    """(cuadro, track) -> grupo de verdad. Cajas de personas sin equipo conocido quedan fuera del diccionario."""
    team = {p["label"]: p.get("team") for p in labels.get("people", [])}
    out: dict[tuple[int, int], str] = {}
    for fr in labels["frames"]:
        for b in fr["boxes"]:
            key = (fr["frame"], int(b["track"]))
            if b["status"] in ("removed", "dropped"):
                out[key] = "fuera"
            elif b["status"] == "player" and team.get(b["label"]) in _TEAM_TO_GROUP:
                out[key] = _TEAM_TO_GROUP[team[b["label"]]]
    return out


def tracklet_group_truth(t: Tracklet, truth: dict) -> tuple[str | None, float]:
    """Grupo mayoritario de las cajas con verdad y la fracción que lo comparte (None si ninguna tiene)."""
    vals = [truth[(b.frame, b.track)] for b in t.boxes if (b.frame, b.track) in truth]
    if not vals:
        return None, 1.0
    best = max(set(vals), key=vals.count)
    return best, vals.count(best) / len(vals)


def hex_to_lab(h: str) -> np.ndarray:
    """Color #rrggbb -> Lab en la escala de 8 bits de OpenCV (L 0-255, a y b + 128), la de las cajas."""
    h = h.lstrip("#")
    rgb = np.array([int(h[i:i + 2], 16) for i in (0, 2, 4)], dtype=float) / 255
    lin = np.where(rgb > 0.04045, ((rgb + 0.055) / 1.055) ** 2.4, rgb / 12.92)
    m = np.array([[0.412453, 0.357580, 0.180423], [0.212671, 0.715160, 0.072169], [0.019334, 0.119193, 0.950227]])
    xyz = m @ lin / np.array([0.950456, 1.0, 1.088754])
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    L, a, b = 116 * f[1] - 16, 500 * (f[0] - f[1]), 200 * (f[1] - f[2])
    return np.array([L * 255 / 100, a + 128, b + 128])


def features(t: Tracklet, length_m: float, width_m: float, fps: float) -> np.ndarray:
    xs = np.array([b.xm for b in t.boxes], dtype=float)
    ys = np.array([b.ym for b in t.boxes], dtype=float)
    ok = np.isfinite(xs) & np.isfinite(ys)
    x = float(np.median(xs[ok])) if ok.any() else -10.0
    y = float(np.median(ys[ok])) if ok.any() else -10.0
    goal = min(np.hypot(x, y - width_m / 2), np.hypot(length_m - x, y - width_m / 2))
    edge = min(x, length_m - x, y, width_m - y)
    dur = (t.end - t.start) / fps
    speed = float(np.hypot(xs[-1] - xs[0], ys[-1] - ys[0]) / dur) if dur > 0 and ok[[0, -1]].all() else 0.0
    lab, team = t.lab, t.team
    return np.array([lab[0], lab[1], lab[2], x, y, goal, edge, float(np.median([b.h for b in t.boxes])), speed,
                     np.log1p(len(t.boxes)), float(team == "own"), float(team == "opp"), float(team == "ref"),
                     float(team not in ("own", "opp", "ref"))])


class GroupClassifier:
    """k-vecinos ponderado por distancia sobre variables estandarizadas; la probabilidad es el voto del grupo ganador.
    Se entrena por partido (los uniformes cambian)."""

    def __init__(self, k: int = 9, groups: list[str] | None = None):
        self.k = k
        self.groups = groups or CORE

    def fit(self, X: np.ndarray, y: list[str], weights: np.ndarray | None = None) -> "GroupClassifier":
        self.mu, self.sd = X.mean(axis=0), X.std(axis=0) + 1e-6
        self.X = (X - self.mu) / self.sd
        self.y = np.array([self.groups.index(g) for g in y])
        self.w = np.ones(len(y)) if weights is None else np.asarray(weights, dtype=float)
        return self

    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        Z = (X - self.mu) / self.sd
        out = np.zeros((len(X), len(self.groups)))
        k = min(self.k, len(self.X))
        for s in range(0, len(Z), 512):
            z = Z[s:s + 512]
            d = np.sqrt(((z[:, None, :] - self.X[None, :, :]) ** 2).sum(axis=2))
            idx = np.argsort(d, axis=1)[:, :k]
            for i in range(len(z)):
                w = self.w[idx[i]] / (d[i, idx[i]] + 0.1)
                np.add.at(out[s + i], self.y[idx[i]], w)
        return out / out.sum(axis=1, keepdims=True)


def goalkeeper_group(group: str, f: np.ndarray, seeds: dict[str, str] | None) -> str:
    """Regla de portera: trozo de un equipo, dentro del área grande de un arco y con color más cercano al de portera del
    equipo (`own_gk`/`opp_gk` de jersey_colors) que al de campo. Sin semillas no hay portera (se devuelve el grupo)."""
    if not seeds or group not in ("propias", "rivales") or f[FEATURES.index("goal_dist_m")] > GOAL_RADIUS_M:
        return group
    key = "own" if group == "propias" else "opp"
    if f"{key}_gk" not in seeds or key not in seeds:
        return group
    lab = f[:3]
    d_gk = np.linalg.norm(lab - hex_to_lab(seeds[f"{key}_gk"]))
    d_field = np.linalg.norm(lab - hex_to_lab(seeds[key]))
    return ("porteras_propias" if key == "own" else "porteras_rivales") if d_gk < d_field else group


def classify(tracklets: list[Tracklet], model: GroupClassifier, length_m: float, width_m: float, fps: float,
             seeds: dict[str, str] | None = None) -> tuple[list[str], np.ndarray]:
    """Grupo y probabilidad de cada trozo."""
    if not tracklets:
        return [], np.zeros(0)
    F = np.array([features(t, length_m, width_m, fps) for t in tracklets])
    p = model.predict_proba(F)
    groups = [goalkeeper_group(model.groups[int(i)], f, seeds) for i, f in zip(p.argmax(axis=1), F)]
    return groups, p.max(axis=1)


def group_doubts(tracklets: list[Tracklet], groups: list[str]) -> set[int]:
    """Ids de trozos consecutivos de un mismo track del seguidor cuyo grupo cambia SIN cruce en el corte: sombra probable.
    Se marcan como duda (ambos lados), no se cortan."""
    last: dict[int, int] = {}
    out: set[int] = set()
    for i, t in sorted(enumerate(tracklets), key=lambda it: it[1].start):
        j = last.get(t.track)
        if j is not None:
            a = tracklets[j]
            if groups[j] != groups[i] and not (a.crowded_end or t.crowded_start):
                out.update((a.id, t.id))
        last[t.track] = i
    return out


# --------------------------------------------------------------------------------------------- duplicado / sombra

OVERLAP_FEATURES = ["iou_max_mean", "iou_hi_frac", "bigger_dist_med", "bigger_dist_min", "bigger_color_med", "twin_frac",
                    "contained_frac"]
TWIN_M = 1.5          # una caja más grande a menos de esto, del mismo color, es probable duplicado o sombra
TWIN_COLOR = 15.0
_NO_NEIGHBOR = 10.0   # distancia (m) cuando no hay otra caja más grande en el cuadro


def overlap_features(tracklets: list[Tracklet], frames: list[list]) -> np.ndarray:
    """Variables de solape de cada trozo con las demás cajas de la cancha en los mismos cuadros: IoU máximo, distancia y
    color de la caja más grande más cercana (un duplicado o una sombra casi siempre tiene al lado una caja mayor del mismo
    color), fracción de cajas «gemelas» y de cajas contenidas en otra."""
    from sportsan.tracking.tracklets import _iou, color_distance

    rows = {row[0].frame: [b for b in row if b.on_pitch] for row in frames if row}
    out = np.zeros((len(tracklets), len(OVERLAP_FEATURES)))
    for i, t in enumerate(tracklets):
        iou_m, bd, bc, twin, cont = [], [], [], 0, 0
        for b in t.boxes:
            best_iou, best_d, best_c = 0.0, _NO_NEIGHBOR, 99.0
            inside = False
            for o in rows.get(b.frame, ()):
                if o.track == b.track:
                    continue
                v = _iou(b, o)
                best_iou = max(best_iou, v)
                if o.h > b.h:
                    if np.isfinite(b.xm) and np.isfinite(o.xm):
                        d = float(np.hypot(b.xm - o.xm, b.ym - o.ym))
                        if d < best_d:
                            best_d, best_c = d, color_distance(b.lab, o.lab)
                    ix = min(b.x2, o.x2) - max(b.x1, o.x1)
                    iy = min(b.y2, o.y2) - max(b.y1, o.y1)
                    if ix > 0 and iy > 0 and ix * iy > 0.7 * (b.x2 - b.x1) * (b.y2 - b.y1):
                        inside = True
            iou_m.append(best_iou)
            bd.append(best_d)
            bc.append(best_c)
            twin += best_d < TWIN_M and best_c < TWIN_COLOR
            cont += inside
        n = len(t.boxes)
        iou_a = np.array(iou_m)
        out[i] = [iou_a.mean(), (iou_a > 0.2).mean(), np.median(bd), min(bd), np.median(bc), twin / n, cont / n]
    return out


class DuplicateDetector:
    """¿El trozo es un duplicado o sombra (cajas quitadas o soltadas en la mesa)? Árboles de gradiente (`TreeModel`) sobre las
    variables del trozo y las de solape."""

    def __init__(self, threshold: float = 0.5):
        from sportsan.tracking.tracklets import TreeModel

        self.threshold = threshold
        self.model = TreeModel(trees=100, depth=3, min_leaf=30)

    def fit(self, X: np.ndarray, is_dup: np.ndarray) -> "DuplicateDetector":
        self.model.fit(X, np.asarray(is_dup, dtype=float))
        return self

    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        return self.model.predict(X)

    def predict(self, X: np.ndarray) -> np.ndarray:
        return self.predict_proba(X) >= self.threshold


def classify_full(tracklets, frames, group_model: GroupClassifier, detector: DuplicateDetector, length_m: float,
                  width_m: float, fps: float, seeds: dict[str, str] | None = None) -> tuple[list[str], np.ndarray]:
    """Grupo final: primero el detector aparta los duplicados/sombras («fuera»); el resto se clasifica en equipo / árbitro."""
    if not tracklets:
        return [], np.zeros(0)
    base = np.array([features(t, length_m, width_m, fps) for t in tracklets])
    p_dup = detector.predict_proba(np.hstack([base, overlap_features(tracklets, frames)]))
    groups, p = classify(tracklets, group_model, length_m, width_m, fps, seeds)
    return [("fuera" if d >= detector.threshold else g) for g, d in zip(groups, p_dup)], np.where(p_dup >= detector.threshold, p_dup, p)


# --------------------------------------------------------------------------------------------- evaluación

TRAIN = ["v1_6414_13699", "v1_14541_15944", "v1_16648_22211", "v1_23140_26173", "v1_26910_32826", "v1_33818_35062", "v1_36135_41389"]
TEST_V1 = ["v1_41994_43460", "v1_44071_52064", "v1_52933_72647", "v1_73385_78596"]
INNER = ["propias", "rivales", "arbitros"]


def _data(dir_, name):
    import json

    from sportsan.tracking.links_eval import _venue, load_part
    from sportsan.tracking.tracklets import pure_tracklets

    p = load_part(dir_, name)
    labels = json.loads((dir_ / f"labels_{name}.json").read_text(encoding="utf-8"))
    truth = truth_groups(labels)
    tl = pure_tracklets(p.frames, p.fps)
    L, W = _venue(dir_, name)
    F = np.array([features(t, L, W, p.fps) for t in tl])
    O = overlap_features(tl, p.frames)
    y = [tracklet_group_truth(t, truth) for t in tl]
    return tl, F, O, y


def _confusion(rows: list[tuple[str, str, int]], names: list[str]) -> list[str]:
    m = {(a, b): 0 for a in names for b in names}
    for t, g, w in rows:
        m[(t, g)] += w
    out = ["| verdad / predicho | " + " | ".join(names) + " |", "|---|" + "---|" * len(names)]
    out += [f"| {a} | " + " | ".join(str(m[(a, b)]) for b in names) + " |" for a in names]
    return out


def main() -> None:
    import argparse
    import sys

    from sportsan.config import load_config, project_root
    from sportsan.tracking.links_eval import named_parts

    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description="Mide la clasificación de trozos en grupos (informe grupos_f2.md).")
    ap.add_argument("--match")
    args = ap.parse_args()
    cfg = load_config(match=args.match)
    dir_ = project_root() / cfg["paths"]["tracking_dir"]
    other = [n for n in named_parts(dir_) if n.startswith(("v2_", "v3_"))]
    data = {n: _data(dir_, n) for n in TRAIN + TEST_V1 + other}

    Xf, Xo, ys = [], [], []
    for n in TRAIN:
        tl, F, O, y = data[n]
        for f, o, (g, _) in zip(F, O, y):
            if g is not None:
                Xf.append(f), Xo.append(o), ys.append(g)
    Xf, Xo, ys = np.array(Xf), np.array(Xo), np.array(ys)
    inner = np.isin(ys, INNER)
    gm = GroupClassifier(groups=INNER).fit(Xf[inner], list(ys[inner]))
    det = DuplicateDetector().fit(np.hstack([Xf, Xo]), ys == "fuera")

    lines = ["# Clasificación de trozos en grupos (F2)", "",
             f"Entrenamiento ({len(TRAIN)} partes de v1, {len(ys)} trozos con verdad, {int((ys == 'fuera').sum())} de «fuera»): {', '.join(TRAIN)}.", "",
             "Verdad: `team` de la persona en `labels_*.json` (own/opp/ref) y «fuera» = cajas quitadas o soltadas (duplicados, sombras, "
             "detecciones sueltas). **Los labels no marcan porteras** (son de su equipo): la regla de portera (jersey_colors + cercanía al "
             "arco) está en el código y en pruebas sintéticas pero no se mide aquí. Las personas con equipo «unk» quedan sin verdad. "
             "Un trozo cuenta con su grupo mayoritario; «cajas» pesa cada trozo por sus cajas con verdad. Meta: ≥ 98 %.", "",
             "- **Grupos** (propias / rivales / árbitros): k-vecinos (k=9) ponderado por distancia, 14 variables estandarizadas (Lab mediana, "
             "posición, distancia al arco y a la línea, altura, velocidad, longitud, equipo que propuso process), entrenado sin «fuera».",
             f"- **Detector de duplicado/sombra**: árboles de gradiente (`TreeModel`) sobre esas 14 variables más {len(OVERLAP_FEATURES)} de solape "
             f"({', '.join(OVERLAP_FEATURES)}), umbral {det.threshold}.", ""]
    t1 = ["## 1. Grupos sin «fuera» (solo trozos de propias, rivales y árbitros)", "",
          "| Conjunto | Trozos | % trozos | Cajas | % cajas |", "|---|---|---|---|---|"]
    t2 = ["## 2. Detector de duplicado/sombra (positivo = «fuera»)", "",
          "| Conjunto | Trozos «fuera» | Precisión (trozos) | Recobrado (trozos) | Precisión (cajas) | Recobrado (cajas) |", "|---|---|---|---|---|---|"]
    t3 = ["## 3. Combinado (detector + grupos): los 4 grupos", "",
          "| Conjunto | Trozos | % trozos | Cajas | % cajas | Dudas (cambio sin cruce) |", "|---|---|---|---|---|---|"]
    conf: list[str] = []
    sets = [("Prueba v1 (4 partes)", TEST_V1)] + [(n, [n]) for n in other] + [("Prueba v2+v3 (todas)", other)]
    for label, names in sets:
        r_in, r_all, dup_rows, doubts = [], [], [], 0
        for n in names:
            tl, F, O, y = data[n]
            g_in = [gm.groups[i] for i in gm.predict_proba(F).argmax(axis=1)]
            pd = det.predict(np.hstack([F, O]))
            comb = ["fuera" if d else g for g, d in zip(g_in, pd)]
            doubts += len(group_doubts(tl, comb))
            for t, (g, _), gi, d, c in zip(tl, y, g_in, pd, comb):
                if g is None:
                    continue
                w = len(t.boxes)
                r_all.append((g, c, w))
                dup_rows.append((g == "fuera", bool(d), w))
                if g != "fuera":
                    r_in.append((g, gi, w))
        if not r_all:
            continue

        def acc(rows):
            ok = np.array([a == b for a, b, _ in rows])
            w = np.array([r[2] for r in rows])
            return len(rows), 100 * ok.mean(), int(w.sum()), 100 * (w * ok).sum() / w.sum()

        n_, a_, nb, ab = acc(r_in)
        t1.append(f"| {label} | {n_} | {a_:.2f} % | {nb} | {ab:.2f} % |")
        d = np.array(dup_rows)
        tp = lambda wgt: float((wgt * (d[:, 0] & d[:, 1])).sum())  # noqa: E731
        for_w = (np.ones(len(d)), d[:, 2].astype(float))
        pr = [tp(w) / max(1.0, float((w * d[:, 1]).sum())) for w in for_w]
        rc = [tp(w) / max(1.0, float((w * d[:, 0]).sum())) for w in for_w]
        t2.append(f"| {label} | {int(d[:, 0].sum())} | {100 * pr[0]:.1f} % | {100 * rc[0]:.1f} % | {100 * pr[1]:.1f} % | {100 * rc[1]:.1f} % |")
        n_, a_, nb, ab = acc(r_all)
        t3.append(f"| {label} | {n_} | {a_:.2f} % | {nb} | {ab:.2f} % | {doubts} |")
        conf += [f"### {label}", ""] + _confusion(r_all, CORE) + [""]
    lines += t1 + [""] + t2 + [""] + t3 + ["", "## 4. Matrices de confusión del combinado (cajas)", ""] + conf
    out = dir_ / "revision" / "grupos_f2.md"
    out.parent.mkdir(exist_ok=True)
    out.write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines))


if __name__ == "__main__":
    main()

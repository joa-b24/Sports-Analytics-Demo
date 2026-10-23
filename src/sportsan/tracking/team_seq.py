"""F4b de la unión de tracks: dónde debería estar cada jugadora según la secuencia del balón y la forma de los equipos.

F4 (`priors.py`) usaba la posición media de cada jugadora relativa al centro de su equipo (estática). Aquí, en cada
instante t, una red pequeña (torch en CPU) recibe:

- el **rol** de la jugadora como un vector de 2 números: su posición relativa media (relativa al centroide y a la
  dispersión de su equipo, orientada para que ataque hacia +x). Con la formación dada (`formacion.json`, solo el primer
  tiempo) es la media de esa jugadora en las partes de entrenamiento; sin formación (segundo tiempo) es un **rol
  aprendido**: la media de esa jugadora en la parte, medida solo en sus cadenas ancladas;
- la forma de los dos equipos en t (centroide y dispersión, de las cajas, sin nombres);
- el balón revisado en t, t-1 s, t-2.5 s y t-5 s (solo marcas a mano de `tracks_fixed` y lo interpolado entre marcas a
  menos de 2 s, las reglas de `priors.ball_track`; nunca `ball_auto` ni el tracker), con su máscara de «no se sabe».

y predice la posición (x, y) de la jugadora como la estática de F4 más una corrección, con su varianza por eje
(pérdida de verosimilitud gaussiana). El costo para la unión es la distancia de Mahalanobis entre la posición del trozo
y la esperada (`seq_cost`). Nunca crea posiciones: sin forma del equipo la predicción es NaN y el costo es 0.

Solo el equipo propio: las rivales no tienen nombre en la verdad.

    python -m sportsan.tracking.team_seq --match 2026_09_25_tec_ccm_vs_anahuac   # informe secuencias_f4b.md
"""
from __future__ import annotations

import json
import unicodedata
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from sportsan.tracking.priors import _ball_near, part_context
from sportsan.tracking.tracklets import Box

LAGS_S = (0.0, 1.0, 2.5, 5.0)     # balón en t y antes (s)
D2_CAP = 16.0                     # tope de la distancia de Mahalanobis al cuadrado en el costo
MIN_VAR_M2 = 0.25                 # varianza mínima por eje (m²)
FEATURE_NAMES = (["role_x", "role_y", "own_sx", "own_sy", "own_cx", "own_cy", "opp_dx", "opp_dy", "opp_sx", "opp_sy"]
                 + [f"ball_{k}_{a}" for k in range(len(LAGS_S)) for a in "xy"]
                 + [f"ball_{k}_ok" for k in range(len(LAGS_S))]
                 + ["base_x", "base_y"])


# --------------------------------------------------------------------------------------------- contexto por cuadro

@dataclass
class SeqContext:
    """Todo lo que no depende de la jugadora, precalculado una vez por parte (arrays por cuadro procesado)."""
    frames: np.ndarray            # (n,) número de cuadro
    index: dict[int, int]         # cuadro -> fila
    own: np.ndarray               # (n, 4) cx, cy, sx, sy del equipo propio (NaN si no hay forma)
    opp: np.ndarray               # (n, 4) lo mismo del rival
    sign: float                   # orientación del equipo propio (+1 ataca hacia x grande)
    ball: np.ndarray              # (n, len(LAGS_S), 2) balón revisado en t - lag (NaN si no hay)
    length: float
    width: float


def seq_context(frames: list[list[Box]], ball: dict[int, tuple[float, float]] | None, length: float, width: float,
                fps: float, team: str = "own") -> SeqContext:
    ctx = part_context(frames, ball, length, width)
    fr = np.array(sorted(ctx.shapes), dtype=int)
    other = "opp" if team == "own" else "own"
    nan4 = (np.nan,) * 4
    own = np.array([ctx.shapes[f].get(team) or nan4 for f in fr], dtype=float).reshape(-1, 4)
    opp = np.array([ctx.shapes[f].get(other) or nan4 for f in fr], dtype=float).reshape(-1, 4)
    b = np.full((len(fr), len(LAGS_S), 2), np.nan)
    if ctx.ball:
        for i, f in enumerate(fr):
            for k, lag in enumerate(LAGS_S):
                p = _ball_near(ctx, int(f - round(lag * fps)))
                if p:
                    b[i, k] = p
    return SeqContext(fr, {int(f): i for i, f in enumerate(fr)}, own, opp, ctx.sign.get(team, 1.0), b, length, width)


def relative(ctx: SeqContext, idx: np.ndarray, xy: np.ndarray) -> np.ndarray:
    """Posición relativa a la forma del equipo propio, orientada (como `priors.relative`, vectorizada)."""
    c, s = ctx.own[idx, :2], ctx.own[idx, 2:]
    return ctx.sign * (xy - c) / s


def features(ctx: SeqContext, idx: np.ndarray, role: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Variables (FEATURE_NAMES) de cada par (cuadro idx, rol). Devuelve X, la posición estática de F4 relativa al
    centroide en metros y orientada (`base`), y la máscara de filas válidas (hay forma del equipo propio y rol)."""
    idx = np.asarray(idx, dtype=int)
    role = np.asarray(role, dtype=float).reshape(-1, 2)
    sg = ctx.sign
    own, opp = ctx.own[idx], ctx.opp[idx]
    c, s = own[:, :2], own[:, 2:]
    base = role * s
    half = np.array([ctx.length / 2, ctx.width / 2])
    ball = sg * (ctx.ball[idx] - c[:, None, :])                     # (m, lags, 2)
    ok = np.isfinite(ball).all(axis=2)
    X = np.hstack([role, s, sg * (c - half), sg * (opp[:, :2] - c), opp[:, 2:],
                   np.where(ok[:, :, None], ball, 0.0).reshape(len(idx), -1), ok.astype(float), base])
    valid = np.isfinite(own).all(axis=1) & np.isfinite(role).all(axis=1)
    X[:, 6:10] = np.where(np.isfinite(X[:, 6:10]), X[:, 6:10], 0.0)  # sin rival en cuadro: 0
    return X, base, valid


def to_field(ctx: SeqContext, idx: np.ndarray, d: np.ndarray) -> np.ndarray:
    """De la posición relativa al centroide (m, orientada) a la cancha."""
    return ctx.own[np.asarray(idx, dtype=int), :2] + ctx.sign * d


def to_relative_m(ctx: SeqContext, idx: np.ndarray, xy: np.ndarray) -> np.ndarray:
    return ctx.sign * (xy - ctx.own[np.asarray(idx, dtype=int), :2])


# --------------------------------------------------------------------------------------------- modelos

class StaticModel:
    """F4 estático: la posición es la media de su rol por la dispersión del equipo; varianza global por eje."""

    def __init__(self) -> None:
        self.var = np.array([25.0, 25.0])

    def fit(self, X: np.ndarray, base: np.ndarray, target: np.ndarray) -> "StaticModel":
        self.var = np.maximum(((target - base) ** 2).mean(axis=0), MIN_VAR_M2)
        return self

    def predict(self, X: np.ndarray, base: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        return base, np.broadcast_to(self.var, base.shape).copy()


class SeqModel:
    """Red pequeña: media = base + corrección, log-varianza por eje. Pérdida gaussiana (heteroscedástica)."""

    def __init__(self, hidden: int = 64, epochs: int = 40, lr: float = 3e-3, batch: int = 2048, seed: int = 0) -> None:
        self.hidden, self.epochs, self.lr, self.batch, self.seed = hidden, epochs, lr, batch, seed
        self.mu = self.sd = None
        self.net = None

    def _torch(self):
        import torch

        return torch

    def fit(self, X: np.ndarray, base: np.ndarray, target: np.ndarray) -> "SeqModel":
        torch = self._torch()
        torch.manual_seed(self.seed)
        rng = np.random.default_rng(self.seed)
        self.mu, self.sd = X.mean(axis=0), np.maximum(X.std(axis=0), 1e-6)
        Xt = torch.tensor((X - self.mu) / self.sd, dtype=torch.float32)
        R = torch.tensor(target - base, dtype=torch.float32)
        self.net = torch.nn.Sequential(torch.nn.Linear(X.shape[1], self.hidden), torch.nn.ReLU(),
                                       torch.nn.Linear(self.hidden, self.hidden), torch.nn.ReLU(),
                                       torch.nn.Linear(self.hidden, 4))
        opt = torch.optim.Adam(self.net.parameters(), lr=self.lr, weight_decay=1e-5)
        n = len(Xt)
        for _ in range(self.epochs):
            perm = torch.tensor(rng.permutation(n))
            for k in range(0, n, self.batch):
                j = perm[k:k + self.batch]
                out = self.net(Xt[j])
                m, lv = out[:, :2], out[:, 2:].clamp(-4, 8)
                loss = (0.5 * ((R[j] - m) ** 2 * torch.exp(-lv) + lv)).sum(dim=1).mean()
                opt.zero_grad()
                loss.backward()
                opt.step()
        return self

    def predict(self, X: np.ndarray, base: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        torch = self._torch()
        with torch.no_grad():
            out = self.net(torch.tensor((X - self.mu) / self.sd, dtype=torch.float32)).numpy().astype(float)
        return base + out[:, :2], np.maximum(np.exp(np.clip(out[:, 2:], -4, 8)), MIN_VAR_M2)


def mahalanobis2(obs: np.ndarray, mean: np.ndarray, var: np.ndarray) -> np.ndarray:
    return (((obs - mean) ** 2) / var).sum(axis=1)


def seq_cost(d2: np.ndarray, weight: float) -> np.ndarray:
    """Costo que se suma en el relleno: weight · min(D², D2_CAP) / 2; 0 donde no se pudo calcular."""
    c = weight * 0.5 * np.minimum(d2, D2_CAP)
    return np.where(np.isfinite(c), c, 0.0)


# --------------------------------------------------------------------------------------------- roles

def _norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    return " ".join(s.replace(".", " ").split())


def resolve_roles(roles: dict[str, str], names: list[str]) -> dict[str, str]:
    """rol -> nombre tal como aparece en `names` (roster / labels). Primero igualdad exacta, luego sin acentos ni
    mayúsculas, luego prefijo único. «Zoe» y «Zoe S.» son personas distintas: la exacta gana. Lo que no se resuelve
    queda fuera (sin inventar)."""
    out: dict[str, str] = {}
    taken: set[str] = set()
    for role, given in roles.items():
        if given in names:
            out[role] = given
            taken.add(given)
    for role, given in roles.items():
        if role in out:
            continue
        g = _norm(given)
        hits = [n for n in names if n not in taken and _norm(n) == g]
        if not hits:
            hits = [n for n in names if n not in taken and _norm(n).startswith(g)]
        if len(hits) == 1:
            out[role] = hits[0]
            taken.add(hits[0])
    return out


def mean_role(ctx: SeqContext, idx: np.ndarray, xy: np.ndarray, min_n: int = 10) -> np.ndarray | None:
    """Rol aprendido: posición relativa media (NaN fuera); None con menos de min_n muestras."""
    r = relative(ctx, idx, xy)
    r = r[np.isfinite(r).all(axis=1)]
    return r.mean(axis=0) if len(r) >= min_n else None


def match_roles(learned: dict[str, np.ndarray], given: dict[str, np.ndarray]) -> dict[str, tuple[str, float]]:
    """Cada rol aprendido con el rol dado más cercano (asignación húngara): nombre -> (rol, distancia)."""
    from scipy.optimize import linear_sum_assignment

    a, b = list(learned), list(given)
    if not a or not b:
        return {}
    D = np.array([[float(np.hypot(*(learned[x] - given[y]))) for y in b] for x in a])
    r, c = linear_sum_assignment(D)
    return {a[i]: (b[j], float(D[i, j])) for i, j in zip(r, c)}


# --------------------------------------------------------------------------------------------- muestras

def truth_samples(frames: list[list[Box]], truth: dict, ctx: SeqContext, people: dict[int, str]):
    """(fila del contexto, posición, nombre) de cada caja de una jugadora con nombre (people: etiqueta -> nombre)."""
    idx, xy, who = [], [], []
    for row in frames:
        for b in row:
            v = truth.get((b.frame, b.track))
            if isinstance(v, int) and v in people and b.frame in ctx.index and np.isfinite(b.xm) and np.isfinite(b.ym):
                idx.append(ctx.index[b.frame])
                xy.append((b.xm, b.ym))
                who.append(people[v])
    return np.array(idx, dtype=int), np.array(xy, dtype=float).reshape(-1, 2), np.array(who, dtype=object)


# --------------------------------------------------------------------------------------------- evaluación

TRAIN = ["v1_6414_13699", "v1_14541_15944", "v1_16648_22211", "v1_23140_26173", "v1_26910_32826", "v1_33818_35062", "v1_36135_41389"]
TEST_V1 = ["v1_41994_43460", "v1_44071_52064", "v1_52933_72647", "v1_73385_78596"]
TEST_V23 = ["v2_0_4259", "v2_5020_10226", "v3_0_6890"]
WEIGHTS = (0.25, 0.5, 1.0)
RATES = (1.0, 3.0)
UNNAMED = 2.0      # elegido en la F3 (anclas_f3.md)


def main(argv: list[str] | None = None) -> None:
    import argparse
    import sys
    import time

    from sportsan.config import load_config, project_root
    from sportsan.tracking.anchors import (_finite_end, _fit, build_chains, fill_both, groups_after_fill,
                                           named_correct, pick_anchors)
    from sportsan.tracking.links_eval import _venue, load_part
    from sportsan.tracking.priors import ball_track
    from sportsan.tracking.tracklets import (FEATURES, LINK_P_MIN, Score, Tracklet, accept_greedy, candidate_labels,
                                             link_candidates, player_features, player_labels, pure_tracklets,
                                             score_groups, tracklet_truth)

    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--match")
    ap.add_argument("--report", default="secuencias_f4b.md")
    ap.add_argument("--cached", action="store_true", help="usar solo las partes que ya tienen la fase 1 en caché (_cache_f4b)")
    args = ap.parse_args(argv)
    t0 = time.time()
    cfg = load_config(match=args.match)
    root = project_root()
    dir_ = root / cfg["paths"]["tracking_dir"]
    names = TRAIN + TEST_V1 + TEST_V23
    if args.cached:
        names = [n for n in names if (dir_ / "revision" / "_cache_f4b" / f"phase1_{n}.pkl").exists()]
        for lst in (TRAIN, TEST_V1, TEST_V23):
            lst[:] = [n for n in lst if n in names]
    prog_path = dir_ / "revision" / "progreso_secuencias.log"
    phase_t = {"name": "", "t": time.time()}

    def progress(phase: str, i: int, total: int) -> None:
        """Log de avance para quien espera: fase, n/N, % y tiempo restante estimado (por el ritmo de la fase)."""
        if phase != phase_t["name"]:
            phase_t.update(name=phase, t=time.time())
        el = time.time() - phase_t["t"]
        eta = f"{el / i * (total - i) / 60:.0f} min" if i else "?"
        prog_path.parent.mkdir(exist_ok=True)
        prog_path.write_text(f"{time.strftime('%Y-%m-%d %H:%M:%S')}\nfase: {phase}\navance: {i}/{total} ({100 * i / max(1, total):.0f} %)\n"
                             f"restante en esta fase: {eta}\ntotal transcurrido: {(time.time() - t0) / 60:.0f} min\n", encoding="utf-8")

    cache_dir = dir_ / "revision" / "_cache_f4b"
    cache_dir.mkdir(parents=True, exist_ok=True)

    def cached(key: str, fn):
        """Resultado guardado en disco (pickle) para reanudar si el proceso muere."""
        import pickle

        f = cache_dir / f"{key}.pkl"
        if f.exists():
            return pickle.loads(f.read_bytes())
        v = fn()
        tmp = f.with_suffix(".tmp")
        tmp.write_bytes(pickle.dumps(v))
        tmp.replace(f)
        return v

    def load_one(n: str):
        p = load_part(dir_, n, feet=True)
        fixed = json.loads((dir_ / f"tracks_fixed_{n}.json").read_text(encoding="utf-8"))
        lab = json.loads((dir_ / f"labels_{n}.json").read_text(encoding="utf-8"))
        name_of = {q["id"]: q.get("player_id") for q in fixed["people"] if q.get("player_id")}
        ppl = {int(x["label"]): name_of[x["label"]] for x in lab["people"]
               if x.get("named") and x.get("team") == "own" and x["label"] in name_of}
        tlab = {int(x["label"]): x.get("team") or "unk" for x in lab["people"]}
        return p, ppl, tlab, seq_context(p.frames, ball_track(fixed), *_venue(dir_, n), p.fps)

    parts, ctx, people, team_lab, fixed_names = {}, {}, {}, {}, set()
    for i, n in enumerate(names):
        progress("1/4 carga de partes (con caché)", i, len(names))
        parts[n], people[n], team_lab[n], ctx[n] = cached(f"part_{n}", lambda n=n: load_one(n))
        fixed_names |= set(people[n].values())
    print(f"partes cargadas {time.time() - t0:.0f} s", flush=True)

    form = json.loads((dir_.parent / "formacion.json").read_text(encoding="utf-8"))
    roster = json.loads((root / "config" / "roster.json").read_text(encoding="utf-8"))
    known = sorted(fixed_names | {r["player_id"] for r in roster.get("players", [])})
    role_of_name = {v: k for k, v in resolve_roles(form["primer_tiempo"]["roles"], known).items()}
    unresolved = sorted(set(form["primer_tiempo"]["roles"]) - set(role_of_name.values()))

    S = {n: truth_samples(parts[n].frames, parts[n].truth, ctx[n], people[n]) for n in names}

    def means(group: list[str]) -> dict[str, np.ndarray]:
        acc: dict[str, list] = {}
        for m in group:
            idx, xy, who = S[m]
            r = relative(ctx[m], idx, xy)
            for w in set(who):
                acc.setdefault(w, []).append(r[who == w])
        out = {}
        for w, rs in acc.items():
            r = np.vstack(rs)
            r = r[np.isfinite(r).all(axis=1)]
            if len(r) >= 30:
                out[w] = r.mean(axis=0)
        return out

    # Rol con formación dada: media de la jugadora (= su rol en el 4-3-3) en el entrenamiento; para cada parte de
    # entrenamiento, sin esa parte.
    form_role = {n: means([m for m in TRAIN if m != n]) for n in TRAIN}
    full_role = means(TRAIN)

    def stack(group, role_fn):
        Xs, Bs, Ts = [], [], []
        for m in group:
            idx, xy, who = S[m]
            roles = role_fn(m)
            emb = np.array([roles.get(w, (np.nan, np.nan)) for w in who], dtype=float).reshape(-1, 2)
            X, base, ok = features(ctx[m], idx, emb)
            T = to_relative_m(ctx[m], idx, xy)
            ok &= np.isfinite(T).all(axis=1)
            Xs.append(X[ok]); Bs.append(base[ok]); Ts.append(T[ok])
        return np.vstack(Xs), np.vstack(Bs), np.vstack(Ts)

    # Modelo con formación (rol = media en las otras partes) y modelo con rol aprendido (media en la propia parte).
    Xf, Bf, Tf = stack(TRAIN, lambda m: form_role[m])
    in_part = {m: means([m]) for m in names}
    Xl, Bl, Tl = stack(TRAIN, lambda m: in_part[m])
    static_f = StaticModel().fit(Xf, Bf, Tf)
    static_l = StaticModel().fit(Xl, Bl, Tl)
    seq_f = SeqModel().fit(Xf, Bf, Tf)
    seq_l = SeqModel().fit(Xl, Bl, Tl)
    print(f"modelos ajustados ({len(Xf)} muestras) {time.time() - t0:.0f} s", flush=True)

    def section1(learned: dict, provisional: bool) -> list[str]:
        def errors(group: list[str], roles_fn, model, ball_only=False):
            es, d2s, n_out = [], [], 0
            for m in group:
                idx, xy, who = S[m]
                roles = roles_fn(m)
                emb = np.array([roles.get(w, (np.nan, np.nan)) for w in who], dtype=float).reshape(-1, 2)
                X, base, ok = features(ctx[m], idx, emb)
                if ball_only:
                    ok &= X[:, FEATURE_NAMES.index("ball_0_ok")] > 0
                mu, var = model.predict(X[ok], base[ok])
                T = to_relative_m(ctx[m], idx[ok], xy[ok])
                es.append(np.hypot(*(mu - T).T))
                d2s.append(mahalanobis2(T, mu, var))
                n_out += int((~ok).sum())
            if not es:
                return np.zeros(0), np.zeros(0)
            e, d2 = np.concatenate(es), np.concatenate(d2s)
            return e, d2

        def err_row(label, group, roles_fn, model):
            if not group:
                return f"| {label} | sin partes en caché | | | | |"
            e, d2 = errors(group, roles_fn, model)
            eb, _ = errors(group, roles_fn, model, ball_only=True)
            inside = float(np.mean(d2 <= 5.99)) if len(d2) else float("nan")    # 95 % de una chi² con 2 grados
            return (f"| {label} | {len(e)} | {np.median(e):.2f} | {np.percentile(e, 90):.2f} | "
                    f"{np.median(eb) if len(eb) else float('nan'):.2f} | {100 * inside:.0f} % |")

        lines = [f"# Unión de tracks, F4b: secuencias del equipo con balón · {cfg.get('match_id', args.match)}", "",
                 f"Entrenamiento: {', '.join(TRAIN)}. Pies corregidos (feet.py). Solo el equipo propio (las rivales no tienen nombre).", "",
                 "Modelo: red de 2 capas (64) en torch CPU con pérdida gaussiana; media = posición estática de F4 (rol × dispersión "
                 "del equipo, sobre su centroide) + corrección; varianza por eje. Entradas: rol (posición relativa media), forma "
                 "de los dos equipos en t (de las cajas, sin nombres) y balón revisado en t, t−1, t−2.5 y t−5 s con máscara. "
                 "Balón: solo marcas a mano de `tracks_fixed` y lo interpolado entre marcas a menos de 2 s (`priors.ball_track`); "
                 "nunca el tracker.", "",
                 "Roles: **formación dada** = media de la jugadora en las partes de entrenamiento (su puesto del 4-3-3 de "
                 "`formacion.json`; en el entrenamiento, sin la parte que se mide). **Rol aprendido** = media de la jugadora en "
                 f"la propia parte, medida solo en sus cadenas ancladas ({max(RATES):g} anclas/min) en la prueba; en el "
                 "entrenamiento, con la verdad de la parte.", "",
                 f"Formación resuelta contra roster + labels: {', '.join(f'{r}={n}' for n, r in sorted(role_of_name.items(), key=lambda x: x[1]))}"
                 + (f". Sin resolver: {', '.join(unresolved)}" if unresolved else "") + ".", ""]
        if provisional:
            lines += ["**Informe parcial.** Aquí el «rol aprendido» de la prueba es la media de la jugadora en la parte según "
                      "la verdad (optimista); se reemplaza por el de las cadenas ancladas cuando termine la fase 1. La sección 2 "
                      "(relleno) está en cálculo.", ""]
        lines += ["## 1. Error de la posición predicha", "",
                  "Error en metros entre la posición predicha y la real de cada caja de jugadora con nombre (cuadros con forma "
                  "del equipo). «Con balón»: solo cuadros con balón revisado en t. «Dentro de la elipse 95 %»: calibración de la "
                  "incertidumbre (debería rondar 95 %).", "",
                  "| Variante | Cajas | Mediana (m) | P90 (m) | Mediana con balón (m) | Dentro de la elipse 95 % |", "|---|---|---|---|---|---|"]
        v1_form = lambda m: full_role  # noqa: E731
        lines.append("| **Prueba v1** | | | | | |")
        lines.append(err_row("F4 estático, formación dada", TEST_V1, v1_form, static_f))
        lines.append(err_row("Secuencias, formación dada", TEST_V1, v1_form, seq_f))
        lines.append(err_row("F4 estático, rol aprendido", TEST_V1, lambda m: learned[m], static_l))
        lines.append(err_row("Secuencias, rol aprendido", TEST_V1, lambda m: learned[m], seq_l))
        lines.append("| **Prueba v2/v3** | | | | | |")
        lines.append(err_row("F4 estático, media de v1 por nombre (referencia)", TEST_V23, v1_form, static_f))
        lines.append(err_row("Secuencias, media de v1 por nombre (referencia)", TEST_V23, v1_form, seq_f))
        lines.append(err_row("F4 estático, rol aprendido", TEST_V23, lambda m: learned[m], static_l))
        lines.append(err_row("Secuencias, rol aprendido", TEST_V23, lambda m: learned[m], seq_l))
        lines += ["", "«Media de v1 por nombre» en v2/v3 supone que cada una juega donde jugó en el primer tiempo (lo que la "
                  "analista dice que no se debe asumir); solo cubre a quien jugó en v1 y sirve de referencia.", ""]
        print("\n".join(lines[-14:]), flush=True)

        # ¿Cuánto se parece el rol aprendido al dado?
        lines += ["### Rol aprendido frente al puesto dado", "",
                  "Cada jugadora con su rol aprendido (cadenas ancladas) emparejada con el puesto más cercano del 4-3-3 del "
                  "primer tiempo (húngaro, distancia en dispersiones del equipo).", "",
                  "| Parte | Jugadora (puesto dado en v1) → puesto más cercano (distancia) |", "|---|---|"]
        given = {role_of_name[w]: r for w, r in full_role.items() if w in role_of_name}
        for n in tests:
            mm = match_roles(learned[n], given)
            lines.append(f"| {n} | " + ", ".join(f"{w} ({role_of_name.get(w, '—')}) → {r} ({d:.2f})" for w, (r, d) in sorted(mm.items())) + " |")
        lines.append("")
        return lines

    tests = [n for n in TEST_V1 + TEST_V23 if n in names]
    v1_form = lambda m: full_role  # noqa: E731
    # Cifras baratas primero: rol aprendido provisional = media de la jugadora en la parte según la verdad (optimista).
    out_path = dir_ / "revision" / args.report
    lines = section1(in_part, True)
    out_path.write_text("\n".join(lines + ["## 2. Relleno entre anclas", "", "_En cálculo._", ""]), encoding="utf-8")
    print("informe parcial escrito", flush=True)

    # Fase 1 + cadenas + anclas (lo mismo que anchors.main), con caché por parte.
    def phase1(n: str):
        t_ = pure_tracklets(parts[n].frames, parts[n].fps)
        pd = (np.array([player_features(t, *_venue(dir_, n), parts[n].fps) for t in t_]), player_labels(t_, parts[n].truth))
        cands = link_candidates(t_, parts[n].fps)
        X = np.array([c.x for c in cands]) if cands else np.zeros((0, len(FEATURES)))
        return t_, pd, (cands, X, candidate_labels(cands, t_, parts[n].truth))

    tl, pdata, ldata = {}, {}, {}
    for i, n in enumerate(names):
        progress("2/4 fase 1: trozos y candidatos de unión (con caché por parte)", i, len(names))
        tl[n], pdata[n], ldata[n] = cached(f"phase1_{n}", lambda n=n: phase1(n))
    progress("2/4 fase 1: trozos y candidatos de unión (con caché por parte)", len(names), len(names))
    pm = _fit([pdata[m][0] for m in TRAIN], [pdata[m][1] for m in TRAIN])
    lm = _fit([ldata[m][1] for m in TRAIN], [ldata[m][2] for m in TRAIN])
    print(f"fase 1 lista {time.time() - t0:.0f} s", flush=True)

    setup = {}
    for n in tests:
        p = parts[n]
        cands, X, _ = ldata[n]
        for c, pr in zip(cands, lm.predict(X)):
            c.p = float(pr)
        player_ok = {t.id for t, pp in zip(tl[n], pm.predict(pdata[n][0])) if pp >= 0.5}
        links = accept_greedy(cands, p_min=LINK_P_MIN, allowed=player_ok)
        link_p = {(c.a, c.b): c.p for c in cands}

        def team_of(t: Tracklet, p=p, n=n) -> str:
            who, _ = tracklet_truth(t, p.truth)
            return team_lab[n].get(who, t.team) if isinstance(who, int) else t.team

        chs = build_chains(tl[n], links, team_of)
        allowed = {c.id for c in chs if c.first in player_ok}
        rows = {r[0].frame: r for r in p.frames if r}
        fr = sorted(rows)
        anchors = {k: pick_anchors(chs, p.truth, rows, p.fps, fr[0], fr[-1] + 1, k, set(people[n]))[0] for k in RATES}
        setup[n] = (chs, allowed, link_p, anchors)

    def learned_roles(n: str, anchors: dict[int, int]) -> dict[str, np.ndarray]:
        """Rol aprendido de cada jugadora: posición relativa media en sus cadenas ancladas (lo que vería la app)."""
        chs = setup[n][0]
        out = {}
        for person in set(anchors.values()):
            bs = [b for c in chs if anchors.get(c.id) == person for b in c.tl.boxes
                  if b.frame in ctx[n].index and np.isfinite(b.xm)]
            if not bs:
                continue
            r = mean_role(ctx[n], np.array([ctx[n].index[b.frame] for b in bs]), np.array([(b.xm, b.ym) for b in bs]))
            if r is not None:
                out[people[n][person]] = r
        return out

    learned = {n: learned_roles(n, setup[n][3][max(RATES)]) for n in tests}

    lines = section1(learned, False)

    # ---- (2) relleno con el costo
    def pair_cost(n: str, roles: dict[str, np.ndarray], model, weight: float):
        """chain.id, persona -> costo; precalculado para todas las cadenas permitidas del equipo propio."""
        chs, allowed, _, _ = setup[n]
        persons = [q for q in people[n] if people[n][q] in roles]
        rows = []
        for c in chs:
            if c.id not in allowed or c.team not in ("own", "unk"):
                continue
            b = _finite_end(c.tl, False)
            if b is None or b.frame not in ctx[n].index:
                continue
            rows.append((c.id, ctx[n].index[b.frame], b.xm, b.ym))
        if not rows or not persons:
            return {}
        cid = np.repeat([r[0] for r in rows], len(persons))
        idx = np.repeat([r[1] for r in rows], len(persons))
        obs = np.repeat([[r[2], r[3]] for r in rows], len(persons), axis=0)
        who = np.tile(persons, len(rows))
        emb = np.array([roles[people[n][q]] for q in who], dtype=float)
        X, base, ok = features(ctx[n], idx, emb)
        cost = np.zeros(len(idx))
        if ok.any():
            mu, var = model.predict(X[ok], base[ok])
            cost[ok] = seq_cost(mahalanobis2(to_relative_m(ctx[n], idx[ok], obs[ok]), mu, var), weight)
        return {(int(a), int(q)): float(v) for a, q, v in zip(cid, who, cost)}

    def run_fill(n: str, k: float, extra: dict | None):
        chs, allowed, link_p, anchors = setup[n]
        fn = (lambda cid, person: extra.get((cid, person), 0.0)) if extra else None
        f = fill_both(chs, anchors[k], parts[n].fps, link_p, team_lab[n], allowed, UNNAMED, extra_cost=fn)
        sc = score_groups(groups_after_fill(chs, f.owner), parts[n].truth)
        tot, ok, bad = named_correct(chs, f.owner, parts[n].truth, set(people[n]))
        return dict(score=sc, tot=tot, ok=ok, bad=bad, doubts=f.doubts, anchors=len(anchors[k]))

    def fill_rows(group: list[str], variants: dict) -> list[str]:
        if not group:
            return ["_Sin partes en caché para esta prueba._"]
        out = []
        total_runs = len(RATES) * len(variants)
        for k in RATES:
            for label, (roles_fn, model, w) in variants.items():
                progress(f"relleno {group[0][:2]}", len(out), total_runs)
                a = dict(score=Score(), tot=0, ok=0, bad=0, doubts=0, anchors=0)
                for n in group:
                    extra = pair_cost(n, roles_fn(n), model, w) if model is not None else None
                    r = run_fill(n, k, extra)
                    a["score"] = a["score"].add(r["score"])
                    for x in ("tot", "ok", "bad", "doubts", "anchors"):
                        a[x] += r[x]
                sc = a["score"]
                out.append(f"| {k:g} | {label} | {100 * sc.purity:.2f} % | {100 * a['ok'] / max(1, a['tot']):.1f} % | "
                           f"{100 * a['bad'] / max(1, a['tot']):.2f} % | {sc.joins_needed + sc.cuts_needed} | {a['doubts']} |")
                print(out[-1], flush=True)
        return out

    head = ["| Anclas/min | Variante | Pureza | Cajas con nombre correcto (cobertura) | Con nombre de otra (error) | Pendientes | Dudas |",
            "|---|---|---|---|---|---|---|"]
    v1_vars = {"F3 sin prior": (None, None, 0)}
    for w in WEIGHTS:
        v1_vars[f"+ F4 estático, formación, w={w:g}"] = (v1_form, static_f, w)
    for w in WEIGHTS:
        v1_vars[f"+ secuencias, formación, w={w:g}"] = (v1_form, seq_f, w)
    for w in WEIGHTS:
        v1_vars[f"+ secuencias, rol aprendido, w={w:g}"] = (lambda m: learned[m], seq_l, w)
    v23_vars = {"F3 sin prior": (None, None, 0)}
    for w in WEIGHTS:
        v23_vars[f"+ F4 estático, rol aprendido, w={w:g}"] = (lambda m: learned[m], static_l, w)
    for w in WEIGHTS:
        v23_vars[f"+ secuencias, rol aprendido, w={w:g}"] = (lambda m: learned[m], seq_l, w)
    lines += ["## 2. Relleno entre anclas (anchors.py) con el costo", "",
              f"F3 tal cual (fase 1 a {LINK_P_MIN}, `unnamed_cost` {UNNAMED:g}, anclas simuladas, equipo de labels) y la misma "
              "con el costo de secuencias sumado a cada par (cadena, jugadora): w · min(D², 16) / 2, D² de Mahalanobis en el "
              "primer cuadro de la cadena. El rol aprendido sale de las anclas de 3/min también en la fila de 1/min.", "",
              "### Prueba v1", ""] + head
    out_path.write_text("\n".join(lines + ["_Relleno en cálculo._", ""]), encoding="utf-8")
    lines += fill_rows(TEST_V1, v1_vars)
    out_path.write_text("\n".join(lines + ["", "_Prueba v2/v3 en cálculo._", ""]), encoding="utf-8")
    lines += ["", "### Prueba v2/v3 (sin formación dada)", ""] + head
    lines += fill_rows(TEST_V23, v23_vars)
    lines += ["", "Pendientes = uniones + cortes que quedan a mano. Dudas: las de `anchors.Fill` (costo, empate, dos sitios, salto).", "",
              f"Tiempo total de la evaluación: {(time.time() - t0) / 60:.1f} min.", ""]
    out = dir_ / "revision" / args.report
    out.parent.mkdir(exist_ok=True)
    out.write_text("\n".join(lines), encoding="utf-8")
    print(f"\nInforme: {out}")


if __name__ == "__main__":
    main()

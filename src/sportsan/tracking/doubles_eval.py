"""Calibración y medición de la segunda pasada de dobles cajas (`doubles.py`) contra la verdad (`labels_*.json`).

    python -m sportsan.tracking.doubles_eval --match <id> [--real v2_34220_45027]

Partes de prueba de v1: modelos entrenados con las de entrenamiento (como `coverage`) y anclas simuladas desde la verdad
(densidad híbrida). Para cada juego de bonos se recorren todos los tramos con doble caja y se anota el margen de la ruta y
si la caja que elige es de verdad la jugadora; el margen elegido es el menor con precisión >= TARGET (por cuadros) y, entre
juegos de bonos, el que más cuadros resuelve eligiendo. Después se mide con esos valores: cuadros resueltos eligiendo /
quitando ambas / como tarea, saltos imposibles y huecos > 4 s, cobertura y errores.

Parte real (`--real`): las anclas de la persona y `link_model.json`; escribe `auto/links_<parte>_nuevo.json` (no pisa
`links_<parte>.json`) y cuenta las dobles cajas que quedan (lo que la mesa marca en amarillo). Informe en
`tracking/revision/dobles_cajas.md`; avance en `tracking/revision/progreso_dobles_cajas.log`.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter

import numpy as np

from sportsan.tracking import doubles as D
from sportsan.tracking.anchors import _fit, camera_sign, person_hybrid_rates, pick_anchors
from sportsan.tracking.anchors_cli import Models, Progress, fill_part, prepare
from sportsan.tracking.doubles import Weights, path_of, player_tracks, resolve, second_pass
from sportsan.tracking.tracklets import FEATURES, candidate_labels, link_candidates, player_features, player_labels, pure_tracklets

TRAIN = "v1_6414_13699,v1_14541_15944,v1_16648_22211,v1_23140_26173,v1_26910_32826,v1_33818_35062,v1_36135_41389"
TEST = "v1_41994_43460,v1_44071_52064,v1_52933_72647,v1_73385_78596"
TARGET = 0.95
MARGINS = [1, 2, 3, 5, 8, 12, 20, 35, 60, 100, 200, 500, 1000, 2000, 1e9]
# (nombre, ancla, cadena de fill, cadena larga, confianza)
CONFIGS = [("base", 6.0, 3.0, 2.0, 1.0), ("fill y larga a la mitad", 6.0, 1.5, 1.0, 1.0),
           ("sin fill ni larga", 6.0, 0.0, 0.0, 1.0), ("solo continuidad y ancla", 6.0, 0.0, 0.0, 0.0)]


class Case:
    """Una parte lista: identidades de fill sin la segunda pasada y lo que necesita `resolve`."""

    def __init__(self, name, prep, anchors, truth):
        self.name, self.prep, self.truth = name, prep, truth
        out = fill_part(prep, anchors, doubles=False)
        self.n_anchors = len(anchors)
        self.out = out.out
        self.tracks_of = player_tracks(self.out["identities"])
        names, owner, anchor_of = out.names, out.owner, {}
        by_id = {c.id: c for c in prep.chains}
        index = {(b.frame, b.track): c.id for c in prep.chains for b in c.tl.boxes}
        for a in anchors:
            cid = index.get((int(a["frame"]), int(a["track"])))
            if cid is not None:
                anchor_of.setdefault(cid, str(a["player"]))
        self.anchored, self.own, self.chain_s = {}, {}, {}
        for c in prep.chains:
            keys = [(b.frame, b.track) for b in c.tl.boxes]
            for k in keys:
                self.chain_s[k] = (c.end - c.start) / prep.fps
            if c.id in owner:
                self.own.setdefault(names[owner[c.id]], set()).update(keys)
                if anchor_of.get(c.id) == names[owner[c.id]]:
                    self.anchored.setdefault(names[owner[c.id]], set()).update(keys)
        del by_id
        frames = sorted(prep.rows)
        self.stride = int(np.median(np.diff(frames))) if len(frames) > 1 else 1
        self.seconds = (frames[-1] - frames[0]) / prep.fps if frames else 0.0
        self.label_of = {}
        for p, tr in self.tracks_of.items():
            v = Counter(truth.get((f, b.track)) for f, r in prep.rows.items() for b in r if b.track in tr)
            v.pop(None, None)
            v.pop("no", None)
            self.label_of[p] = v.most_common(1)[0][0] if v else None

    def run(self, w: Weights, runs_out=None):
        return resolve(self.prep.rows, self.tracks_of, self.prep.fps, self.stride, self.anchored, self.own, self.chain_s,
                       self.prep.conf, w, runs_out)


def run_quality(case: Case, runs: dict) -> list[tuple[float, int, int]]:
    """(margen, cuadros en que la elegida es ella y la otra no, cuadros al revés) por tramo."""
    out = []
    for p, lst in runs.items():
        lab = case.label_of.get(p)
        for frames, chosen, other, m in lst:
            ok = bad = 0
            if lab is not None:
                for f, c in zip(frames, chosen):
                    tc, to = case.truth.get((f, c)), case.truth.get((f, other))
                    ok += tc == lab and to != lab and to is not None
                    bad += to == lab and tc != lab and tc is not None
            out.append((m, ok, bad))
    return out


def measure(case: Case, out_drops: list[dict], doubts: list[dict]) -> dict:
    prep, truth = case.prep, case.truth
    fps = prep.fps
    drops = {(d["frame"], d["track"]) for d in out_drops}
    reason_frames = {r: {(d["player"], d["frame"]) for d in out_drops if d["reason"] == r} for r in D.REASONS}
    res = {"by_reason": dict(Counter(d["reason"] for d in out_drops)), "tareas": len(doubts)}
    for tag, dset in (("antes", set()), ("despues", drops)):
        j = h = ok = interp = err = tot = dbl = 0
        for p, tr in case.tracks_of.items():
            sp = second_pass(path_of(prep.rows, tr, dset, prep.conf), fps)
            j += sp["jumps"]
            h += sp["holes_long"]
            lab = case.label_of[p]
            mine_frames = [f for f in sorted(prep.rows) if any(b.track in tr and (f, b.track) not in dset for b in prep.rows[f])]
            for f, r in prep.rows.items():
                mine = [b for b in r if b.track in tr and (f, b.track) not in dset]
                dbl += len(mine) > 1
                if lab is None or not any(truth.get((f, b.track)) == lab for b in r):
                    continue
                tot += 1
                if any(truth.get((f, b.track)) == lab for b in mine):
                    ok += 1
                elif mine:
                    err += 1
                elif (p, f) in reason_frames["ambas"]:
                    k = np.searchsorted(mine_frames, f)
                    if 0 < k < len(mine_frames) and (mine_frames[k] - mine_frames[k - 1]) / fps <= D.HOLE_S:
                        interp += 1
        res[tag] = {"dobles": dbl, "saltos": j, "huecos_4s": h, "cuadros": tot, "ok": ok, "interp": interp, "err": err}
    a = res["antes"]["dobles"]
    res["resueltos"] = {"elegir": len({x for x in reason_frames["ruta"]} - reason_frames["ambas"]),
                        "ambas": len(reason_frames["ambas"]), "tarea": res["despues"]["dobles"], "total": a}
    return res


def main(argv: list[str] | None = None) -> None:
    from sportsan.config import load_config, project_root
    from sportsan.tracking.links_eval import _venue, load_part

    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--match")
    ap.add_argument("--train", default=TRAIN)
    ap.add_argument("--test", default=TEST)
    ap.add_argument("--real", default="v2_34220_45027")
    args = ap.parse_args(argv)
    cfg = load_config(match=args.match)
    dir_ = project_root() / cfg["paths"]["tracking_dir"]
    pg = Progress(dir_ / "revision" / "progreso_dobles_cajas.log")
    train, test = args.train.split(","), args.test.split(",")
    total = len(train) + len(test) * (1 + len(CONFIGS)) + 2
    step = 0
    Xp, yp, Xl, yl = [], [], [], []
    for n in train:
        pg.log("entrenamiento", step, total)
        p = load_part(dir_, n, True)
        tl = pure_tracklets(p.frames, p.fps)
        L, W = _venue(dir_, n)
        Xp.append(np.array([player_features(t, L, W, p.fps) for t in tl]))
        yp.append(player_labels(tl, p.truth))
        cands = link_candidates(tl, p.fps)
        Xl.append(np.array([c.x for c in cands]) if cands else np.zeros((0, len(FEATURES))))
        yl.append(candidate_labels(cands, tl, p.truth))
        step += 1
    models = Models(_fit(Xl, yl), _fit(Xp, yp))
    cases = []
    for n in test:
        pg.log("preparación de prueba", step, total)
        truth = load_part(dir_, n, False).truth
        prep = prepare(dir_, n, models)
        labels = json.loads((dir_ / f"labels_{n}.json").read_text(encoding="utf-8"))
        people = {int(x["label"]) for x in labels["people"] if x.get("named") and x.get("team") == "own"}
        frames = sorted(prep.rows)
        L, W = prep.venue_lw
        rates, _, _ = person_hybrid_rates(prep.chains, truth, people, camera_sign(prep.frames), L, W)
        anchors_c, _ = pick_anchors(prep.chains, truth, prep.rows, prep.fps, frames[0], frames[-1] + 1, rates, people)
        by_id = {c.id: c for c in prep.chains}
        anchors = [{"frame": by_id[cid].tl.boxes[len(by_id[cid].tl.boxes) // 2].frame,
                    "track": by_id[cid].tl.boxes[len(by_id[cid].tl.boxes) // 2].track, "player": str(person)}
                   for cid, person in anchors_c.items()]
        cases.append(Case(n, prep, anchors, truth))
        step += 1
    # calibración
    sweep = {}
    for name, wa, wo, wl, wc in CONFIGS:
        q = []
        for c in cases:
            pg.log(f"calibración {name}", step, total)
            runs: dict = {}
            c.run(Weights(wa, wo, wl, wc, float("inf")), runs)
            q += run_quality(c, runs)
            step += 1
        rows = []
        for M in MARGINS:
            ok = sum(o for m, o, b in q if m >= M)
            bad = sum(b for m, o, b in q if m >= M)
            rows.append((M, ok, bad, ok / (ok + bad) if ok + bad else float("nan")))
        sweep[name] = ((wa, wo, wl, wc), rows, sum(o + b for _, o, b in q))
    best = None
    for name, (w, rows, _) in sweep.items():
        for M, ok, bad, pr in rows:
            if np.isfinite(pr) and pr >= TARGET and ok + bad > 0:
                if best is None or ok > best[3]:
                    best = (name, w, M, ok, pr)
                break
    if best is None:
        chosen_w = Weights(6.0, 0.0, 0.0, 1.0, float("inf"))
        best = ("ninguno llega", (6.0, 0.0, 0.0, 1.0), float("inf"), 0, float("nan"))
    else:
        chosen_w = Weights(*best[1], best[2])
    results = []
    for c in cases:
        r = c.run(chosen_w)
        results.append((c, measure(c, r.drops, r.doubts)))
    real = None
    if args.real:
        pg.log("parte real", step, total)
        n = args.real
        prep = prepare(dir_, n, Models.load(dir_))
        anchors = json.loads((dir_ / "auto" / f"anchors_{n}.json").read_text(encoding="utf-8"))["anchors"]
        out = fill_part(prep, anchors, weights=chosen_w).out
        (dir_ / "auto" / f"links_{n}_nuevo.json").write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
        real = (n, out["doubt_summary"]["doubles"], len(anchors))
    pg.log("informe", total, total)
    write_report(dir_ / "revision" / "dobles_cajas.md", sweep, best, results, real)
    print((dir_ / "revision" / "dobles_cajas.md").read_text(encoding="utf-8"))


def _pct(x: float) -> str:
    return "—" if not np.isfinite(x) else f"{100 * x:.1f} %"


def write_report(path, sweep, best, results, real) -> None:
    L = ["# Dobles cajas: segunda pasada tras `fill`", "",
         "Generado por `python -m sportsan.tracking.doubles_eval` (código en `src/sportsan/tracking/doubles.py`).", "",
         "Una «doble caja» es un cuadro en que una misma jugadora tiene dos o más cajas en la mesa (sus tracks completos, como "
         "los aplica la app). En la primera ronda ninguna de las cajas descartadas era un duplicado de la misma persona: son dos "
         "personas en una identidad (error de `fill`). Regla: la ruta (programación dinámica con continuidad física y bonos) "
         f"solo elige si su margen alcanza el calibrado para acertar ≥ {TARGET:.0%}; si no, se quitan las dos cajas en los "
         f"cuadros del solape (≤ {D.BOTH_MAX_S:g} s; el relleno de la exportación cierra el hueco) o queda la tarea `dos_sitios`.", "",
         "## Calibración (v1, 4 partes de prueba; precisión por cuadros con verdad en las dos cajas)", "",
         "| bonos (ancla / fill / larga / confianza) | cuadros con verdad | " + " | ".join(f"≥{m:g}" for m in MARGINS[:-1]) + " |",
         "|" + "|".join(["---"] * (len(MARGINS) + 1)) + "|"]
    for name, (w, rows, n) in sweep.items():
        L.append(f"| {name} ({' / '.join(f'{x:g}' for x in w)}) | {n} | " +
                 " | ".join(f"{_pct(pr)} ({ok + bad})" for M, ok, bad, pr in rows[:-1]) + " |")
    L += ["", f"Elegido: **{best[0]}**, margen ≥ {best[2]:g}: {best[3]} cuadros elegidos con precisión {_pct(best[4])}.", "",
          "## Resultado con lo elegido (v1, prueba)", "",
          "Cobertura = cuadros en que la jugadora sale en labels y queda una caja suya que es ella; «+ relleno» suma los "
          "cuadros quitados por `ambas` dentro de un hueco ≤ 4 s (la exportación los rellena con sus vecinos, sin nombre "
          "equivocado). Errores = cuadros en que lo que queda con su nombre es otra persona.", "",
          "| parte | dobles | resueltos eligiendo / quitando ambas / tarea | tareas dos_sitios | saltos antes → después | "
          "huecos > 4 s antes → después | cobertura antes → después (+ relleno) | errores antes → después |",
          "|---|---|---|---|---|---|---|---|"]
    for c, m in results:
        a, d, rs = m["antes"], m["despues"], m["resueltos"]
        cov = lambda x, extra=0: _pct((x["ok"] + extra) / x["cuadros"]) if x["cuadros"] else "—"  # noqa: E731
        L.append(f"| {c.name} | {a['dobles']} | {rs['elegir']} / {rs['ambas']} / {rs['tarea']} | {m['tareas']} | "
                 f"{a['saltos']} → {d['saltos']} | {a['huecos_4s']} → {d['huecos_4s']} | {cov(a)} → {cov(d)} ({cov(d, d['interp'])}) | "
                 f"{a['err']} → {d['err']} |")
    if real:
        n, dbl, k = real
        L += ["", "## Parte real", "",
              f"`{n}` con las {k} anclas de la analista: cuadros con doble caja (avisos amarillos) {dbl['frames_before']} → "
              f"{dbl['frames_after']}; cajas quitadas {dbl['dropped']}; tareas dos_sitios {dbl['undecided']}. Resultado en "
              f"`auto/links_{n}_nuevo.json` (no se pisó `links_{n}.json`). Sin verdad con nombres: no se mide la precisión."]
    path.write_text("\n".join(L) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()

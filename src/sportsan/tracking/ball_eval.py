"""L2: compara variantes del seguimiento de balón contra la verdad de los clips (revision/balon/respuestas.json).

Solo lee cachés (features_*.pkl = clasificador actual; feat2_*.pkl = clasificador reentrenado dejando un clip fuera) y
no escribe pesos ni toca ball_model.pt. Mide por variante: aciertos (<= radio px), marcas lejos, vacíos, marcas donde el
balón no se ve (falsos positivos), error mediano en metros y en cuadros, y precisión por zona (pies/tronco/cabeza/libre).

    python -m sportsan.tracking.ball_eval --match 2026_09_25_tec_ccm_vs_anahuac [--out ruta.json]

Un solo hilo (numpy). Log con % y ETA en stdout.
"""
from __future__ import annotations

import argparse
import json
import math
import pickle
import time
from collections import Counter
from pathlib import Path

import numpy as np

from . import ball as B
from . import ball_compare as C
from . import ball_fp as FP
from . import ball_track as T


def meters_err(feat: dict, f: int, a: tuple[float, float], b: tuple[float, float]) -> float | None:
    H = next((fr["H"] for fr in feat["frames"] if fr["frame"] == f), None)
    ma, mb = B._meters(H, *a), B._meters(H, *b)
    return None if ma is None or mb is None else math.hypot(ma[0] - mb[0], ma[1] - mb[1])


def pred_path(feat: dict, box_cost: bool, min_p: float, tiers: tuple[str, ...], miss: float | None = None, interp: bool = False) -> dict:
    """Camino óptimo con o sin penalización de cajas; se queda con las marcas con p >= min_p (o de un nivel en `tiers`)."""
    old = T.USE_BOX_COST
    T.USE_BOX_COST = box_cost
    try:
        res = T.track(feat, **({"miss": miss} if miss is not None else {}))
    finally:
        T.USE_BOX_COST = old
    out = {}
    for r in res:
        if r["tier"] == "interp":
            if interp:
                out[r["frame"]] = (r["px"], r["py"])
        elif r["tier"] in tiers or r["p"] >= min_p:
            out[r["frame"]] = (r["px"], r["py"])
    return out


def variants() -> dict:
    v = {"actual(decide)": ("features", lambda f: C.baseline_pred(f))}
    for src, tag in (("features", "clf-actual"), ("feat2", "clf-reentrenado")):
        for bc in (False, True):
            for mp in (0.0, 0.3, 0.5, 0.7):
                v[f"{tag} camino box={'si' if bc else 'no'} p>={mp}"] = (src, lambda f, bc=bc, mp=mp: pred_path(f, bc, mp, ("seguro",) if mp == 0.0 else ()))
    # corte duro: solo p alta, sin nivel «seguro» automático
    return v


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--match", required=True)
    ap.add_argument("--radius", type=float, default=C.RADIUS_PX)
    ap.add_argument("--out")
    a = ap.parse_args(argv)
    assert "2026_10_10_tec_ccm_vs_up" not in a.match, "ese partido no se usa"
    clips = C.clips_of([a.match])
    vs = variants()
    total = len(vs) * len(clips)
    done, t0 = 0, time.time()
    rows = {}
    for name, (src, fn) in vs.items():
        tot = {"suelo": dict(n=0, hit=0, wrong=0), "aire": dict(n=0, hit=0, wrong=0), "fp": 0, "hidden": 0}
        errs_m, errs_f, zones = [], [], Counter()
        for clip in clips:
            path = C.cache_path(clip) if src == "features" else C.cache_path(clip).with_name(f"feat2_{clip['id']}.pkl")
            feat = pickle.loads(path.read_bytes())
            frames = [fr["frame"] for fr in feat["frames"]]
            truth, hidden = C.snap(clip, frames)
            pred = fn(feat)
            s = C.score(pred, truth, hidden, feat["k"], a.radius)
            for c in ("suelo", "aire"):
                for key in ("n", "hit", "wrong"):
                    tot[c][key] += s[c][key]
            tot["fp"] += s["fp"]
            tot["hidden"] += s["hidden"]
            by = {fr["frame"]: fr for fr in feat["frames"]}
            for f, (x, y, _air) in truth.items():
                p = pred.get(f)
                if p is None:
                    continue
                d = math.hypot(p[0] - x, p[1] - y)
                e = meters_err(feat, f, p, (x, y))
                if e is not None:
                    errs_m.append(e)
                ok = d <= a.radius * feat["k"]
                zones[(FP.zone_in(by[f]["boxes"], *p), ok)] += 1
                # error en cuadros: distancia temporal al cuadro verdadero más cercano a la marca (0 si acierta)
                if not ok:
                    near = [abs(g - f) for g, t in truth.items() if math.hypot(p[0] - t[0], p[1] - t[1]) <= a.radius * feat["k"]]
                    if near:
                        errs_f.append(min(near))
            done += 1
            el = time.time() - t0
            print(f"{time.strftime('%H:%M:%S')} {done}/{total} {done / total:4.0%} ETA {el / done * (total - done):.0f}s · {name} · {clip['id']}", flush=True)
        n = tot["suelo"]["n"] + tot["aire"]["n"]
        hit = tot["suelo"]["hit"] + tot["aire"]["hit"]
        wrong = tot["suelo"]["wrong"] + tot["aire"]["wrong"]
        marks = hit + wrong
        zs = {}
        for z in ("pies", "tronco", "cabeza", "junto", "libre"):
            ok, bad = zones[(z, True)], zones[(z, False)]
            zs[z] = {"n": ok + bad, "precision": round(ok / (ok + bad), 2) if ok + bad else None}
        rows[name] = {
            "suelo_hit": f"{tot['suelo']['hit']}/{tot['suelo']['n']}", "aire_hit": f"{tot['aire']['hit']}/{tot['aire']['n']}",
            "cobertura": round(hit / n, 3), "precision_de_marcas": round(hit / marks, 3) if marks else None,
            "fp_sin_balon": f"{tot['fp']}/{tot['hidden']}",
            "err_m_mediana": round(float(np.median(errs_m)), 1) if errs_m else None,
            "err_m_p90": round(float(np.percentile(errs_m, 90)), 1) if errs_m else None,
            "err_cuadros_mediana_en_fallos": float(np.median(errs_f)) if errs_f else None,
            "zonas": zs,
        }
    for k, r in rows.items():
        print(f"{k:<44} suelo {r['suelo_hit']:<6} aire {r['aire_hit']:<6} cob {r['cobertura']:.0%} prec {r['precision_de_marcas']} fp {r['fp_sin_balon']} errm {r['err_m_mediana']}/{r['err_m_p90']}")
    if a.out:
        Path(a.out).write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()

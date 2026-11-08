"""Ejemplos de balón marcados por la analista (positivos y falsos positivos) para reentrenar el clasificador.

Flujo (la analista marca en la página /revision/ejemplos de la app; aquí está todo lo que corre en Python):

    1. python -m sportsan.tracking.ball_examples plan --match <id> [--n 160]
         Elige cuadros repartidos por las partes procesadas del partido -> tracking/revision/balon/ejemplos_plan.json.
         La página los muestra de uno en uno: ella marca el balón (o «no se ve»). Meta: unos 100 positivos.
    2. python -m sportsan.tracking.ball_examples trial --match <id> --video v2 --start 12:00 --seconds 45
         Reentrena con los positivos (y los negativos que ya haya) un modelo NUEVO en weights/ y lo corre solo sobre ese
         tramo corto -> tracking/revision/balon/ensayo.json. No toca ni los ball_auto_*.json ni el modelo vigente.
    3. La analista marca en la página los falsos positivos del ensayo (zapato, cabeza, yarda, otro) y los que sí eran balón.
    4. python -m sportsan.tracking.ball_examples train --match <id>
         Reentrena con positivos + falsos positivos (negativos duros, x3) y mide con una reserva de los positivos.
    status: cuántos hay de cada cosa.

Archivo de verdad (ejemplos.json, kind "ball_examples"), en píxeles del video y t_video = frame / fps:
    positives [{id, video_id, t_video, px:[x,y], aerial}]   el balón está ahí (aerial: va por el aire)
    skipped   [{id, video_id, t_video}]                       no se ve / no se pudo marcar
    negatives [{id, video_id, t_video, px:[x,y], why}]        lo que marca el ensayo en px NO es balón (why: zapato|cabeza|yarda|otro)
Nunca se entrena sin que ese archivo exista y tenga positivos; los ball_samples del Playground no se tocan.
"""
from __future__ import annotations

import argparse
import json
import math
import random
import re
import time
from pathlib import Path

import numpy as np

from ..config import project_root
from . import ball as B

REV = ("tracking", "revision", "balon")
EXAMPLES = "ejemplos.json"
PLAN = "ejemplos_plan.json"
TRIAL = "ensayo.json"
WHY = ("zapato", "cabeza", "yarda", "otro")
MIN_POSITIVES = 30  # menos que esto: el modelo sale inservible; se pide --small para entrenar de todos modos
HARD_REPEAT = 3  # cada falso positivo marcado vale por tantos en el entrenamiento
PLAN_GAP_S = 6.0  # separación mínima entre dos cuadros del plan (cuadros vecinos casi iguales no aportan)
HEADER_RE = re.compile(r'"fps":\s*([0-9.]+)')


def revision_dir(folder: Path) -> Path:
    return folder.joinpath(*REV)


# ----------------------------------------------------------------------------------------------------- archivo de verdad
def empty_examples() -> dict:
    return {"kind": "ball_examples", "positives": [], "skipped": [], "negatives": []}


def _xy(v, what: str) -> list[float]:
    if not isinstance(v, (list, tuple)) or len(v) != 2 or not all(isinstance(c, (int, float)) and not isinstance(c, bool) and math.isfinite(c) for c in v):
        raise ValueError(f"{what}: se esperaba [x, y] numérico, llegó {v!r}")
    return [float(v[0]), float(v[1])]


def _t(v, what: str) -> float:
    if not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v) or v < 0:
        raise ValueError(f"{what} inválido: {v!r}")
    return float(v)


def parse_examples(doc: dict | str | Path) -> dict:
    """Lee y valida ejemplos.json; lanza ValueError con la posición del elemento malo."""
    if not isinstance(doc, dict):
        doc = json.loads(Path(doc).read_text(encoding="utf-8"))
    if doc.get("kind") != "ball_examples":
        raise ValueError(f"kind debe ser 'ball_examples', llegó {doc.get('kind')!r}")
    out = empty_examples()
    for i, p in enumerate(doc.get("positives") or []):
        if not p.get("video_id"):
            raise ValueError(f"positives[{i}]: falta video_id")
        out["positives"].append({"id": str(p.get("id", f"p{i}")), "video_id": p["video_id"], "t_video": _t(p.get("t_video"), f"positives[{i}].t_video"),
                                 "px": _xy(p.get("px"), f"positives[{i}].px"), "aerial": bool(p.get("aerial", False))})
    for i, s in enumerate(doc.get("skipped") or []):
        out["skipped"].append({"id": str(s.get("id", f"s{i}")), "video_id": s["video_id"], "t_video": _t(s.get("t_video"), f"skipped[{i}].t_video")})
    for i, n in enumerate(doc.get("negatives") or []):
        if not n.get("video_id"):
            raise ValueError(f"negatives[{i}]: falta video_id")
        why = n.get("why", "otro")
        out["negatives"].append({"id": str(n.get("id", f"n{i}")), "video_id": n["video_id"], "t_video": _t(n.get("t_video"), f"negatives[{i}].t_video"),
                                 "px": _xy(n.get("px"), f"negatives[{i}].px"), "why": why if why in WHY else "otro"})
    return out


def load_examples(folder: Path) -> dict:
    path = revision_dir(folder) / EXAMPLES
    return parse_examples(path) if path.exists() else empty_examples()


# --------------------------------------------------------------------------------------------------------------- plan
def sample_plan(pool: list[dict], n: int, seed: int = 1, gap_s: float = PLAN_GAP_S) -> list[dict]:
    """Elige hasta n cuadros del conjunto {video_id, frame, fps} al azar, a más de gap_s unos de otros (por video).
    Devuelve [{id, video_id, frame, t_video, fps}] ordenados por video y tiempo. Determinista con `seed`."""
    rng = random.Random(seed)
    order = list(pool)
    rng.shuffle(order)
    chosen: list[dict] = []
    taken: dict[str, list[float]] = {}
    for c in order:
        t = c["frame"] / c["fps"]
        if any(abs(t - u) < gap_s for u in taken.get(c["video_id"], [])):
            continue
        taken.setdefault(c["video_id"], []).append(t)
        chosen.append({"video_id": c["video_id"], "frame": int(c["frame"]), "fps": float(c["fps"]), "t_video": round(t, 4)})
        if len(chosen) >= n:
            break
    chosen.sort(key=lambda c: (c["video_id"], c["t_video"]))
    # El orden en que se muestran es mezclado (si no, todos los cuadros seguidos serían del mismo minuto del partido).
    shown = list(chosen)
    random.Random(seed + 1).shuffle(shown)
    return [{"id": f"e{i + 1:03d}", **c} for i, c in enumerate(shown)]


def plan(match: str, n: int = 160, seed: int = 1) -> Path:
    folder = B.match_dir(match)
    pool = []
    for part in B.parts_of(folder):
        tr = json.loads(part.read_text(encoding="utf-8"))
        for fr in tr["frames"]:
            if fr.get("H") is not None:
                pool.append({"video_id": tr["video_id"], "frame": fr["frame"], "fps": tr["fps"]})
    if not pool:
        raise SystemExit(f"{match}: no hay partes con calibración en tracking/ (tracks_v*_*_*.json).")
    items = sample_plan(pool, n, seed)
    out = revision_dir(folder) / PLAN
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"kind": "ball_examples_plan", "match": match, "seed": seed, "items": items}, ensure_ascii=False), encoding="utf-8")
    print(f"{len(items)} cuadros en {out}")
    return out


# --------------------------------------------------------------------------------------------------------- entrenamiento
def _group(ex: dict) -> dict[str, dict]:
    """Por video: sus positivos y negativos."""
    g: dict[str, dict] = {}
    for kind in ("positives", "negatives"):
        for e in ex[kind]:
            g.setdefault(e["video_id"], {"positives": [], "negatives": []})[kind].append(e)
    return g


def hard_negatives(sf: B.SampleFrames, negatives: list[dict]) -> np.ndarray:
    """Recortes de los candidatos que la analista marcó como «no es balón» (el más cercano a px, a <= 2 * POS_R_PX)."""
    out = []
    for n in negatives:
        r = sf.features(sf.frame_of(n["t_video"]))
        if r is None:
            continue
        _, _, pts, P = r
        if len(pts) == 0:
            continue
        d = np.hypot(pts[:, 0] - n["px"][0], pts[:, 1] - n["px"][1])
        j = int(np.argmin(d))
        if d[j] <= 2 * B.POS_R_PX:
            out.append(P[j:j + 1])
    return np.concatenate(out) if out else np.zeros((0, 4, B.PATCH, B.PATCH), np.float32)


def train(match: str, out: Path | None = None, epochs: int = 12, holdout: float = 0.2, seed: int = 0, small: bool = False, negatives: bool = True) -> Path:
    """Modelo nuevo con los ejemplos de la analista. Nunca sobrescribe un modelo existente (nombre con fecha)."""
    import torch

    folder = B.match_dir(match)
    ex = load_examples(folder)
    npos = len(ex["positives"])
    if npos == 0:
        raise SystemExit(f"{match}: ejemplos.json no tiene positivos. Se marcan en la página /revision/ejemplos; no se entrena sin ellos.")
    if npos < MIN_POSITIVES and not small:
        raise SystemExit(f"{match}: solo {npos} positivos (mínimo {MIN_POSITIVES}). Marca más o usa --small para probar el código.")
    out = B.safe_model_path(out or project_root() / "weights" / f"ball_model_ejemplos_{time.strftime('%Y%m%d_%H%M%S')}.pt", "ejemplos")
    prog = B.BallProgress(revision_dir(folder) / "progreso_ejemplos.log", echo=True)
    Xs, ys, info_all, ho_all = [], [], {"used": 0, "skipped_no_candidate": 0}, []
    n_hard = 0
    groups = _group(ex)
    for gi, (video, g) in enumerate(sorted(groups.items()), 1):
        sf = B.SampleFrames(folder, video)
        ts = [p["t_video"] for p in g["positives"]]
        tr_i, ho_i = B.split_holdout(ts, holdout, seed)
        tr_s = [dict(g["positives"][i], shadow_px=None) for i in tr_i]
        ho_s = [dict(g["positives"][i], shadow_px=None) for i in ho_i]
        if tr_s:
            X, y, info = B.collect_samples(sf, tr_s, [], False, lambda ph, n, t, gi=gi: prog.log(f"{video} {ph}", n, t), seed)
            Xs.append(X)
            ys.append(y)
            for k in info_all:
                info_all[k] += info.get(k, 0)
        if negatives and g["negatives"]:
            H = hard_negatives(sf, g["negatives"])
            n_hard += len(H)
            if len(H):
                Xs.append(np.repeat(H, HARD_REPEAT, axis=0))
                ys.append(np.zeros(len(H) * HARD_REPEAT, np.float32))
        ho_all.append((sf, ho_s))
    if not Xs:
        raise SystemExit("Ningún ejemplo cayó sobre un candidato: no hay con qué entrenar (revisa px, fps y t_video).")
    X, y = np.concatenate(Xs), np.concatenate(ys)
    print(f"{int(y.sum())} positivos, {int((1 - y).sum())} negativos ({n_hard} falsos positivos marcados x{HARD_REPEAT}); {info_all['skipped_no_candidate']} marcas sin candidato cerca")
    t0 = time.time()
    net = B.fit(X, y, epochs=epochs, seed=seed, on_epoch=lambda e, n: prog.log("épocas", e, n))

    def predict(P):
        with torch.no_grad():
            return torch.sigmoid(net(torch.from_numpy(P))).numpy().ravel()

    report = {}
    for sf, ho_s in ho_all:
        if ho_s:
            report[sf.path.name] = B.evaluate_holdout(sf, predict, ho_s, [], False, lambda ph, n, t: prog.log(ph, n, t))
    meta = {"matches": [match], "positives": int(y.sum()), "negatives": int((1 - y).sum()), "hard_negatives": n_hard, "trained": time.strftime("%Y-%m-%d %H:%M"),
            "patch": B.PATCH, "positives_from": "ejemplos", "search": "pitch", "epochs": epochs, "seed": seed, "validation": report, **info_all}
    out.parent.mkdir(parents=True, exist_ok=True)
    torch.save({"weights": net.state_dict(), "meta": meta}, out)
    out.with_suffix(".json").write_text(json.dumps(meta, indent=1, ensure_ascii=False), encoding="utf-8")
    prog.log("listo", 1, 1)
    print(f"Modelo en {out} ({time.time() - t0:.0f} s). Reserva: {json.dumps(report, ensure_ascii=False)[:600]}")
    return out


# ------------------------------------------------------------------------------------------------------------- ensayo
def trial(match: str, video: str, start: float, seconds: float = 45.0, out: Path | None = None, epochs: int = 12, small: bool = False,
          model_path: Path | None = None) -> Path:
    """Entrena con los ejemplos (si no se da `model_path`) y corre el balón solo sobre [start, start + seconds] de la parte
    que lo cubre. Escribe tracking/revision/balon/ensayo.json (mismo formato que ball_auto, kind 'ball_trial') con el avance
    en progreso_ejemplos.log. No escribe ningún ball_auto_*.json."""
    from . import ball_track as T

    folder = B.match_dir(match)
    if seconds > 120:
        raise SystemExit("El ensayo es una prueba corta (máx. 120 s); para una parte completa usa la cola.")
    model_file = model_path or train(match, epochs=epochs, small=small)
    model = B.BallModel(model_file)
    part = None
    for p in B.parts_of(folder, video):
        m = B.PART_RE.match(p.name)
        m0, m1 = int(m.group(2)), int(m.group(3))
        with p.open(encoding="utf-8") as fh:
            fps = float(HEADER_RE.search(fh.read(4000)).group(1))
        if m0 <= start * fps < m1:
            part = p
            break
    if part is None:
        raise SystemExit(f"{match}/{video}: ninguna parte procesada cubre t = {start:.0f} s.")
    f0 = int(round(start * fps))
    f1 = int(round((start + seconds) * fps))
    prog = B.BallProgress(revision_dir(folder) / "progreso_ejemplos.log", echo=True)
    r = T.run_part_new(part, model, folder, prog, model_file, frame_range=(f0, f1))
    r["kind"] = "ball_trial"
    r["trial"] = {"start_s": start, "seconds": seconds, "part": part.name, "model_file": str(model_file)}
    dest = out or revision_dir(folder) / TRIAL
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(r), encoding="utf-8")
    prog.log("listo", 1, 1)
    print(f"Ensayo en {dest}: {r['quality']['found']} marcas en {r['quality']['processed']} cuadros. Márcalas en /revision/ejemplos (pestaña Falsos positivos).")
    return dest


def status(match: str) -> dict:
    folder = B.match_dir(match)
    ex = load_examples(folder)
    plan_path = revision_dir(folder) / PLAN
    n_plan = len(json.loads(plan_path.read_text(encoding="utf-8"))["items"]) if plan_path.exists() else 0
    s = {"plan": n_plan, "positivos": len(ex["positives"]), "no_se_ve": len(ex["skipped"]), "falsos_positivos": len(ex["negatives"]),
         "por_motivo": {w: sum(1 for n in ex["negatives"] if n["why"] == w) for w in WHY}, "ensayo": (revision_dir(folder) / TRIAL).exists()}
    print(json.dumps(s, ensure_ascii=False))
    return s


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("plan")
    p.add_argument("--match", required=True)
    p.add_argument("--n", type=int, default=160)
    p.add_argument("--seed", type=int, default=1)
    t = sub.add_parser("trial")
    t.add_argument("--match", required=True)
    t.add_argument("--video", required=True)
    t.add_argument("--start", required=True, help="inicio en el video: segundos o h:mm:ss")
    t.add_argument("--seconds", type=float, default=45.0)
    t.add_argument("--epochs", type=int, default=12)
    t.add_argument("--small", action="store_true", help="entrenar aunque haya menos de %d positivos (solo para probar el código)" % MIN_POSITIVES)
    t.add_argument("--model", help="usa este modelo en vez de reentrenar")
    t.add_argument("--out", help="archivo de salida (por defecto ensayo.json de la carpeta)")
    r = sub.add_parser("train")
    r.add_argument("--match", required=True)
    r.add_argument("--epochs", type=int, default=12)
    r.add_argument("--holdout", type=float, default=0.2)
    r.add_argument("--small", action="store_true")
    r.add_argument("--no-negatives", action="store_true")
    r.add_argument("--out")
    s = sub.add_parser("status")
    s.add_argument("--match", required=True)
    a = ap.parse_args(argv)
    if a.cmd == "plan":
        plan(a.match, a.n, a.seed)
    elif a.cmd == "status":
        status(a.match)
    elif a.cmd == "train":
        train(a.match, Path(a.out) if a.out else None, a.epochs, a.holdout, small=a.small, negatives=not a.no_negatives)
    else:
        from ..timebase import parse_hms

        start = float(a.start) if re.fullmatch(r"[0-9.]+", a.start) else parse_hms(a.start)
        trial(a.match, a.video, start, a.seconds, Path(a.out) if a.out else None, a.epochs, a.small, Path(a.model) if a.model else None)


if __name__ == "__main__":
    main()

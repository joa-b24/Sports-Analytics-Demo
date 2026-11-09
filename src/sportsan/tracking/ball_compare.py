"""Compara modelos de balón contra la verdad marcada a mano en los clips de /revision (Verdad del balón).

La verdad vive en matches/<id>/tracking/revision/balon/{clips,respuestas}.json (kind "ball_truth"): el balón en píxeles
por cuadro, con la bandera `aerial` (vuelo) y los cuadros donde no se ve (`hidden`). No son muestras de entrenamiento.

Uso (raíz del repo):
    python -m sportsan.tracking.ball_compare features            # candidatos y probabilidades por cuadro de cada clip (caché)
    python -m sportsan.tracking.ball_compare report [--model actual|nuevo] [--radius 15]
"""
from __future__ import annotations

import argparse
import json
import pickle
import time
from pathlib import Path

import numpy as np

from ..config import project_root
from . import ball as B

RADIUS_PX = 15.0
SNAP_FRAMES = 1  # la verdad se pega al cuadro procesado más cercano si está a menos de esto


def clips_of(matches: list[str] | None = None) -> list[dict]:
    """Clips con su verdad: [{id, match, video_id, fps, f0, f1, truth: {frame: (x, y, aerial)}, hidden: {frame}}]."""
    out = []
    root = project_root() / "matches"
    for d in sorted(p for p in root.iterdir() if p.is_dir()):
        if matches and d.name not in matches:
            continue
        cj = d / "tracking" / "revision" / "balon" / "clips.json"
        rj = d / "tracking" / "revision" / "balon" / "respuestas.json"
        if not (cj.exists() and rj.exists()):
            continue
        answers = json.loads(rj.read_text(encoding="utf-8")).get("clips", {})
        for c in json.loads(cj.read_text(encoding="utf-8"))["clips"]:
            a = answers.get(c["id"])
            if not a:
                continue
            fps = c["fps"]
            truth = {round(s["t_video"] * fps): (s["px"][0], s["px"][1], bool(s["aerial"])) for s in a["samples"]}
            hidden = {round(t * fps) for t in a["hidden"]}
            out.append({"id": c["id"], "match": d.name, "video_id": c["video_id"], "fps": fps, "f0": min(truth.keys() | hidden), "f1": max(truth.keys() | hidden),
                        "truth": truth, "hidden": hidden})
    return out


def part_frames(match: str, video: str, f0: int, f1: int) -> tuple[dict, list[dict]]:
    """La parte de tracking que cubre [f0, f1] y sus cuadros procesados vecinos (con margen para el movimiento)."""
    folder = B.match_dir(match)
    for p in B.parts_of(folder, video):
        m = B.PART_RE.match(p.name)
        if int(m.group(2)) <= f0 and f1 <= int(m.group(3)):
            tr = json.loads(p.read_text(encoding="utf-8"))
            frames = [fr for fr in tr["frames"] if f0 - 12 <= fr["frame"] <= f1 + 12]
            return tr, frames
    raise SystemExit(f"{match} {video}: ninguna parte de tracking cubre los cuadros {f0}-{f1}")


def cache_path(clip: dict) -> Path:
    return B.match_dir(clip["match"]) / "tracking" / "revision" / "balon" / f"features_{clip['id']}.pkl"


def build_features(clip: dict, model: B.BallModel, force: bool = False) -> dict:
    """Candidatos y probabilidad de cada uno en los cuadros procesados del clip, con H y cajas. Se guarda en caché."""
    path = cache_path(clip)
    if path.exists() and not force:
        return pickle.loads(path.read_bytes())
    folder = B.match_dir(clip["match"])
    tr, frames = part_frames(clip["match"], clip["video_id"], clip["f0"], clip["f1"])
    venue = B.venue_of(folder, tr)
    walker = B.FrameWalker(B.video_of(folder, clip["video_id"]))
    k = tr["image_h"] / 1080
    per = []
    t0 = time.time()
    for f, pts, P in B.frame_features(walker, frames, venue, search=model.meta.get("search", "pitch"), k=k, cap=None):
        per.append((f, pts, model.predict(P)))
    by = {fr["frame"]: fr for fr in frames}
    data = {"clip": clip["id"], "k": k, "fps": tr["fps"], "venue": venue, "stride": tr["stride"],
            "frames": [{"frame": f, "pts": pts, "p": p, "H": by[f].get("H"), "boxes": by[f].get("boxes") or []} for f, pts, p in per]}
    path.write_bytes(pickle.dumps(data))
    print(f"{clip['id']}: {len(per)} cuadros en {time.time() - t0:.0f} s", flush=True)
    return data


def patches_path(clip: dict) -> Path:
    return B.match_dir(clip["match"]) / "tracking" / "revision" / "balon" / f"patches_{clip['id']}.npz"


def build_patches(clip: dict, force: bool = False) -> Path:
    """Candidatos como los ve producción (los MAX_CANDIDATES más blancos por cuadro) con su recorte (uint8) y su H/cajas.
    Sirven para reentrenar el clasificador y para volver a puntuar sin leer el video."""
    path = patches_path(clip)
    if path.exists() and not force:
        return path
    feat = pickle.loads(cache_path(clip).read_bytes())
    folder = B.match_dir(clip["match"])
    tr, frames = part_frames(clip["match"], clip["video_id"], clip["f0"], clip["f1"])
    venue = B.venue_of(folder, tr)
    walker = B.FrameWalker(B.video_of(folder, clip["video_id"]))
    by = {fr["frame"]: fr for fr in feat["frames"]}
    fr_list, X = [], []
    t0 = time.time()
    for f, pts, P in B.frame_features(walker, frames, venue, search="pitch", k=feat["k"], cap=B.MAX_CANDIDATES):
        fr_list.append(f)
        X.append((P * 255).round().astype(np.uint8))
        by[f] = {**by[f], "pts200": pts}
    pts = [by[f]["pts200"] for f in fr_list]
    np.savez(path, patches=np.concatenate(X), counts=np.array([len(p) for p in pts]), frames=np.array(fr_list), pts=np.concatenate(pts))
    print(f"{clip['id']}: {sum(len(p) for p in pts)} recortes en {time.time() - t0:.0f} s", flush=True)
    return path


def snap(clip: dict, frames: list[int]) -> tuple[dict, set]:
    """Verdad pegada a los cuadros procesados: {frame_procesado: (x, y, aerial)}, {frame_procesado} sin verse."""
    arr = np.array(frames)

    def near(f):
        i = int(np.argmin(np.abs(arr - f)))
        return int(arr[i]) if abs(int(arr[i]) - f) <= SNAP_FRAMES else None

    truth, hidden = {}, set()
    for f, v in clip["truth"].items():
        g = near(f)
        if g is not None:
            truth[g] = v
    for f in clip["hidden"]:
        g = near(f)
        if g is not None and g not in truth:
            hidden.add(g)
    return truth, hidden


def candidate_recall(feat: dict, truth: dict, radius: float = RADIUS_PX) -> dict:
    """¿Aparece el balón verdadero entre los candidatos? Por clase (suelo / aire), y con qué probabilidad."""
    r = {"suelo": [0, 0, 0], "aire": [0, 0, 0]}  # total, con candidato, con candidato p >= 0.5
    for fr in feat["frames"]:
        t = truth.get(fr["frame"])
        if t is None:
            continue
        c = r["aire" if t[2] else "suelo"]
        c[0] += 1
        if len(fr["pts"]):
            d = np.hypot(fr["pts"][:, 0] - t[0], fr["pts"][:, 1] - t[1])
            j = int(np.argmin(d))
            if d[j] <= radius * feat["k"]:
                c[1] += 1
                c[2] += int(fr["p"][j] >= 0.5)
    return r


def score(pred: dict[int, tuple[float, float]], truth: dict, hidden: set, k: float = 1.0, radius: float = RADIUS_PX) -> dict:
    """pred: {frame: (x, y)}. hit = a menos de `radius` px del balón verdadero; wrong = hay marca pero lejos; fp = marca donde no se ve."""
    s = {"suelo": dict(n=0, hit=0, wrong=0), "aire": dict(n=0, hit=0, wrong=0), "fp": 0, "hidden": len(hidden)}
    for f, (x, y, air) in truth.items():
        c = s["aire" if air else "suelo"]
        c["n"] += 1
        p = pred.get(f)
        if p is not None:
            if np.hypot(p[0] - x, p[1] - y) <= radius * k:
                c["hit"] += 1
            else:
                c["wrong"] += 1
    s["fp"] = sum(1 for f in hidden if f in pred)
    return s


def baseline_pred(feat: dict) -> dict[int, tuple[float, float]]:
    """Lo que marca el modelo actual (decide + drop_detours), sin las banderas."""
    per = [(fr["frame"], fr["pts"], fr["p"]) for fr in feat["frames"]]
    Hs = {fr["frame"]: fr["H"] for fr in feat["frames"]}
    found = B.drop_detours(B.decide(per, feat["k"]), Hs, feat["venue"], feat["fps"])
    return {b["frame"]: (b["px"], b["py"]) for b in found}


def fmt(c: dict) -> str:
    n = max(1, c["n"])
    return f"{c['hit']:>3}/{c['n']:<3} acierta {c['hit'] / n:4.0%} · lejos {c['wrong'] / n:4.0%} · vacío {(c['n'] - c['hit'] - c['wrong']) / n:4.0%}"


def report(model: str = "actual", radius: float = RADIUS_PX, matches: list[str] | None = None) -> dict:
    track_pred = None
    if model in ("nuevo", "mejorado"):
        from .ball_track import track_pred  # el modelo nuevo; se importa solo si se pide

    tot = {"suelo": dict(n=0, hit=0, wrong=0), "aire": dict(n=0, hit=0, wrong=0), "fp": 0, "hidden": 0}
    rec = {"suelo": [0, 0, 0], "aire": [0, 0, 0]}
    print(f"modelo: {model} · radio {radius:.0f} px")
    for clip in clips_of(matches):
        path = cache_path(clip) if model != "mejorado" else cache_path(clip).with_name(f"feat2_{clip['id']}.pkl")
        if not path.exists():
            print(f"{clip['id']}: sin caché ({path.name}; corre `features` / `ball_retrain loco`)")
            continue
        feat = pickle.loads(path.read_bytes())
        truth, hidden = snap(clip, [fr["frame"] for fr in feat["frames"]])
        pred = baseline_pred(feat) if model == "actual" else track_pred(feat)
        s = score(pred, truth, hidden, feat["k"], radius)
        r = candidate_recall(feat, truth, radius)
        print(f"{clip['id']:<12} suelo {fmt(s['suelo'])} | aire {fmt(s['aire'])} | marcas donde no se ve: {s['fp']}/{s['hidden']}")
        for c in ("suelo", "aire"):
            for key in ("n", "hit", "wrong"):
                tot[c][key] += s[c][key]
            rec[c] = [a + b for a, b in zip(rec[c], r[c])]
        tot["fp"] += s["fp"]
        tot["hidden"] += s["hidden"]
    print(f"{'TOTAL':<12} suelo {fmt(tot['suelo'])} | aire {fmt(tot['aire'])} | marcas donde no se ve: {tot['fp']}/{tot['hidden']}")
    for c in ("suelo", "aire"):
        n, anyc, good = rec[c]
        print(f"candidatos ({c}): el balón verdadero está entre ellos en {anyc}/{n} ({anyc / max(1, n):.0%}); con p >= 0.5 en {good}/{n} ({good / max(1, n):.0%})")
    return tot


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("features")
    f.add_argument("--force", action="store_true")
    f.add_argument("--weights", help="modelo del clasificador (por defecto weights/ball_model.pt)")
    f.add_argument("--match", action="append")
    pa = sub.add_parser("patches")
    pa.add_argument("--force", action="store_true")
    pa.add_argument("--match", action="append")
    r = sub.add_parser("report")
    r.add_argument("--model", choices=["actual", "nuevo", "mejorado"], default="actual")
    r.add_argument("--radius", type=float, default=RADIUS_PX)
    r.add_argument("--match", action="append")
    a = ap.parse_args(argv)
    if a.cmd == "features":
        model = B.BallModel(Path(a.weights) if a.weights else project_root() / "weights" / B.MODEL_NAME)
        for clip in clips_of(a.match):
            build_features(clip, model, a.force)
    elif a.cmd == "patches":
        for clip in clips_of(a.match):
            build_patches(clip, a.force)
    else:
        report(a.model, a.radius, a.match)


if __name__ == "__main__":
    main()

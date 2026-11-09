"""Muestra para revisar la corrección de pies (feet.py) en la app (/revision/pies, temporal).

Dos tipos de caso, mezclados:
- **limpio**: una caja que la corrección mueve lejos de cualquier salto (a más de 1 s). ¿Mejora o empeora?
- **baila**: un salto de caja de la revisión de saltos (respuesta «es ella» o nota sobre los pies) que la corrección no
  resuelve. Se muestra la alternativa: pies = cabeza + mediana de la altura de la caja en ±0.5 s (`steady_feet`).

En el video se ven la caja original y dos marcas: roja = pies originales (borde inferior), verde = pies propuestos.

    python -m sportsan.tracking.feet_review --match 2026_09_25_tec_ccm_vs_anahuac
"""
from __future__ import annotations

import argparse
import json
import random

import numpy as np

from sportsan.config import load_config, project_root
from sportsan.tracking.feet import LOOSE_ID, correct_sequence, steady_feet
from sportsan.tracking.jumps_review import find_jumps, person_series
from sportsan.tracking.links_eval import named_parts

STEADY_S = 0.5
WINDOW_S = 2.0
BOX_WORDS = ("pie", "inferior", "extiende", "recort", "baila", "estira")


def _person_feet(series: list, fps: float, method: str) -> dict[int, tuple[float, float]]:
    """Pies propuestos por cuadro para la serie de una persona, track del seguidor por track."""
    by_track: dict[int, list] = {}
    for b in series:
        if b.track < LOOSE_ID:
            by_track.setdefault(b.track, []).append(b)
    out = {}
    for bs in by_track.values():
        t = np.array([b.frame / fps for b in bs])
        bx = np.array([[b.x1, b.y1, b.x2, b.y2] for b in bs])
        f = steady_feet(t, bx, STEADY_S) if method == "steady" else correct_sequence(t, bx)[0]
        for b, p in zip(bs, f):
            out[b.frame] = (float(p[0]), float(p[1]))
    return out


def _case(series, fps, t0: float, feet_new: dict, kind: str, name, video: str, n: int, part: str) -> dict:
    near = [b for b in series if abs(b.frame / fps - t0) <= WINDOW_S]
    return {
        "id": n, "kind": kind, "part": part, "video_id": video, "t": round(t0, 2), "name": name,
        "boxes": [[round(b.frame / fps - t0, 3), round(b.x1), round(b.y1), round(b.x2), round(b.y2)] for b in near],
        "feet_new": [[round(b.frame / fps - t0, 3), round(feet_new[b.frame][0]), round(feet_new[b.frame][1])] for b in near if b.frame in feet_new],
    }


def main() -> None:
    import sys

    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--match")
    ap.add_argument("--clean", type=int, default=12)
    ap.add_argument("--seed", type=int, default=5)
    args = ap.parse_args()
    rng = random.Random(args.seed)
    cfg = load_config(match=args.match)
    dir_ = project_root() / cfg["paths"]["tracking_dir"]
    loaded = {}
    clean_pool = []
    for part in named_parts(dir_):
        raw = json.loads((dir_ / f"tracks_{part}.json").read_text(encoding="utf-8"))
        labels = json.loads((dir_ / f"labels_{part}.json").read_text(encoding="utf-8"))
        fx = dir_ / f"tracks_fixed_{part}.json"
        names = {p["id"]: p.get("player_id") for p in json.loads(fx.read_text(encoding="utf-8"))["people"]} if fx.exists() else {}
        fps = raw["fps"]
        series = person_series(raw, labels)
        loaded[part] = (fps, series, names)
        for person, s in series.items():
            jumps_t = [s[i].frame / fps for i in find_jumps(s, fps)]
            new = _person_feet(s, fps, "correct")
            for b in s:
                p = new.get(b.frame)
                if p and abs(p[1] - b.y2) > 1 and all(abs(b.frame / fps - j) > 1.0 for j in jumps_t):
                    clean_pool.append((part, person, b.frame))
    # Clean: one per person and part at most, so the sample is spread out.
    rng.shuffle(clean_pool)
    seen, clean = set(), []
    for part, person, frame in clean_pool:
        if (part, person) in seen:
            continue
        seen.add((part, person))
        clean.append((part, person, frame))
        if len(clean) >= args.clean:
            break

    # Dancing boxes: box answers of the jump review whose jump at 0 survives the current correction.
    saltos = dir_ / "revision" / "saltos"
    sample = json.loads((saltos / "casos.json").read_text(encoding="utf-8"))
    answers = json.loads((saltos / "respuestas.json").read_text(encoding="utf-8"))
    dancing = []
    for c in sample["cases"]:
        a = answers.get(str(c["id"]), {})
        if not (a.get("answer") == "camara" or any(w in (a.get("note") or "").lower() for w in BOX_WORDS)):
            continue
        fps, series, _ = loaded[c["part"]]
        s = series[c["person"]]
        new = _person_feet(s, fps, "correct")
        i = next((k for k, b in enumerate(s) if abs(b.frame / fps - c["t"]) < 0.02), None)
        if i is None or i == 0:
            continue
        pa, pb = new.get(s[i - 1].frame), new.get(s[i].frame)
        if pa and pb and abs(pb[1] - pa[1]) > 0.5 * abs(s[i].y2 - s[i - 1].y2):
            dancing.append((c["part"], c["person"], s[i].frame, c["id"]))

    cases = []
    picked = [("limpio", x) for x in clean] + [("baila", x) for x in dancing]
    rng.shuffle(picked)
    for n, (kind, x) in enumerate(picked, 1):
        part, person, frame = x[:3]
        fps, series, names = loaded[part]
        s = series[person]
        new = _person_feet(s, fps, "steady" if kind == "baila" else "correct")
        case = _case(s, fps, frame / fps, new, kind, names.get(person), part.split("_")[0], n, part)
        if kind == "baila":
            case["from_jump_case"] = x[3]
        cases.append(case)
    out = dir_ / "revision" / "pies"
    out.mkdir(parents=True, exist_ok=True)
    (out / "casos.json").write_text(json.dumps({"match": cfg.get("match_id"), "image": {"w": 1920, "h": 1080}, "cases": cases}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(cases)} casos ({len(clean)} limpios, {len(dancing)} de caja que baila) en {out}")


if __name__ == "__main__":
    main()

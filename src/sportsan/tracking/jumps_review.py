"""Muestra de saltos imposibles para revisar en la app (sección temporal /revision).

Un salto es lo mismo que marca la mesa de corrección (web/lib/cuts.ts): entre dos posiciones seguidas de una jugadora
(a menos de 1 s) se mueve más de 3 m a más de 9 m/s. Se buscan en las partes con nombres, con las cajas tal como las dejó
la mesa (`labels_*.json`). A cada salto se le pone, sin mostrarlo, el patrón que propone una regla sencilla:

- **pico**: vuelve antes de 2 s a donde podía estar: unos pocos cuadros de ruido o de otra persona.
- **antes**: no vuelve, y el tramo anterior al salto es corto (empieza tras un hueco o tras otro salto hace menos de
  2 s): lo malo eran los cuadros de antes.
- **prolongado**: no vuelve y el tramo anterior es largo: cambio de identidad que dura, o salto real de calibración.

Escribe `tracking/revision/saltos/` con `casos.json` (lo que dibuja la app) y una imagen por caso: 6 cuadros de 1 s antes a
1 s después, con la caja de la jugadora marcada.

    python -m sportsan.tracking.jumps_review --match 2026_09_25_tec_ccm_vs_anahuac --per-kind 10
"""
from __future__ import annotations

import argparse
import json
import random
from pathlib import Path

import numpy as np

from sportsan.config import load_config, project_root
from sportsan.tracking.links_eval import named_parts
from sportsan.tracking.tracklets import boxes_from_part

JUMP_SPEED_MS = 9.0     # como web/lib/cuts.ts
JUMP_MIN_M = 3.0
PAIR_MAX_S = 1.0
RETURN_S = 2.0          # una vuelta antes de esto es un pico
SHORT_BEFORE_S = 2.0    # un tramo anterior más corto que esto es sospechoso
WINDOW_S = 3.0          # recorrido que se guarda a cada lado del salto
STRIP = (-1.0, -0.5, "before", "after", 0.5, 1.0)


def person_series(raw: dict, labels: dict) -> dict[int, list]:
    """Posiciones (cuadro, x m, y m, caja) de cada persona con nombre, desde las cajas que la mesa le asignó."""
    named = {p["label"] for p in labels.get("people", []) if p.get("named")}
    who = {(fr["frame"], int(b["track"])): b["label"] for fr in labels["frames"] for b in fr["boxes"] if b["status"] == "player" and b["label"] in named}
    out: dict[int, list] = {}
    for row in boxes_from_part(raw):
        for b in row:
            p = who.get((b.frame, b.track))
            if p is not None and b.on_pitch and np.isfinite(b.xm):
                out.setdefault(p, []).append(b)
    for s in out.values():
        s.sort(key=lambda b: b.frame)
    return out


def find_jumps(series: list, fps: float) -> list[int]:
    """Índices i donde hay un salto entre series[i-1] y series[i]."""
    out = []
    for i in range(1, len(series)):
        a, b = series[i - 1], series[i]
        dt = (b.frame - a.frame) / fps
        d = float(np.hypot(b.xm - a.xm, b.ym - a.ym))
        if 0 < dt <= PAIR_MAX_S and d > JUMP_MIN_M and d / dt > JUMP_SPEED_MS:
            out.append(i)
    return out


def classify(series: list, i: int, jumps: list[int], fps: float) -> str:
    """Patrón propuesto para el salto en i (ver el docstring del módulo)."""
    a = series[i - 1]
    t0 = a.frame / fps
    for j in jumps:
        if j <= i:
            continue
        b = series[j]
        if b.frame / fps - t0 > RETURN_S:
            break
        dt = (b.frame - a.frame) / fps
        if np.hypot(b.xm - a.xm, b.ym - a.ym) <= JUMP_SPEED_MS * dt + JUMP_MIN_M:
            return "pico"
    # Start of the stretch before the jump: a hole (> PAIR_MAX_S) or another jump.
    k = i - 1
    while k > 0 and (series[k].frame - series[k - 1].frame) / fps <= PAIR_MAX_S and k not in jumps:
        k -= 1
    return "antes" if (a.frame - series[k].frame) / fps < SHORT_BEFORE_S else "prolongado"


def render(cap, series: list, i: int, fps: float, out: Path) -> list[float]:
    """6 cuadros alrededor del salto con la caja de la jugadora; devuelve el tiempo (s) de cada uno respecto al salto."""
    import cv2

    a, b = series[i - 1], series[i]
    t_jump = b.frame / fps
    frames = []
    for s in STRIP:
        frames.append(a.frame if s == "before" else b.frame if s == "after" else int(round((t_jump + s) * fps)))
    near = [x for x in series if frames[0] - fps <= x.frame <= frames[-1] + fps]
    x1 = min(x.x1 for x in near); x2 = max(x.x2 for x in near)
    y1 = min(x.y1 for x in near); y2 = max(x.y2 for x in near)
    w = max(260.0, (x2 - x1) * 1.4, (y2 - y1) * 1.4 * 16 / 9)
    h = w * 9 / 16
    cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
    tiles = []
    for f, s in zip(frames, STRIP):
        cap.set(cv2.CAP_PROP_POS_FRAMES, f)
        ok, img = cap.read()
        if not ok:
            img = np.zeros((1080, 1920, 3), np.uint8)
        here = min(series, key=lambda x: abs(x.frame - f))
        if abs(here.frame - f) <= 3:
            color = (0, 200, 255) if s in ("before", "after") else (255, 200, 0)
            cv2.rectangle(img, (int(here.x1), int(here.y1)), (int(here.x2), int(here.y2)), color, 2)
        X0 = int(min(max(0, cx - w / 2), img.shape[1] - w))
        Y0 = int(min(max(0, cy - h / 2), img.shape[0] - h))
        crop = img[max(0, Y0):Y0 + int(h), max(0, X0):X0 + int(w)]
        tile = cv2.resize(crop, (480, 270), interpolation=cv2.INTER_CUBIC)
        label = "antes" if s == "before" else "después" if s == "after" else f"{s:+.1f} s"
        cv2.putText(tile, label, (8, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 4, cv2.LINE_AA)
        cv2.putText(tile, label, (8, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1, cv2.LINE_AA)
        tiles.append(tile)
    gap = np.full((270, 6, 3), 30, np.uint8)
    rows = [np.hstack([tiles[0], gap, tiles[1], gap, tiles[2]]), np.hstack([tiles[3], gap, tiles[4], gap, tiles[5]])]
    img = np.vstack([rows[0], np.full((6, rows[0].shape[1], 3), 30, np.uint8), rows[1]])
    cv2.imwrite(str(out), img, [cv2.IMWRITE_JPEG_QUALITY, 86])
    return [round(f / fps - t_jump, 2) for f in frames]


def main() -> None:
    import sys

    import cv2

    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--match")
    ap.add_argument("--per-kind", type=int, default=10)
    ap.add_argument("--seed", type=int, default=11)
    args = ap.parse_args()
    rng = random.Random(args.seed)
    cfg = load_config(match=args.match)
    root = project_root()
    dir_ = root / cfg["paths"]["tracking_dir"]
    pool: dict[str, list] = {"pico": [], "antes": [], "prolongado": []}
    loaded = {}
    for name in named_parts(dir_):
        raw = json.loads((dir_ / f"tracks_{name}.json").read_text(encoding="utf-8"))
        labels = json.loads((dir_ / f"labels_{name}.json").read_text(encoding="utf-8"))
        names = {p["id"]: p.get("player_id") for p in json.loads((dir_ / f"tracks_fixed_{name}.json").read_text(encoding="utf-8"))["people"]} if (dir_ / f"tracks_fixed_{name}.json").exists() else {}
        series = person_series(raw, labels)
        loaded[name] = (raw["fps"], series, names)
        for person, s in series.items():
            js = find_jumps(s, raw["fps"])
            for i in js:
                pool[classify(s, i, js, raw["fps"])].append((name, person, i))
    print("Saltos por patrón propuesto:", {k: len(v) for k, v in pool.items()})
    picked = [(k, x) for k, xs in pool.items() for x in rng.sample(xs, min(args.per_kind, len(xs)))]
    rng.shuffle(picked)

    out = dir_ / "revision" / "saltos"
    out.mkdir(parents=True, exist_ok=True)
    caps: dict[str, object] = {}
    cases = []
    for n, (kind, (name, person, i)) in enumerate(picked, 1):
        fps, series, names = loaded[name]
        s = series[person]
        video = name.split("_")[0]
        cap = caps.setdefault(video, cv2.VideoCapture(str(root / cfg["paths"]["match_dir"] / "video" / f"{video}.mp4")))
        offsets = render(cap, s, i, fps, out / f"salto_{n:02d}.jpg")
        t_jump = s[i].frame / fps
        path = [[round(x.frame / fps - t_jump, 2), round(float(x.xm), 2), round(float(x.ym), 2)] for x in s if abs(x.frame / fps - t_jump) <= WINDOW_S]
        # Her box in each processed frame, for the player of the review page (pixels of the video).
        boxes = [[round(x.frame / fps - t_jump, 3), round(x.x1), round(x.y1), round(x.x2), round(x.y2)] for x in s if abs(x.frame / fps - t_jump) <= WINDOW_S]
        a, b = s[i - 1], s[i]
        cases.append({
            "id": n, "part": name, "video_id": video, "t": round(t_jump, 2), "person": person, "name": names.get(person),
            "meters": round(float(np.hypot(b.xm - a.xm, b.ym - a.ym)), 1),
            "speed": round(float(np.hypot(b.xm - a.xm, b.ym - a.ym)) / ((b.frame - a.frame) / fps), 1),
            "same_track": a.track == b.track, "image": f"salto_{n:02d}.jpg", "offsets": offsets, "path": path, "boxes": boxes,
            "proposed": kind,
        })
    raw0 = json.loads((dir_ / f"tracks_{picked[0][1][0]}.json").read_text(encoding="utf-8")) if picked else {}
    venue = raw0.get("venue") or {}
    (out / "casos.json").write_text(json.dumps({"match": cfg.get("match_id"), "image": {"w": raw0.get("image_w") or 1920, "h": raw0.get("image_h") or 1080}, "venue": {"length_m": venue.get("length_m") or 105, "width_m": venue.get("width_m") or 68}, "cases": cases}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(cases)} casos en {out}")


if __name__ == "__main__":
    main()

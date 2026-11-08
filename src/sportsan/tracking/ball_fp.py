"""Mide dónde caen las marcas automáticas del balón (ball_auto_*.json): dentro de cajas de jugadoras (pies, tronco, cabeza),
en puntos que se repiten (números y líneas pintadas, que no se mueven) y en las yardas del campo de americano.

    python -m sportsan.tracking.ball_fp --match <id>

Con la verdad de los clips (revision/balon/respuestas.json) añade la precisión de las marcas por zona: así se vio que
dentro de la caja de una jugadora, en la zona de los pies, solo 25-29 % eran el balón (69-95 % fuera de cajas), lo que
sustenta la penalización de ball_track (USE_BOX_COST). Solo lee; no escribe nada.
"""
from __future__ import annotations

import argparse
import json
import math
from collections import Counter
from pathlib import Path

import numpy as np

from . import ball as B

YARD_M = 4.572  # 5 yardas: separación de las líneas de yarda del campo de americano
STATIC_PX = 6  # dos marcas a menos de esto (px, a 1080) son «el mismo punto»
STATIC_MIN = 4  # cuadros que repiten un punto para llamarlo estático


def zone(box, px: float, py: float) -> str | None:
    """Zona de la caja que contiene el punto: cabeza (20 % de arriba), pies (20 % de abajo) o tronco; None si está fuera."""
    x1, y1, x2, y2 = box[1], box[2], box[3], box[4]
    if not (x1 <= px <= x2 and y1 <= py <= y2):
        return None
    rel = (py - y1) / max(y2 - y1, 1.0)
    return "cabeza" if rel < 0.2 else ("pies" if rel > 0.8 else "tronco")


def zone_in(boxes, px: float, py: float) -> str:
    """Zona del punto respecto a las cajas del cuadro: pies / tronco / cabeza (dentro), junto (a menos de 25 % del alto) o libre."""
    near = False
    for b in boxes or []:
        z = zone(b, px, py)
        if z:
            return z
        m = 0.25 * (b[4] - b[2])
        near = near or (b[1] - m <= px <= b[3] + m and b[2] - m <= py <= b[4] + m)
    return "junto" if near else "libre"


def yard_histogram(xs_m: list[float], bins: int = 10) -> list[int]:
    """Posiciones x de la cancha (m) -> histograma de x módulo 5 yardas. Un pico marca marcas pegadas a las líneas de yarda."""
    ph = (np.asarray(xs_m, float) % YARD_M) / YARD_M
    return np.histogram(ph, bins=bins, range=(0, 1))[0].tolist()


def part_report(auto: dict, tracks: dict) -> dict:
    by = {fr["frame"]: fr for fr in tracks["frames"]}
    k = tracks["image_h"] / 1080
    zones: Counter = Counter()
    xs, static = [], Counter()
    for f in auto["frames"]:
        fr = by.get(f["frame"])
        if not fr:
            continue
        z = zone_in(fr["boxes"], f["px"], f["py"])
        zones[z] += 1
        if z in ("libre", "junto") and fr.get("H"):
            q = np.asarray(fr["H"], float).reshape(3, 3) @ np.array([f["px"], f["py"], 1.0])
            xs.append(q[0] / q[2])
        static[(round(f["px"] / (STATIC_PX * k)), round(f["py"] / (STATIC_PX * k)))] += 1
    return {"n": sum(zones.values()), "zonas": dict(zones), "estaticas": sum(c for c in static.values() if c >= STATIC_MIN), "yardas": yard_histogram(xs) if xs else []}


def precision_by_zone(folder: Path) -> dict:
    """Con la verdad de los clips: por zona y nivel, cuántas marcas estaban a <= 15 px del balón."""
    rev = folder / "tracking" / "revision" / "balon"
    if not (rev / "clips.json").exists() or not (rev / "respuestas.json").exists():
        return {}
    clips = {c["id"]: c for c in json.loads((rev / "clips.json").read_text(encoding="utf-8"))["clips"]}
    resp = json.loads((rev / "respuestas.json").read_text(encoding="utf-8"))["clips"]
    cnt: Counter = Counter()
    for cid, c in clips.items():
        truth = [(s["t_video"], s["px"]) for s in resp.get(cid, {}).get("samples", [])]
        if not truth:
            continue
        for af in sorted((folder / "tracking").glob(f"ball_auto_{c['video_id']}_*.json")):
            a = json.loads(af.read_text(encoding="utf-8"))
            tf = af.with_name(af.name.replace("ball_auto_", "tracks_", 1))
            if not tf.exists() or not (a["start_frame"] <= c["t0"] * a["fps"] and c["t1"] * a["fps"] <= a["end_frame"]):
                continue
            by = {fr["frame"]: fr for fr in json.loads(tf.read_text(encoding="utf-8"))["frames"]}
            k = a["image_h"] / 1080
            for f in a["frames"]:
                if not c["t0"] * a["fps"] <= f["frame"] <= c["t1"] * a["fps"]:
                    continue
                t, px = min(truth, key=lambda s: abs(s[0] * a["fps"] - f["frame"]))
                if abs(t * a["fps"] - f["frame"]) > 2.5:
                    continue
                z = zone_in(by[f["frame"]]["boxes"], f["px"], f["py"]) if f["frame"] in by else "libre"
                cnt[(z, f.get("tier", "-"), math.hypot(px[0] - f["px"], px[1] - f["py"]) <= 15 * k)] += 1
    out: dict = {}
    for (z, tier, ok), n in cnt.items():
        d = out.setdefault(f"{z}/{tier}", {"aciertos": 0, "falsos": 0})
        d["aciertos" if ok else "falsos"] += n
    for d in out.values():
        d["precision"] = round(d["aciertos"] / max(1, d["aciertos"] + d["falsos"]), 2)
    return out


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--match", required=True)
    a = ap.parse_args(argv)
    folder = B.match_dir(a.match)
    total: Counter = Counter()
    for af in sorted((folder / "tracking").glob("ball_auto_v*_*.json")):
        tf = af.with_name(af.name.replace("ball_auto_", "tracks_", 1))
        if not tf.exists():
            continue
        r = part_report(json.loads(af.read_text(encoding="utf-8")), json.loads(tf.read_text(encoding="utf-8")))
        total.update(r["zonas"])
        print(f"{af.name}: {r['n']} marcas · {r['zonas']} · estáticas {r['estaticas']} · x mod 5 yardas {r['yardas']}")
    n = sum(total.values())
    if n:
        print(f"TOTAL {n}: " + " · ".join(f"{z} {c} ({c / n:.0%})" for z, c in total.most_common()))
    pz = precision_by_zone(folder)
    for key in sorted(pz):
        print(f"verdad {key}: {pz[key]}")


if __name__ == "__main__":
    main()

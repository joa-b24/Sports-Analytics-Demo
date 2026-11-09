"""Balón nuevo: camino óptimo sobre los candidatos (capa 2) y, encima, suelo/vuelo y sugerencias (capa 3).

Trabaja sobre la caché de `ball_compare features` (candidatos y probabilidades por cuadro procesado); no lee video.

Capa 2 (relleno): en vez de exigir p alta en cada cuadro, busca el camino de menor costo a través de los candidatos de
todo el tramo (programación dinámica sobre un DAG):
  costo = suma de -log(p) de los candidatos usados + MISS por cada cuadro sin balón + salto no creíble entre dos usados.
Un salto de hasta GAP cuadros sin candidato se llena en línea recta y queda marcado "interp" (no es una detección).
Las marcas seguras (p alta con apoyo de vecinos, como el modelo anterior) pesan más: acotan el camino y suben la certeza
de las intermedias. Cada punto sale con su nivel: "seguro", "relleno" (detección aceptada por el camino) o "interp".
"""
from __future__ import annotations

import math

import numpy as np

# Costos en nats. MISS: lo que cuesta dejar un cuadro sin balón (p ~ e^-MISS es el mínimo que compensa usar un candidato).
MISS = 2.3
P_FLOOR = 0.02
TOP_K = 8
P_MIN = 0.03
GAP = 8  # cuadros procesados que puede saltar el camino
SEED_P = 0.8
SEED_BONUS = 3.0
V_STEP_PX = 90.0  # lo que el balón recorre como mucho entre dos cuadros procesados consecutivos (a 1080 de alto)
JUMP_W = 3.0  # peso del salto, relativo a lo que el balón puede recorrer
HARD = 2.5  # más de HARD veces lo posible: no se une
ACCEL_W = 0.0

# Penalización por jugadoras (medida con la verdad de los clips: dentro de la caja de una jugadora, en la zona de los pies,
# solo 25-29 % de las marcas eran el balón; fuera de cajas, 69-95 %). En nats, se suma al costo de usar ese candidato.
USE_BOX_COST = True
BOX_FEET_COST = 1.0  # el candidato cae en el 20 % bajo de una caja (zapato o balón a los pies)
BOX_BODY_COST = 2.0  # en el tronco o la cabeza de una caja
SHOE_COST = 1.2  # extra: en cuadros vecinos hay un candidato en el mismo lugar relativo de la misma caja (se mueve con ella)
SHOE_TOL = 0.08  # diferencia máxima de lugar relativo (fracción del alto de la caja)


def _nodes(feat: dict) -> list[list[tuple[float, float, float]]]:
    """Por cuadro: los mejores TOP_K candidatos (x, y, p) con p >= P_MIN."""
    out = []
    for fr in feat["frames"]:
        pts, p = fr["pts"], fr["p"]
        order = np.argsort(-p)[:TOP_K]
        out.append([(float(pts[j, 0]), float(pts[j, 1]), float(p[j])) for j in order if p[j] >= P_MIN])
    return out


def _box_cost(feat: dict, nodes: list) -> dict[tuple[int, int], float]:
    """Costo extra de cada candidato por caer en una caja de jugadora (ver USE_BOX_COST). Sin cajas en el cuadro: 0.

    Un balón que rueda o vuela cae en una caja solo de pasada; un zapato, una cabeza o un número pintado que coincide con
    una caja cae siempre en el mismo lugar relativo de ella. Eso último se mide con los cuadros vecinos: si el mismo
    track tiene candidatos casi en el mismo lugar relativo, se mueve con ella y sube el costo."""
    rel: dict[tuple[int, int], tuple[int, float, float, float]] = {}  # (i, a) -> (track, fx, fy, alto)
    cost: dict[tuple[int, int], float] = {}
    for i, ns in enumerate(nodes):
        boxes = feat["frames"][i].get("boxes") or []
        for a, (x, y, _) in enumerate(ns):
            best = None
            for b in boxes:
                x1, y1, x2, y2 = b[1], b[2], b[3], b[4]
                if x1 <= x <= x2 and y1 <= y <= y2 and (best is None or (x2 - x1) * (y2 - y1) < best[0]):
                    best = ((x2 - x1) * (y2 - y1), b[0], (x - x1) / max(x2 - x1, 1.0), (y - y1) / max(y2 - y1, 1.0), y2 - y1)
            if best is None:
                continue
            _, tid, fx, fy, h = best
            rel[(i, a)] = (tid, fx, fy, h)
            cost[(i, a)] = BOX_FEET_COST if fy > 0.8 else BOX_BODY_COST
    for (i, a), (tid, fx, fy, _) in rel.items():
        for n in (i - 1, i + 1):
            if any((n, b) in rel and rel[(n, b)][0] == tid and abs(rel[(n, b)][1] - fx) < SHOE_TOL and abs(rel[(n, b)][2] - fy) < SHOE_TOL for b in range(len(nodes[n]) if 0 <= n < len(nodes) else 0)):
                cost[(i, a)] += SHOE_COST
                break
    return cost


def seeds(feat: dict, nodes: list, seed_p: float = SEED_P) -> set[tuple[int, int]]:
    """Candidatos seguros: p alta y al menos un cuadro vecino (a dos pasos) con un candidato p >= 0.5 a distancia creíble."""
    k = feat["k"]
    out = set()
    for i, ns in enumerate(nodes):
        for a, (x, y, p) in enumerate(ns):
            if p < seed_p:
                continue
            for di in (-2, -1, 1, 2):
                n = i + di
                if 0 <= n < len(nodes) and any(q >= 0.5 and math.hypot(qx - x, qy - y) <= V_STEP_PX * k * abs(di) for qx, qy, q in nodes[n]):
                    out.add((i, a))
                    break
    return out


def best_path(feat: dict, miss: float = MISS, seed_p: float = SEED_P, gap: int = GAP) -> list[dict]:
    """Camino de menor costo. Devuelve [{frame, px, py, p, tier}] con tier "seguro" o "relleno" (solo candidatos reales)."""
    nodes = _nodes(feat)
    n = len(nodes)
    k = feat["k"]
    safe = seeds(feat, nodes, seed_p)
    boxc = _box_cost(feat, nodes) if USE_BOX_COST else {}
    ids = [(i, a) for i in range(n) for a in range(len(nodes[i]))]
    cost: dict[tuple[int, int], float] = {}
    back: dict[tuple[int, int], tuple[int, int] | None] = {}

    def unary(i: int, a: int) -> float:
        p = max(nodes[i][a][2], P_FLOOR)
        return -math.log(p) - (SEED_BONUS if (i, a) in safe else 0.0) + boxc.get((i, a), 0.0)

    for i, a in ids:
        x, y, _ = nodes[i][a]
        best = (miss * i + unary(i, a), None)  # empieza aquí: los cuadros de antes quedan vacíos
        for g in range(1, gap + 1):
            j = i - g
            if j < 0:
                break
            for b, (bx, by, _) in enumerate(nodes[j]):
                d = math.hypot(x - bx, y - by)
                can = V_STEP_PX * k * g
                if d > HARD * can:
                    continue
                c = cost[(j, b)] + miss * (g - 1) + JUMP_W * (d / can) ** 2 + unary(i, a)
                if c < best[0]:
                    best = (c, (j, b))
        cost[(i, a)], back[(i, a)] = best
    if not ids:
        return []
    end = min(ids, key=lambda t: cost[t] + miss * (n - 1 - t[0]))
    path = []
    cur: tuple[int, int] | None = end
    while cur is not None:
        path.append(cur)
        cur = back[cur]
    path.reverse()
    out = []
    for i, a in path:
        x, y, p = nodes[i][a]
        out.append({"frame": feat["frames"][i]["frame"], "px": round(x, 1), "py": round(y, 1), "p": round(p, 3), "tier": "seguro" if (i, a) in safe else "relleno"})
    return out


def interpolate(path: list[dict], frames: list[int], gap: int = GAP) -> list[dict]:
    """Llena en línea recta los cuadros sin candidato entre dos puntos del camino a menos de `gap` pasos (tier "interp")."""
    idx = {f: i for i, f in enumerate(frames)}
    out = list(path)
    for a, b in zip(path[:-1], path[1:]):
        ia, ib = idx[a["frame"]], idx[b["frame"]]
        if 1 < ib - ia <= gap + 1:
            for i in range(ia + 1, ib):
                w = (i - ia) / (ib - ia)
                out.append({"frame": frames[i], "px": round(a["px"] + (b["px"] - a["px"]) * w, 1), "py": round(a["py"] + (b["py"] - a["py"]) * w, 1), "p": 0.0, "tier": "interp"})
    return sorted(out, key=lambda r: r["frame"])


def track(feat: dict, **kw) -> list[dict]:
    path = best_path(feat, **kw)
    return interpolate(path, [fr["frame"] for fr in feat["frames"]], kw.get("gap", GAP))


def track_pred(feat: dict, with_interp: bool = True) -> dict[int, tuple[float, float]]:
    """Para ball_compare: {frame: (x, y)}."""
    return {r["frame"]: (r["px"], r["py"]) for r in track(feat) if with_interp or r["tier"] != "interp"}


# ------------------------------------------------------------------------------------------ correr sobre una parte
# Mismo archivo de salida que `ball.py run` (ball_auto_<video>_<ini>_<fin>.json) para que la app lo lea igual; añade `tier`
# a cada marca y `interp` (cuadros rellenados en línea recta, nunca detecciones).
MODEL_CLIPS = "ball_model_clips.pt"
RUN_MISS = 1.4
RUN_CAP = 400


def run_part_new(part, model, folder, progress=None, model_path=None, frame_range: tuple[int, int] | None = None) -> dict:
    """Corre el balón en una parte; con frame_range=(ini, fin) solo en los cuadros procesados de ese tramo (ensayos cortos)."""
    import json
    import time

    from . import ball as B

    tr = json.loads(part.read_text(encoding="utf-8"))
    if frame_range is not None:
        sel = [fr for fr in tr["frames"] if frame_range[0] <= fr["frame"] < frame_range[1]]
        if not sel:
            raise SystemExit(f"{part.name}: ningún cuadro procesado entre {frame_range[0]} y {frame_range[1]}")
        tr = {**tr, "frames": sel, "start_frame": sel[0]["frame"], "end_frame": sel[-1]["frame"] + tr["stride"]}
    venue = B.venue_of(folder, tr)
    if venue is None:
        raise SystemExit(f"{part.name}: falta la medida de la sede (venue en match.yaml)")
    walker = B.FrameWalker(B.video_of(folder, tr["video_id"]))
    k = tr["image_h"] / 1080
    by = {fr["frame"]: fr for fr in tr["frames"]}
    t0 = time.time()
    total = len(tr["frames"])
    if progress:
        progress.log("cuadros", 0, total)
    frames = []
    for i, (f, pts, P) in enumerate(B.frame_features(walker, tr["frames"], venue, search="pitch", k=k, cap=RUN_CAP), 1):
        frames.append({"frame": f, "pts": pts, "p": model.predict(P), "H": by[f].get("H"), "boxes": by[f].get("boxes") or []})
        if progress and (i % 10 == 0 or i == total):
            progress.log("cuadros", i, total)
    if progress:
        progress.log("decisión", 0, 1)
    feat = {"k": k, "fps": tr["fps"], "venue": venue, "stride": tr["stride"], "frames": frames}
    rows = track(feat, miss=RUN_MISS)
    found = [r for r in rows if r["tier"] != "interp"]
    interp = [{"frame": r["frame"], "px": r["px"], "py": r["py"]} for r in rows if r["tier"] == "interp"]
    Hs = {fr["frame"]: fr.get("H") for fr in tr["frames"]}
    boxes = {fr["frame"]: fr.get("boxes") for fr in tr["frames"]}
    flagged = B.flag_points(found, boxes, Hs, tr["fps"], k)
    done = [f["frame"] for f in frames]
    asks = B.ask_frames([b["frame"] for b in flagged], done, tr["fps"], B.play_segments(folder, tr["video_id"], tr["fps"]))
    return {
        "schema_version": 1, "kind": "ball_auto", "match_id": tr["match_id"], "video_id": tr["video_id"], "fps": tr["fps"], "stride": tr["stride"],
        "start_frame": tr["start_frame"], "end_frame": tr["end_frame"], "image_w": tr["image_w"], "image_h": tr["image_h"],
        "generated": time.strftime("%Y-%m-%dT%H:%M:%S"), "model_file": str(model_path) if model_path else None, "model": model.meta,
        "rules": {"tracker": "camino óptimo (ball_track)", "miss": RUN_MISS, "cap": RUN_CAP}, "frames": flagged, "interp": interp, "ask": asks,
        "quality": {"processed": len(done), "found": len(flagged), "found_share": round(len(flagged) / max(1, len(done)), 3),
                    "flagged": sum(1 for b in flagged if b["flags"]), "flagged_jump": sum(1 for b in flagged if "jump" in b["flags"]),
                    "flagged_in_player_box": sum(1 for b in flagged if "in_player_box" in b["flags"]), "seconds": round(time.time() - t0, 1)},
    }


def queue(items: list[tuple[str, str | None]], force: bool = False) -> None:
    """items: (match, parte o None = todas). Salta lo que ya tiene salida. Escribe progreso como `ball.py run`."""
    import json

    from ..config import project_root
    from . import ball as B

    path = project_root() / "weights" / MODEL_CLIPS
    model = B.BallModel(path)
    for match, only in items:
        folder = B.match_dir(match)
        for part in B.parts_of(folder):
            if only and not part.name.startswith(only):
                continue
            out = part.with_name(B.out_name(part))
            if out.exists() and not force:
                print(f"ya existe, salto: {out.name}", flush=True)
                continue
            prog = B.BallProgress(B.progress_path(folder, part), echo=True)
            r = run_part_new(part, model, folder, prog, path)
            prog.log("escritura", 0, 1)
            out.write_text(json.dumps(r), encoding="utf-8")
            prog.log("listo", 1, 1)
            q = r["quality"]
            print(f"listo: {out.name}: {q['found']} marcas en {q['processed']} cuadros, {len(r['interp'])} rellenos, {q['seconds']} s", flush=True)


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(description="Cola del balón nuevo: python -m sportsan.tracking.ball_track run --match <id>[:prefijo_parte] ...")
    ap.add_argument("cmd", choices=["run"])
    ap.add_argument("--match", action="append", required=True, help="<id> o <id>:tracks_v2 (solo partes que empiezan así); en orden")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    queue([(m.split(":")[0], m.split(":")[1] if ":" in m else None) for m in a.match], a.force)

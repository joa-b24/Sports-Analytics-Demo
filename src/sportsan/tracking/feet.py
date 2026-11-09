"""Pies de una caja cuando su borde inferior no es fiable (docs/propuesta_union_tracks.md, 8d, punto 1).

La posición de una jugadora en la cancha sale del centro del borde inferior de su caja (los pies) pasado por la
homografía del cuadro. En la revisión de 30 saltos imposibles, más de la mitad no eran otra persona sino ese borde: se
cortan los pies (alguien delante), la caja se estira hasta los pies de la jugadora de delante o el borde «baila». La
jugadora «salta» metros sin cambiar de identidad, más en la banda lejana.

Regla, por track del seguidor (una secuencia de cajas en cuadros procesados): en una ventana de ±WINDOW_S alrededor de
cada caja se ajusta la tendencia del borde superior y del inferior (recta de Theil-Sen, robusta a unos cuadros malos). Si
el borde inferior se aparta de su tendencia más de REL de la altura típica (y al menos MIN_PX) mientras el superior sigue
la suya, el borde inferior no es fiable: los pies se ponen en la cabeza más la altura típica de la caja en esa ventana
(mediana de las cajas fiables). Si no hay bastantes cajas para saber la altura típica, se deja como está: nunca se inventa.

Funciones puras (numpy), sin leer archivos salvo `main` (informe de evaluación, no escribe tracks).
"""
from __future__ import annotations

import numpy as np

# Se aplica en process al pasar las cajas a la cancha. False: pies = borde inferior, como antes.
FEET_CORRECTION = True  # revisada en /revision/pies (2026-10-21): 11 de 11 mejor, ninguna peor
# Ventana (s) a cada lado para la tendencia y la altura típica.
WINDOW_S = 1.0
# El borde inferior se aparta de su tendencia más que esta fracción de la altura típica...
REL = 0.15
MIN_PX = 4.0
# ...y el superior se aparta menos que esta fracción de lo que se aparta el inferior.
TOP_SHARE = 0.5
# Cajas fiables mínimas en la ventana para saber la altura típica.
MIN_POINTS = 6
# Ids de las cajas sueltas (una caja, sin secuencia): no se corrigen.
LOOSE_ID = 1_000_000


def _theil_sen(t: np.ndarray, y: np.ndarray, at: float) -> float:
    """Valor en `at` de la recta de Theil-Sen (mediana de pendientes) por (t, y)."""
    if len(t) < 2:
        return float(np.median(y)) if len(y) else float("nan")
    i, j = np.triu_indices(len(t), 1)
    dt = t[j] - t[i]
    ok = dt != 0
    slope = float(np.median((y[j] - y[i])[ok] / dt[ok])) if ok.any() else 0.0
    return float(np.median(y - slope * t) + slope * at)


def correct_sequence(t: np.ndarray, boxes: np.ndarray, window_s: float = WINDOW_S) -> tuple[np.ndarray, np.ndarray]:
    """Pies (n, 2) en píxeles para una secuencia de cajas (n, 4: x1, y1, x2, y2) en los tiempos t (s), y qué cajas se
    corrigieron. Dos pasadas: la segunda ajusta las tendencias sin las cajas que la primera marcó."""
    t = np.asarray(t, dtype=float)
    b = np.asarray(boxes, dtype=float).reshape(-1, 4)
    n = len(t)
    feet = np.c_[(b[:, 0] + b[:, 2]) / 2, b[:, 3]]
    fixed = np.zeros(n, dtype=bool)
    if n < MIN_POINTS + 1:
        return feet, fixed
    top, bot = b[:, 1], b[:, 3]
    h = bot - top
    bad = np.zeros(n, dtype=bool)
    for _ in range(2):
        new_bad = np.zeros(n, dtype=bool)
        new_y = np.full(n, np.nan)
        for i in range(n):
            w = (np.abs(t - t[i]) <= window_s) & ~bad
            w[i] = False
            if w.sum() < MIN_POINTS:
                continue
            typical = float(np.median(h[w]))
            r_bot = bot[i] - _theil_sen(t[w], bot[w], t[i])
            r_top = top[i] - _theil_sen(t[w], top[w], t[i])
            if abs(r_bot) > max(REL * typical, MIN_PX) and abs(r_top) < TOP_SHARE * abs(r_bot):
                new_bad[i] = True
                new_y[i] = top[i] + typical
        bad = new_bad
        ys = new_y
    fixed = bad & np.isfinite(ys)
    feet[fixed, 1] = ys[fixed]
    return feet, fixed


#  Borde que «baila» (revisión /revision/pies, 5 de 6 mejor con la altura mediana): el borde inferior se aparta unas
#  posiciones de la altura habitual con la cabeza quieta, sin la tendencia limpia que necesita correct_sequence. Ahí los
#  pies = cabeza + mediana de la altura en ±STEADY_S. Se decide caja por caja con su altura actual, así que cuando la caja
#  vuelve a su altura usa su propio borde (no se arrastra el error: caso 12 de la revisión).
STEADY_S = 0.5
STEADY_REL = 0.15
STEADY_MIN_PX = 3.0


def steady_feet(t: np.ndarray, boxes: np.ndarray, window_s: float = STEADY_S) -> np.ndarray:
    """Pies (n, 2) = centro de la caja bajo la cabeza más la mediana de la altura de la caja en ±window_s."""
    t = np.asarray(t, dtype=float)
    b = np.asarray(boxes, dtype=float).reshape(-1, 4)
    h = b[:, 3] - b[:, 1]
    y = np.array([b[i, 1] + np.median(h[np.abs(t - t[i]) <= window_s]) for i in range(len(t))])
    return np.c_[(b[:, 0] + b[:, 2]) / 2, y]


def combined_sequence(t: np.ndarray, boxes: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """La corrección por tendencia (correct_sequence) y, en las cajas que no toca, la altura mediana cuando la altura de
    la caja se aparta de su mediana en ±STEADY_S y la cabeza no se mueve con ella."""
    t = np.asarray(t, dtype=float)
    b = np.asarray(boxes, dtype=float).reshape(-1, 4)
    feet, fixed = correct_sequence(t, b)
    if len(t) < MIN_POINTS + 1:
        return feet, fixed
    h = b[:, 3] - b[:, 1]
    top = b[:, 1]
    for i in np.where(~fixed)[0]:
        w = np.abs(t - t[i]) <= STEADY_S
        if w.sum() < 4:
            continue
        hm = float(np.median(h[w]))
        dev = h[i] - hm
        if abs(dev) <= max(STEADY_REL * hm, STEADY_MIN_PX):
            continue
        r_top = top[i] - float(np.median(top[w]))
        if abs(r_top) < TOP_SHARE * abs(dev):
            feet[i] = [(b[i, 0] + b[i, 2]) / 2, top[i] + hm]
            fixed[i] = True
    return feet, fixed


def correct_rows(frames: list[int], rows: list[list[dict]], fps: float) -> tuple[list[np.ndarray], int]:
    """Pies (n, 2) por cuadro para las cajas de process ({"track_id", "box": [x1, y1, x2, y2]}), corregidos por track del
    seguidor. Devuelve también cuántas cajas se corrigieron."""
    feet = [np.array([[(r["box"][0] + r["box"][2]) / 2, r["box"][3]] for r in row], dtype=float).reshape(-1, 2) for row in rows]
    seqs: dict[int, list[tuple[int, int]]] = {}
    for i, row in enumerate(rows):
        for k, r in enumerate(row):
            if r["track_id"] < LOOSE_ID:
                seqs.setdefault(r["track_id"], []).append((i, k))
    n_fixed = 0
    for refs in seqs.values():
        t = np.array([frames[i] / fps for i, _ in refs])
        bx = np.array([rows[i][k]["box"] for i, k in refs], dtype=float)
        f, fx = combined_sequence(t, bx)
        for (i, k), p, m in zip(refs, f, fx):
            if m:
                feet[i][k] = p
                n_fixed += 1
    return feet, n_fixed


def apply_h(H: np.ndarray, pts: np.ndarray) -> np.ndarray:
    pts = np.asarray(pts, dtype=float).reshape(-1, 2)
    p = np.c_[pts, np.ones(len(pts))] @ np.asarray(H, dtype=float).reshape(3, 3).T
    with np.errstate(divide="ignore", invalid="ignore"):
        out = p[:, :2] / p[:, 2:3]
    return out


def corrected_meters(tracks: dict) -> tuple[dict[tuple[int, int], tuple[float, float]], int]:
    """Para un `tracks_*.json` ya procesado: (cuadro, track) -> posición en metros reales con los pies corregidos, solo
    de las cajas que cambian. Sirve para volver a aplicar la corrección sin detectar de nuevo."""
    c = {name: i for i, name in enumerate(tracks["box_columns"])}
    fps = tracks["fps"]
    frames = [fr["frame"] for fr in tracks["frames"]]
    rows = [[{"track_id": int(b[c["track_id"]]), "box": [b[c["x1"]], b[c["y1"]], b[c["x2"]], b[c["y2"]]]} for b in fr["boxes"]] for fr in tracks["frames"]]
    feet, n = correct_rows(frames, rows, fps)
    out: dict[tuple[int, int], tuple[float, float]] = {}
    for fr, row, f in zip(tracks["frames"], rows, feet):
        if not fr.get("H"):
            continue
        orig = np.array([[(r["box"][0] + r["box"][2]) / 2, r["box"][3]] for r in row], dtype=float).reshape(-1, 2)
        changed = np.any(np.abs(f - orig) > 1e-6, axis=1)
        if not changed.any():
            continue
        m = apply_h(np.asarray(fr["H"], dtype=float), f[changed])
        for r, p in zip([r for r, ch in zip(row, changed) if ch], m):
            out[(fr["frame"], r["track_id"])] = (float(p[0]), float(p[1]))
    return out, n


# --------------------------------------------------------------------------------------------- evaluación

JUMP_M = 3.0      # como web/lib/cuts.ts
JUMP_MS = 9.0
PAIR_MAX_S = 1.0
BOX_WORDS = ("pie", "inferior", "extiende", "recort", "baila", "estira", "cuadro se mueve")


def _jumps(series: list[tuple[int, float, float]], fps: float) -> list[int]:
    out = []
    for i in range(1, len(series)):
        (f0, x0, y0), (f1, x1, y1) = series[i - 1], series[i]
        dt = (f1 - f0) / fps
        d = float(np.hypot(x1 - x0, y1 - y0))
        if 0 < dt <= PAIR_MAX_S and d > JUMP_M and d / dt > JUMP_MS:
            out.append(i)
    return out


def main(argv: list[str] | None = None) -> None:
    """Evalúa la corrección contra la revisión de saltos (tracking/revision/saltos) y todas las partes con nombres.
    Escribe tracking/revision/feet/informe.md; no toca los tracks."""
    import argparse
    import json
    import sys

    from sportsan.config import load_config, project_root
    from sportsan.tracking.jumps_review import person_series
    from sportsan.tracking.links_eval import named_parts

    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description=main.__doc__)
    ap.add_argument("--match")
    args = ap.parse_args(argv)
    cfg = load_config(match=args.match)
    dir_ = project_root() / cfg["paths"]["tracking_dir"]

    parts: dict[str, dict] = {}
    tot = {"boxes": 0, "fixed": 0, "jumps_before": 0, "jumps_after": 0, "persons": 0}
    clean_moves: list[float] = []
    fixed_moves: list[float] = []
    for name in named_parts(dir_):
        raw = json.loads((dir_ / f"tracks_{name}.json").read_text(encoding="utf-8"))
        labels = json.loads((dir_ / f"labels_{name}.json").read_text(encoding="utf-8"))
        fps = raw["fps"]
        new, n_fixed = corrected_meters(raw)
        series = person_series(raw, labels)
        before = {p: [(b.frame, b.xm, b.ym) for b in s] for p, s in series.items()}
        after = {p: [(b.frame, *new.get((b.frame, b.track), (b.xm, b.ym))) for b in s] for p, s in series.items()}
        parts[name] = {"fps": fps, "before": before, "after": after, "series": series}
        tot["fixed"] += n_fixed
        tot["boxes"] += sum(len(fr["boxes"]) for fr in raw["frames"])
        for p in series:
            jb, ja = _jumps(before[p], fps), _jumps(after[p], fps)
            tot["jumps_before"] += len(jb)
            tot["jumps_after"] += len(ja)
            tot["persons"] += 1
            near = {i for j in jb for i in range(len(before[p])) if abs(before[p][i][0] - before[p][j][0]) <= fps}
            for i, ((_, x0, y0), (_, x1, y1)) in enumerate(zip(before[p], after[p])):
                d = float(np.hypot(x1 - x0, y1 - y0))
                if d > 0:
                    fixed_moves.append(d)
                if i not in near:
                    clean_moves.append(d)

    rev = dir_ / "revision" / "saltos"
    cases = json.loads((rev / "casos.json").read_text(encoding="utf-8"))["cases"]
    answers = json.loads((rev / "respuestas.json").read_text(encoding="utf-8")) if (rev / "respuestas.json").exists() else {}
    rows = []
    groups = {"caja": [0, 0, 0, 0], "identidad": [0, 0, 0, 0]}  # casos, salto del 0 quitado, saltos ±3 s antes, después
    for c in cases:
        p = parts.get(c["part"])
        if not p:
            continue
        fps = p["fps"]
        a = answers.get(str(c["id"]), {})
        note = (a.get("note") or "").lower()
        kind = "caja" if a.get("answer") == "camara" or any(w in note for w in BOX_WORDS) else "identidad"
        b, af = p["before"][c["person"]], p["after"][c["person"]]
        i0 = next((i for i, s in enumerate(b) if abs(s[0] / fps - c["t"]) < 0.02), None)
        if i0 is None:
            continue
        win = lambda ser: [j for j in _jumps(ser, fps) if abs(ser[j][0] / fps - c["t"]) <= 3.0]  # noqa: E731
        gone = i0 not in _jumps(af, fps)
        g = groups[kind]
        g[0] += 1
        g[1] += gone
        g[2] += len(win(b))
        g[3] += len(win(af))
        rows.append(f"| {c['id']} | {kind} | {a.get('answer', '—')} | {'sí' if gone else 'no'} | {len(win(b))} → {len(win(af))} |")

    q = lambda xs, p: float(np.quantile(xs, p)) if xs else float("nan")  # noqa: E731
    moved_clean = [d for d in clean_moves if d > 0]
    lines = [
        "# Corrección de los pies (8d, punto 1)", "",
        f"Regla: ventana ±{WINDOW_S} s por track del seguidor; el borde inferior se aparta de su tendencia más de {int(REL * 100)} % de la altura típica "
        f"(y ≥ {MIN_PX:.0f} px) mientras el superior se aparta menos de la mitad → pies = cabeza + altura típica. `sportsan.tracking.feet`.", "",
        "## Revisión de saltos (30 casos)", "",
        "| Grupo | Casos | Salto del 0 desaparece | Saltos en ±3 s antes → después |", "|---|---|---|---|",
        *[f"| {k} | {v[0]} | {v[1]} | {v[2]} → {v[3]} |" for k, v in groups.items()], "",
        "«caja»: respuesta «es ella» o nota sobre pies / borde inferior / caja que se estira o baila; «identidad»: el resto.", "",
        "| Caso | Grupo | Respuesta | Salto del 0 desaparece | Saltos ±3 s |", "|---|---|---|---|---|", *rows, "",
        "## Todas las partes con nombres", "",
        f"- Cajas corregidas: {tot['fixed']} de {tot['boxes']} ({100 * tot['fixed'] / max(1, tot['boxes']):.1f} %).",
        f"- Saltos imposibles de jugadoras con nombre: {tot['jumps_before']} → {tot['jumps_after']} ({100 * (tot['jumps_after'] - tot['jumps_before']) / max(1, tot['jumps_before']):+.0f} %).",
        f"- Posiciones movidas (todas): {len(fixed_moves)}; desplazamiento mediana {q(fixed_moves, 0.5):.2f} m, p95 {q(fixed_moves, 0.95):.2f} m.",
        f"- Tramos sin salto (a más de 1 s de cualquiera): {len(clean_moves)} posiciones, {len(moved_clean)} movidas "
        f"({100 * len(moved_clean) / max(1, len(clean_moves)):.1f} %); de esas, mediana {q(moved_clean, 0.5):.2f} m, p95 {q(moved_clean, 0.95):.2f} m.", "",
    ]
    out = dir_ / "revision" / "feet"
    out.mkdir(parents=True, exist_ok=True)
    (out / "informe.md").write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines))


if __name__ == "__main__":
    main()

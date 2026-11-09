"""Medición de la fase 1 de la unión de tracks contra lo corregido a mano (docs/propuesta_union_tracks.md).

Por cada parte con nombres (`labels_*.json` + `tracks_*.json`):
- de dónde salen los cambios de persona dentro de un track del seguidor (cruce, tamaño, velocidad, color o nada);
- pureza y uniones pendientes de: tracks del seguidor, identidades de process, trozos puros y trozos ya unidos;
- unión con abstención, entrenada dejando la parte fuera (las demás de entrenamiento), a varios umbrales.

Escribe `tracking/revision/union_f1.md` y el modelo entrenado con todo en `tracking/link_model.json`.

    python -m sportsan.tracking.links_eval --match 2026_09_25_tec_ccm_vs_anahuac --train v1 --test v2_0_4259,v2_5020_10226,v3_0_6890

El umbral de unión por defecto es `LINK_P_MIN` (tracklets.py, 0.95): su fila sale marcada en el informe y es el que usan
las fases siguientes. Para repetir con 0.9: `--p-min 0.9` (o cambiar `LINK_P_MIN`); la tabla trae además las filas de
THRESHOLDS para comparar.
"""
from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from sportsan.config import load_config, project_root
from sportsan.tracking.anchors_cli import Progress
from sportsan.tracking.tracklets import (
    FEATURES,
    LINK_P_MIN,
    LOOSE_ID,
    Box,
    PLAYER_FEATURES,
    Score,
    TreeModel,
    accept_greedy,
    candidate_labels,
    chains,
    color_distance,
    crowded,
    link_candidates,
    player_features,
    player_labels,
    pure_tracklets,
    score_groups,
    truth_from_labels,
    boxes_from_part,
    SIZE_JUMP,
    MAX_SPEED_MS,
    SPEED_SLACK_M,
)

THRESHOLDS = [0.9, 0.95, 0.98, 0.99]
NAME = re.compile(r"^labels_(v\d+)_(\d+)_(\d+)\.json$")


@dataclass
class Part:
    name: str                       # v1_6414_13699
    fps: float
    frames: list[list[Box]]
    truth: dict
    identity: dict                  # (cuadro, track) -> identidad de process
    seconds: float


def load_part(dir_: Path, name: str, feet: bool = False) -> Part:
    raw = json.loads((dir_ / f"tracks_{name}.json").read_text(encoding="utf-8"))
    labels = json.loads((dir_ / f"labels_{name}.json").read_text(encoding="utf-8"))
    c = {n: i for i, n in enumerate(raw["box_columns"])}
    identity = {(fr["frame"], int(b[c["track_id"]])): int(b[c["identity"]]) for fr in raw["frames"] for b in fr["boxes"] if b[c["on_pitch"]]}
    if feet:
        from sportsan.tracking.feet import corrected_meters

        fixed = corrected_meters(raw)[0]
    else:
        fixed = None
    return Part(name, raw["fps"], boxes_from_part(raw, fixed), truth_from_labels(labels), identity, (raw["end_frame"] - raw["start_frame"]) / raw["fps"])


def named_parts(dir_: Path) -> list[str]:
    """Partes con al menos una persona con nombre."""
    out = []
    for p in sorted(dir_.iterdir()):
        m = NAME.match(p.name)
        if not m or not (dir_ / f"tracks_{m[1]}_{m[2]}_{m[3]}.json").exists():
            continue
        lab = json.loads(p.read_text(encoding="utf-8"))
        if any(x.get("named") for x in lab.get("people", [])):
            out.append(f"{m[1]}_{m[2]}_{m[3]}")
    return out


def label_files(dir_: Path) -> list[str]:
    """Nombres de las partes con `labels_*.json` en la carpeta (tengan o no personas con nombre)."""
    if not dir_.is_dir():
        return []
    out = []
    for p in sorted(dir_.iterdir()):
        m = NAME.match(p.name)
        if m:
            out.append(f"{m[1]}_{m[2]}_{m[3]}")
    return out


def video_prefixes(parts: list[str]) -> list[str]:
    """Prefijos de video (v1, v2...) de una lista de partes, sin repetir y en orden."""
    seen: list[str] = []
    for p in parts:
        v = p.split("_", 1)[0]
        if v not in seen:
            seen.append(v)
    return seen


def train_command(match: str, prefixes: list[str]) -> str:
    return f"python -m sportsan.tracking.links_eval --match {match} --train {','.join(prefixes) if prefixes else 'auto'}"


def _venue(dir_: Path, name: str) -> tuple[float, float]:
    """Medidas de la sede (m) de una parte, en metros reales."""
    v = json.loads((dir_ / f"tracks_{name}.json").read_text(encoding="utf-8")).get("venue") or {}
    return float(v.get("length_m") or 105), float(v.get("width_m") or 68)


def switch_causes(part: Part) -> dict[str, int]:
    """Cambios de persona dentro de un track del seguidor, por la primera causa que los explicaría."""
    by_track: dict[int, list[Box]] = {}
    crowd: dict[int, set[int]] = {}
    for row in part.frames:
        if row:
            crowd[row[0].frame] = crowded(row)
        for b in row:
            if b.on_pitch and b.track < LOOSE_ID and isinstance(part.truth.get((b.frame, b.track)), int):
                by_track.setdefault(b.track, []).append(b)
    out = {"cruce": 0, "tamaño": 0, "velocidad": 0, "color": 0, "ninguna": 0}
    for boxes in by_track.values():
        boxes.sort(key=lambda b: b.frame)
        for i in range(1, len(boxes)):
            a, b = boxes[i - 1], boxes[i]
            if part.truth[(a.frame, a.track)] == part.truth[(b.frame, b.track)]:
                continue
            window = [f for f in crowd if abs(f - b.frame) <= part.fps]
            dt = (b.frame - a.frame) / part.fps
            if any(b.track in crowd[f] for f in window):
                out["cruce"] += 1
            elif a.h > 0 and abs(b.h - a.h) / a.h > SIZE_JUMP:
                out["tamaño"] += 1
            elif np.isfinite(a.xm) and np.isfinite(b.xm) and np.hypot(b.xm - a.xm, b.ym - a.ym) > MAX_SPEED_MS * dt + SPEED_SLACK_M:
                out["velocidad"] += 1
            elif color_distance(a.lab, b.lab) > 40:
                out["color"] += 1
            else:
                out["ninguna"] += 1
    return out


def groups_of(part: Part, kind: str, tracklets=None, ident=None) -> dict:
    if kind == "track":
        return {(b.frame, b.track): b.track for row in part.frames for b in row if b.on_pitch}
    if kind == "identity":
        return part.identity
    return {(b.frame, b.track): int(ident[t.id]) for t in tracklets for b in t.boxes}


def fmt_score(s: Score) -> str:
    return f"{100 * s.purity:.2f} % | {s.pieces} | {s.joins_needed} | {s.cuts_needed}"


def main() -> None:
    import sys

    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--match")
    ap.add_argument("--train", default="auto", help="prefijo(s) o nombres de partes de entrenamiento, separados por comas; «auto» (o vacío): todas las partes con nombres de la carpeta")
    ap.add_argument("--test", default="", help="partes de prueba (no se usan para ajustar)")
    ap.add_argument("--accel-veto", action="store_true", help="descartar las uniones que exigen un arranque o una frenada imposible")
    ap.add_argument("--feet", action="store_true", help="posiciones con los pies corregidos (feet.py)")
    ap.add_argument("--p-min", type=float, default=LINK_P_MIN, help=f"umbral de unión que se marca en el informe (por defecto LINK_P_MIN = {LINK_P_MIN}; p. ej. 0.9)")
    ap.add_argument("--report", default="union_f1.md", help="nombre del informe en tracking/revision/")
    ap.add_argument("--reid", default="", choices=["", "classic", "onnx"], help="añade la similitud de apariencia (reid.py) como variable extra")
    ap.add_argument("--reid-hmin", type=float, default=0.0, help="alto mínimo (px) de las dos cajas para usar la similitud; con --reid-sizes solo se cuentan esas uniones")
    ap.add_argument("--reid-sizes", action="store_true", help="cuenta aparte las uniones con cajas >= --reid-hmin (sin añadir la variable si no hay --reid)")
    args = ap.parse_args()
    cfg = load_config(match=args.match)
    root = project_root()
    dir_ = root / cfg["paths"]["tracking_dir"]
    all_named = named_parts(dir_)
    pick = lambda spec: [p for p in all_named if any(p == s or p.startswith(s + "_") or p == s for s in spec.split(",") if s)]  # noqa: E731
    auto = args.train.strip() in ("", "auto")
    train, test = (list(all_named) if auto else pick(args.train)), pick(args.test)
    if auto:
        test = [p for p in test if p not in train]
    if not train:
        labels = label_files(dir_)
        if not labels:
            raise SystemExit(f"No hay con qué entrenar: {dir_} no tiene ningún labels_*.json. Corrige a mano una parte en la mesa (con nombres de jugadoras) y guárdala; eso crea su labels_.")
        raise SystemExit(f"No hay con qué entrenar: hay labels_*.json ({', '.join(labels)}) pero {'ninguno con' if auto else 'ninguno de los pedidos con'} personas con nombre. Nombra a las jugadoras de una parte en la mesa y guárdala.")
    print(f"Entrenamiento: {train}\nPrueba: {test}")
    pg = Progress(dir_ / "revision" / "progreso_linkmodel_modelo.log")
    n_parts = len(train) + len(test)
    parts = {}
    pg.log("lectura", 0, n_parts)
    for i, n in enumerate(train + test, 1):
        parts[n] = load_part(dir_, n, args.feet)
        pg.log("lectura", i, n_parts)

    lines = [f"# Unión de tracks, fase 1 · {cfg.get('match_id', args.match)}", "",
             f"Regla de aceleración: variable `accel_excess` en el modelo{' y veto (se descartan las uniones imposibles)' if args.accel_veto else ' (sin veto)'}. Pies: {'corregidos (feet.py)' if args.feet else 'borde inferior de la caja'}.", ""]
    lines += [f"Entrenamiento ({len(train)} partes, {sum(parts[n].seconds for n in train) / 60:.0f} min): {', '.join(train)}",
              f"Prueba ({len(test)} partes, {sum(parts[n].seconds for n in test) / 60:.0f} min): {', '.join(test) or '—'}", ""]
    lines += ["Solo cuentan las cajas de jugadoras con nombre. **Pureza**: cajas en un grupo cuya mayoría es ella. **Grupos**: trozos o "
              "identidades con alguna jugadora con nombre. **Uniones pendientes**: las que haría falta hacer a mano para que cada "
              "jugadora sea una sola identidad en la parte.", ""]

    # 1. Causes of id switches inside tracker tracks.
    causes: dict[str, int] = {}
    for n in train + test:
        for k, v in switch_causes(parts[n]).items():
            causes[k] = causes.get(k, 0) + v
    lines += ["## 1. Cambios de persona dentro de un track del seguidor", "", "| Causa más probable | Cambios |", "|---|---|"]
    lines += [f"| {k} | {v} |" for k, v in causes.items()] + [""]

    # 2. Purity of each grouping, and ablation of the cut rules.
    tl: dict[str, list] = {}
    rows = {"Tracks del seguidor": Score(), "Identidades de process": Score(), "Trozos puros (todas las reglas)": Score()}
    ablate = {f"sin regla «{r}»": Score() for r in ("cross", "size", "speed", "color")}
    pg.log("trozos", 0, n_parts)
    for k, n in enumerate(train + test, 1):
        p = parts[n]
        rows["Tracks del seguidor"] = rows["Tracks del seguidor"].add(score_groups(groups_of(p, "track"), p.truth))
        rows["Identidades de process"] = rows["Identidades de process"].add(score_groups(groups_of(p, "identity"), p.truth))
        tl[n] = pure_tracklets(p.frames, p.fps)
        rows["Trozos puros (todas las reglas)"] = rows["Trozos puros (todas las reglas)"].add(
            score_groups(groups_of(p, "tl", tl[n], np.arange(len(tl[n]))), p.truth))
        for r in ("cross", "size", "speed", "color"):
            t2 = pure_tracklets(p.frames, p.fps, {r: False})
            ablate[f"sin regla «{r}»"] = ablate[f"sin regla «{r}»"].add(score_groups(groups_of(p, "tl", t2, np.arange(len(t2))), p.truth))
        pg.log("trozos", k, n_parts)
    lines += ["## 2. Pureza de cada forma de agrupar las cajas", "", "| Agrupación | Pureza | Grupos | Uniones pendientes | Cortes pendientes |", "|---|---|---|---|---|"]
    lines += [f"| {k} | {fmt_score(v).replace(' | ', ' | ')} |" for k, v in {**rows, **ablate}.items()] + [""]

    # 3. Is each tracklet a player? (trained leaving the part out)
    length = {n: _venue(dir_, n) for n in train + test}
    pdata = {}
    for n in train + test:
        L, W = length[n]
        X = np.array([player_features(t, L, W, parts[n].fps) for t in tl[n]])
        pdata[n] = (X, player_labels(tl[n], parts[n].truth))

    def fit_trees(Xs, ys):
        X = np.vstack(Xs)
        y = np.concatenate(ys)
        k = y >= 0
        return TreeModel().fit(X[k], y[k].astype(float))

    n_fit = 2 * (len(train) + 1 if len(train) > 1 else 1)       # modelo «¿es jugadora?» y modelo de unión: uno por parte dejada fuera + el completo
    fits = [0]

    def logged_fit(Xs, ys):
        pg.log("entrenamiento", fits[0], n_fit)
        out = fit_trees(Xs, ys)
        fits[0] += 1
        pg.log("entrenamiento", fits[0], n_fit)
        return out

    pg.log("entrenamiento", 0, n_fit)
    # Con una sola parte de entrenamiento no hay otra con que probarla: usa el modelo completo (cifras de entrenamiento optimistas).
    single = len(train) == 1
    pmodel = {n: logged_fit([pdata[m][0] for m in train if m != n], [pdata[m][1] for m in train if m != n]) for n in train if not single}
    pfull = logged_fit([pdata[m][0] for m in train], [pdata[m][1] for m in train])
    if single:
        pmodel = {train[0]: pfull}
    for n in test:
        pmodel[n] = pfull
    p_player = {n: pmodel[n].predict(pdata[n][0]) for n in train + test}
    lines += ["## 3. ¿Es jugadora? (por trozo, en cajas)", "",
              "Árbitros, banca, público y detecciones sueltas se apartan antes de unir. Cifras en cajas, no en trozos.", "",
              "| Partes | Umbral | Jugadoras apartadas por error | No jugadoras que pasan |", "|---|---|---|---|"]
    for label, names in (("entrenamiento", train), ("prueba", test)):
        if not names:
            continue
        for th in (0.3, 0.5, 0.7):
            lost = kept = n_pl = n_no = 0
            for n in names:
                y = pdata[n][1]
                for t, yi, pi in zip(tl[n], y, p_player[n]):
                    w = len(t.boxes)
                    if yi == 1:
                        n_pl += w
                        lost += w * (pi < th)
                    elif yi == 0:
                        n_no += w
                        kept += w * (pi >= th)
            lines.append(f"| {label} | {th} | {100 * lost / max(1, n_pl):.2f} % | {100 * kept / max(1, n_no):.1f} % |")
    lines.append("")

    # 4. Links among players.
    data = {}
    big: dict[str, np.ndarray] = {}
    pg.log("candidatos", 0, n_parts)
    for k, n in enumerate(train + test, 1):
        pg.log("candidatos", k - 1, n_parts)
        cands = link_candidates(tl[n], parts[n].fps, accel_veto=args.accel_veto)
        X = np.array([c.x for c in cands]) if cands else np.zeros((0, len(FEATURES)))
        if args.reid or args.reid_sizes:
            from sportsan.tracking.reid import part_reid, reid_column

            V, H = part_reid(dir_, args.match, n, parts[n], tl[n], args.reid or "classic")
            col = reid_column(cands, V, H, args.reid_hmin)
            big[n] = np.array([min(H[c.a], H[c.b]) >= args.reid_hmin for c in cands], dtype=bool)
            if args.reid:
                X = np.hstack([X, col[:, None]]) if len(cands) else np.zeros((0, len(FEATURES) + 1))
        data[n] = (cands, X, candidate_labels(cands, tl[n], parts[n].truth))
    pg.log("candidatos", n_parts, n_parts)
    lmodel = {n: logged_fit([data[m][1] for m in train if m != n], [data[m][2] for m in train if m != n]) for n in train if not single}
    lfull = logged_fit([data[m][1] for m in train], [data[m][2] for m in train])
    if single:
        lmodel = {train[0]: lfull}
    for n in test:
        lmodel[n] = lfull

    big_stats = [0, 0, 0]

    def chain_scores(names: list[str], th: float, p_min_player: float = 0.5):
        tot = Score()
        made = wrong = 0
        for n in names:
            cands, X, y = data[n]
            for c, pr in zip(cands, lmodel[n].predict(X)):
                c.p = float(pr)
            allowed = {t.id for t, pp in zip(tl[n], p_player[n]) if pp >= p_min_player}
            acc = accept_greedy(cands, p_min=th, allowed=allowed)
            idx = {id(c): i for i, c in enumerate(cands)}
            made += len(acc)
            wrong += sum(1 for c in acc if y[idx[id(c)]] == 0)
            if n in big:
                big_stats[0] += sum(1 for c in acc if big[n][idx[id(c)]])
                big_stats[1] += sum(1 for c in acc if big[n][idx[id(c)]] and y[idx[id(c)]] == 0)
                big_stats[2] += int((big[n] & (y == 1)).sum())
            tot = tot.add(score_groups(groups_of(parts[n], "tl", tl[n], chains(len(tl[n]), acc)), parts[n].truth))
        return tot, made, wrong

    lines += ["## 4. Unión con abstención (solo entre trozos de jugadora)", "",
              "Esfuerzo manual que quedaría = uniones pendientes + cortes pendientes. Se compara con lo que entrega hoy `process`.", ""]
    n_th = len(set(THRESHOLDS) | {args.p_min})
    n_val = n_th * ((1 if train else 0) + (1 if test else 0))
    v_done = 0
    pg.log("validación", 0, n_val)
    for label, names in (("Entrenamiento (cada parte con modelos que no la vieron)", train), ("Prueba (modelos con todo el entrenamiento)", test)):
        if not names:
            continue
        ref = Score()
        for n in names:
            ref = ref.add(score_groups(groups_of(parts[n], "identity"), parts[n].truth))
        lines += [f"### {label}", "", "| Agrupación | Uniones hechas | Erróneas | Pureza | Uniones pendientes | Cortes pendientes | Total a mano |",
                  "|---|---|---|---|---|---|---|",
                  f"| Identidades de process (hoy) | — | — | {100 * ref.purity:.2f} % | {ref.joins_needed} | {ref.cuts_needed} | {ref.joins_needed + ref.cuts_needed} |"]
        big_rows = []
        for th in sorted(set(THRESHOLDS) | {args.p_min}):
            big_stats[:] = [0, 0, 0]
            sc, made, wrong = chain_scores(names, th)
            v_done += 1
            pg.log("validación", v_done, n_val)
            mark = " (umbral elegido)" if th == args.p_min else ""
            lines.append(f"| Trozos + unión ≥ {th}{mark} | {made} | {wrong} | {100 * sc.purity:.2f} % | {sc.joins_needed} | {sc.cuts_needed} | {sc.joins_needed + sc.cuts_needed} |")
            if big:
                big_rows.append(f"| ≥ {th}{mark} | {big_stats[0]} | {big_stats[1]} | {big_stats[2]} |")
        lines.append("")
        if big_rows:
            lines += [f"Solo candidatos con las dos cajas ≥ {args.reid_hmin:g} px:", "", "| Umbral | Uniones hechas | Erróneas | Correctas posibles |", "|---|---|---|---|"] + big_rows + [""]
    # Where the model is sure and where it is not: joins through a crossing vs. clean ones.
    lines += ["### Precisión por tipo de unión (entrenamiento, dejando la parte fuera)", "",
              "| Tipo | Umbral | Precisión | Uniones correctas cubiertas |", "|---|---|---|---|"]
    ci = FEATURES.index("crowd")
    for kind, want in (("sin cruce", 0.0), ("en un cruce", 1.0)):
        ps, ys = [], []
        for n in train:
            _, X, y = data[n]
            k = (y >= 0) & (X[:, ci] == want)
            ps.append(lmodel[n].predict(X[k]))
            ys.append(y[k])
        pp, yy = np.concatenate(ps), np.concatenate(ys)
        for th in (0.9, 0.99):
            m = pp >= th
            lines.append(f"| {kind} | {th} | {100 * yy[m].mean() if m.any() else float('nan'):.1f} % | {100 * (yy[m] == 1).sum() / max(1, (yy == 1).sum()):.0f} % |")
    lines.append("")
    full = lfull
    lines += ["## 5. Modelos", "", f"Unión: árboles de gradiente sobre {len(FEATURES)} variables ({', '.join(FEATURES)}). "
              f"¿Es jugadora?: árboles sobre {len(PLAYER_FEATURES)} variables ({', '.join(PLAYER_FEATURES)}).", ""]

    pg.log("escritura", 0, 1)
    out = dir_ / "revision" / args.report
    out.parent.mkdir(exist_ok=True)
    out.write_text("\n".join(lines), encoding="utf-8")
    if args.report == "union_f1.md" and not args.reid:
        (dir_ / "link_model.json").write_text(json.dumps({"link": full.to_dict(), "player": pfull.to_dict()}), encoding="utf-8")
    pg.log("escritura", 1, 1)
    print("\n".join(lines))
    print(f"\nInforme: {out}")


if __name__ == "__main__":
    main()

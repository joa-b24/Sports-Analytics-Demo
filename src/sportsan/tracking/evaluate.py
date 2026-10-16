"""Cuánto trabajo deja en la mesa de corrección una forma de unir tracks, medido contra correcciones reales.

Las correcciones se exportan desde la app como etiquetas (`labels_<video>_<inicio>_<fin>.json`): para cada caja
original (cuadro, track) dicen de qué persona es al final. Aquí se compara eso con las identidades que propone un
método y se cuenta lo que habría que hacer a mano:

- `merges_needed`: uniones (una persona real repartida en varias identidades).
- `splits_needed`: cortes (una identidad que pasa de una persona a otra). Es lo caro: hay que encontrarlo en el video.
- `ops_needed` = las dos sumadas: la métrica principal.
- `link_precision` / `link_recall`: de los pares de observaciones consecutivas, cuántas uniones del programa son
  correctas y cuántas de las que había que hacer vienen hechas.
- `identities_per_person`, `dup_assigned` (duplicados descartados a mano a los que el programa dio identidad de
  jugadora) y `coverage` (qué parte de las cajas en la cancha está cubierta por personas revisadas).

Solo cuentan las cajas de personas marcadas como revisadas en la mesa: lo demás puede estar sin corregir.

Uso (desde la raíz del repo):
    python -m sportsan.tracking.evaluate --labels <labels.json> [...] --tracks <tracks.json> [...] [--method file legacy]
    python -m sportsan.tracking.evaluate fixture --labels <l.json> --tracks <t.json> --start-s 30 --dur 30 --out tests/fixtures/x.json.gz

Los métodos re-ejecutan la unión sobre las mismas cajas del archivo (sin volver a detectar), así que las etiquetas
siguen valiendo. `file` es la identidad que ya trae el archivo: la línea base.
"""
from __future__ import annotations

import argparse
import gzip
import json
from collections.abc import Callable
from pathlib import Path

Key = tuple[int, int]  # (cuadro, track original)

# Columnas de una caja en tracks_*.json (schema 3): 0 track, 11 on_pitch, 13 identidad propuesta.
COL_TRACK, COL_ON_PITCH, COL_IDENTITY = 0, 11, 13


# ---------------------------------------------------------------- lectura

def read_json(path: str | Path) -> dict:
    p = Path(path)
    raw = p.read_bytes()
    if p.suffix == ".gz" or raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    return json.loads(raw.decode("utf-8"))


def labels_from(data: dict) -> tuple[dict[Key, tuple[int | None, str]], set[int]]:
    """(cuadro, track) -> (persona o None, status) y el conjunto de personas revisadas."""
    if data.get("kind") != "tracks_labels":
        raise ValueError(f"No es un archivo de etiquetas (kind = {data.get('kind')!r}; se espera 'tracks_labels')")
    labels = {(fr["frame"], b["track"]): (b["label"], b["status"]) for fr in data["frames"] for b in fr["boxes"]}
    reviewed = {p["label"] for p in data.get("people", []) if p.get("reviewed")}
    return labels, reviewed


def load_labels(path: str | Path) -> tuple[dict[Key, tuple[int | None, str]], set[int]]:
    return labels_from(read_json(path))


def file_identities(tracks: dict) -> dict[Key, int | None]:
    """Método `file`: la identidad propuesta que trae cada caja (o su track si no trae)."""
    out: dict[Key, int | None] = {}
    for fr in tracks["frames"]:
        for b in fr["boxes"]:
            ident = b[COL_IDENTITY] if len(b) > COL_IDENTITY and b[COL_IDENTITY] is not None else b[COL_TRACK]
            out[(fr["frame"], b[COL_TRACK])] = ident
    return out


def on_pitch_keys(tracks: dict) -> set[Key]:
    return {(fr["frame"], b[COL_TRACK]) for fr in tracks["frames"] for b in fr["boxes"] if len(b) > COL_ON_PITCH and b[COL_ON_PITCH]}


# ---------------------------------------------------------------- medida (funciones puras)

COUNTS = ("merges_needed", "splits_needed", "pairs_proposed", "pairs_proposed_ok", "pairs_true", "pairs_true_kept",
          "identities", "persons", "dup_assigned", "boxes_reviewed", "boxes_on_pitch")


def score(proposed: dict[Key, int | None], labels: dict[Key, tuple[int | None, str]], reviewed: set[int],
          on_pitch: set[Key] | None = None) -> dict:
    """Métricas de una propuesta contra las etiquetas. `proposed[key]` None = el método no le dio identidad
    (un duplicado que descartó). Devuelve los conteos y las proporciones (ver `finish`)."""
    # Cajas que cuentan: de una persona revisada, con identidad propuesta.
    rows = sorted(
        (frame, track, labels[(frame, track)][0], proposed.get((frame, track)))
        for (frame, track), (label, status) in labels.items()
        if status == "player" and label in reviewed
    )
    by_person: dict[int, list[tuple[int, int, int | None]]] = {}
    by_ident: dict[int, list[tuple[int, int, int]]] = {}
    for frame, track, person, ident in rows:
        by_person.setdefault(person, []).append((frame, track, ident))
        if ident is not None:
            by_ident.setdefault(ident, []).append((frame, track, person))

    merges = sum(len({i for _, _, i in obs if i is not None}) - 1 for obs in by_person.values() if any(i is not None for _, _, i in obs))
    splits = pairs_p = pairs_p_ok = 0
    for obs in by_ident.values():
        for (_, _, a), (_, _, b) in zip(obs, obs[1:]):
            pairs_p += 1
            if a == b:
                pairs_p_ok += 1
            else:
                splits += 1
    pairs_t = pairs_t_kept = 0
    for obs in by_person.values():
        for (_, _, a), (_, _, b) in zip(obs, obs[1:]):
            pairs_t += 1
            pairs_t_kept += a is not None and a == b

    # Duplicados descartados a mano a los que el programa dio una identidad que comparte con otras cajas.
    shared: dict[int, int] = {}
    for ident in proposed.values():
        if ident is not None:
            shared[ident] = shared.get(ident, 0) + 1
    dup = sum(1 for k, (_, status) in labels.items() if status == "dropped" and proposed.get(k) is not None and shared.get(proposed[k], 0) > 1)

    counts = {
        "merges_needed": merges, "splits_needed": splits,
        "pairs_proposed": pairs_p, "pairs_proposed_ok": pairs_p_ok, "pairs_true": pairs_t, "pairs_true_kept": int(pairs_t_kept),
        "identities": len(by_ident), "persons": len(by_person), "dup_assigned": dup,
        "boxes_reviewed": len(rows), "boxes_on_pitch": len(on_pitch) if on_pitch is not None else len(rows),
    }
    return finish(counts)


def finish(counts: dict) -> dict:
    """Añade las proporciones a unos conteos (también a la suma de varios archivos)."""
    c = dict(counts)
    ratio = lambda a, b: round(a / b, 4) if b else None  # noqa: E731
    c["ops_needed"] = c["merges_needed"] + c["splits_needed"]
    c["link_precision"] = ratio(c["pairs_proposed_ok"], c["pairs_proposed"])
    c["link_recall"] = ratio(c["pairs_true_kept"], c["pairs_true"])
    c["identities_per_person"] = ratio(c["identities"], c["persons"])
    c["coverage"] = ratio(c["boxes_reviewed"], c["boxes_on_pitch"])
    return c


def add(totals: dict | None, part: dict) -> dict:
    if totals is None:
        return finish({k: part[k] for k in COUNTS})
    return finish({k: totals[k] + part[k] for k in COUNTS})


# ---------------------------------------------------------------- métodos

def available_methods() -> dict[str, Callable[[dict], dict[Key, int | None]]]:
    """Métodos de unión que se pueden medir. Los de las fases siguientes se registran aquí."""
    methods: dict[str, Callable[[dict], dict[Key, int | None]]] = {"file": file_identities}
    try:
        from .restitch import legacy_identities

        methods["legacy"] = legacy_identities
    except ImportError:
        pass
    return methods


# ---------------------------------------------------------------- pasar etiquetas a otro archivo de las mismas cajas


def box_iou(a, b) -> float:
    w = min(a[2], b[2]) - max(a[0], b[0])
    h = min(a[3], b[3]) - max(a[1], b[1])
    if w <= 0 or h <= 0:
        return 0.0
    inter = w * h
    return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter)


def remap_labels(labels: dict, old_tracks: dict, new_tracks: dict, min_iou: float = 0.7) -> tuple[dict, dict]:
    """Etiquetas de `old_tracks` llevadas a las cajas de `new_tracks` (otra corrida sobre el mismo video y cuadros): en
    cada cuadro, cada caja nueva toma la etiqueta de la caja vieja con la que más se solapa (si pasa de `min_iou`, una a
    una). Las que no encuentran pareja quedan sin etiqueta. Devuelve el archivo de etiquetas nuevo y un resumen."""
    old_box = {fr["frame"]: {b[0]: b[1:5] for b in fr["boxes"]} for fr in old_tracks["frames"]}
    old_lab = {fr["frame"]: {x["track"]: x for x in fr["boxes"]} for fr in labels["frames"]}
    frames, matched, total = [], 0, 0
    for fr in new_tracks["frames"]:
        f = fr["frame"]
        olds = old_box.get(f, {})
        pairs = sorted(((box_iou(b[1:5], ob), b[0], ot) for b in fr["boxes"] for ot, ob in olds.items()), reverse=True)
        used_new, used_old, out = set(), set(), []
        for iou, nt, ot in pairs:
            if iou < min_iou or nt in used_new or ot in used_old or ot not in old_lab.get(f, {}):
                continue
            used_new.add(nt)
            used_old.add(ot)
            x = old_lab[f][ot]
            out.append({"track": nt, "label": x["label"], "status": x["status"]})
        total += len(fr["boxes"])
        matched += len(out)
        frames.append({"frame": f, "boxes": out})
    new = {**labels, "frames": frames, "source": {**labels.get("source", {}), "remapped_from": old_tracks.get("tracker")}}
    return new, {"boxes": total, "matched": matched}


# ---------------------------------------------------------------- fixtures

def strip_names(obj):
    """Copia sin ninguna clave player_id (los nombres de las jugadoras no van al repo)."""
    if isinstance(obj, dict):
        return {k: strip_names(v) for k, v in obj.items() if k != "player_id"}
    if isinstance(obj, list):
        return [strip_names(v) for v in obj]
    return obj


def make_fixture(tracks: dict, labels: dict, start_s: float, dur_s: float) -> dict:
    """Recorta una parte (y sus etiquetas) a una ventana de `dur_s` segundos desde `start_s` (contados desde el inicio
    de la parte) y la deja lista para tests/fixtures."""
    f0 = tracks["start_frame"] + round(start_s * tracks["fps"])
    f1 = f0 + round(dur_s * tracks["fps"])
    keep = lambda fr: f0 <= fr["frame"] < f1  # noqa: E731
    t = {**tracks, "start_frame": f0, "end_frame": f1, "frames": [fr for fr in tracks["frames"] if keep(fr)]}
    t.pop("quality", None)
    lab = {**labels, "start_frame": f0, "end_frame": f1, "frames": [fr for fr in labels["frames"] if keep(fr)],
           "manual": [m for m in labels.get("manual", []) if f0 <= m["frame"] < f1]}
    return strip_names({"kind": "eval_fixture", "schema_version": 1, "window_s": [start_s, start_s + dur_s], "tracks": t, "labels": lab})


# ---------------------------------------------------------------- CLI

def _table(rows: list[tuple[str, dict]]) -> str:
    cols = ["ops_needed", "merges_needed", "splits_needed", "link_precision", "link_recall", "identities_per_person", "dup_assigned", "coverage"]
    head = f"{'método':<10}" + "".join(f"{c:>22}" for c in cols)
    lines = [head, "-" * len(head)]
    for name, r in rows:
        lines.append(f"{name:<10}" + "".join(f"{'-' if r[c] is None else r[c]:>22}" for c in cols))
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> None:
    import sys

    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] == "remap":
        ap = argparse.ArgumentParser(prog="evaluate remap", description="Pasa unas etiquetas a otra corrida de las mismas cajas")
        ap.add_argument("--labels", required=True)
        ap.add_argument("--old-tracks", required=True)
        ap.add_argument("--new-tracks", required=True)
        ap.add_argument("--out", required=True)
        a = ap.parse_args(argv[1:])
        new, info = remap_labels(read_json(a.labels), read_json(a.old_tracks), read_json(a.new_tracks))
        Path(a.out).write_text(json.dumps(new), encoding="utf-8")
        print(f"Escrito {a.out}: {info['matched']} de {info['boxes']} cajas con etiqueta.")
        return
    if argv and argv[0] == "fixture":
        ap = argparse.ArgumentParser(prog="evaluate fixture", description="Recorta una parte con sus etiquetas para tests/fixtures")
        ap.add_argument("--labels", required=True)
        ap.add_argument("--tracks", required=True)
        ap.add_argument("--start-s", type=float, required=True)
        ap.add_argument("--dur", type=float, default=30.0)
        ap.add_argument("--out", required=True)
        a = ap.parse_args(argv[1:])
        fx = make_fixture(read_json(a.tracks), read_json(a.labels), a.start_s, a.dur)
        out = Path(a.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(gzip.compress(json.dumps(fx, separators=(",", ":")).encode("utf-8")))
        print(f"Escrito {out}: {len(fx['tracks']['frames'])} cuadros procesados, sin nombres de jugadoras.")
        return

    ap = argparse.ArgumentParser(description="Mide cuánto trabajo deja cada método de unión, contra las etiquetas de la mesa de corrección")
    ap.add_argument("--labels", nargs="+", required=True)
    ap.add_argument("--tracks", nargs="+", required=True)
    ap.add_argument("--method", nargs="+", default=["file"])
    a = ap.parse_args(argv)
    if len(a.labels) != len(a.tracks):
        raise SystemExit("Hace falta un --tracks por cada --labels (en el mismo orden).")
    methods = available_methods()
    unknown = [m for m in a.method if m not in methods]
    if unknown:
        raise SystemExit(f"Métodos no disponibles: {unknown}. Hay: {list(methods)}")
    totals: dict[str, dict | None] = {m: None for m in a.method}
    for lp, tp in zip(a.labels, a.tracks):
        labels, reviewed = load_labels(lp)
        tracks = read_json(tp)
        if not reviewed:
            print(f"  {Path(lp).name}: ninguna persona marcada como revisada; no cuenta.")
            continue
        pitch = on_pitch_keys(tracks)
        for m in a.method:
            totals[m] = add(totals[m], score(methods[m](tracks), labels, reviewed, pitch))
        print(f"  {Path(lp).name}: {len(reviewed)} persona(s) revisada(s)")
    rows = [(m, r) for m, r in totals.items() if r is not None]
    if not rows:
        raise SystemExit("Ninguna etiqueta con personas revisadas.")
    print(_table(rows))


if __name__ == "__main__":
    main()

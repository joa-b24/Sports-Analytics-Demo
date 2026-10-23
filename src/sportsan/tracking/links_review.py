"""Muestra a ciegas para revisar a mano las dudas de la fase 1 (docs/propuesta_union_tracks.md, sección 8b).

Tres tipos de caso, mezclados y sin decir qué dice el modelo ni qué dice la corrección:
- **unión discutida**: el modelo la daba por segura (p >= 0.99, entrenado sin ver esa parte) y la corrección a mano dice
  que son dos jugadoras distintas. ¿Se equivoca el modelo o la corrección?
- **control**: el modelo la daba por segura y la corrección está de acuerdo. Mide qué tan fiable es la revisión.
- **cambio sin causa**: dentro de un mismo track del seguidor la corrección cambia de persona sin cruce, salto de tamaño,
  velocidad ni color. ¿Cambió de verdad?

Escribe `tracking/revision/muestra_uniones/` con un JPG por caso, `index.html` (se abre en el navegador; las respuestas se
guardan en él y se descargan como JSON) y `casos.json` con lo que dice cada fuente, para comparar después.

    python -m sportsan.tracking.links_review --match 2026_09_25_tec_ccm_vs_anahuac --train v1
"""
from __future__ import annotations

import argparse
import html
import json
import random
from pathlib import Path

import numpy as np

from sportsan.config import load_config, project_root
from sportsan.tracking.links_eval import load_part, named_parts, switch_causes  # noqa: F401  (switch_causes: same rules)
from sportsan.tracking.tracklets import (
    LOOSE_ID,
    MAX_SPEED_MS,
    SIZE_JUMP,
    SPEED_SLACK_M,
    TreeModel,
    candidate_labels,
    color_distance,
    crowded,
    link_candidates,
    pure_tracklets,
    tracklet_truth,
)

COLORS = {"a": (255, 200, 0), "b": (255, 0, 200)}   # BGR: cian para la primera caja, magenta para la segunda


def no_cause_switches(part) -> list[tuple]:
    """Cambios de persona dentro de un track del seguidor sin cruce, tamaño, velocidad ni color (como switch_causes)."""
    by_track: dict[int, list] = {}
    crowd: dict[int, set[int]] = {}
    for row in part.frames:
        if row:
            crowd[row[0].frame] = crowded(row)
        for b in row:
            if b.on_pitch and b.track < LOOSE_ID and isinstance(part.truth.get((b.frame, b.track)), int):
                by_track.setdefault(b.track, []).append(b)
    out = []
    for boxes in by_track.values():
        boxes.sort(key=lambda b: b.frame)
        for a, b in zip(boxes, boxes[1:]):
            if part.truth[(a.frame, a.track)] == part.truth[(b.frame, b.track)]:
                continue
            dt = (b.frame - a.frame) / part.fps
            if any(b.track in crowd[f] for f in crowd if abs(f - b.frame) <= part.fps):
                continue
            if a.h > 0 and abs(b.h - a.h) / a.h > SIZE_JUMP:
                continue
            if np.isfinite(a.xm) and np.isfinite(b.xm) and np.hypot(b.xm - a.xm, b.ym - a.ym) > MAX_SPEED_MS * dt + SPEED_SLACK_M:
                continue
            if color_distance(a.lab, b.lab) > 40:
                continue
            out.append((a, b))
    return out


def render(cap, frames_boxes: list[tuple[int, list[tuple[object, str]]]], out: Path) -> None:
    """Una imagen con los cuadros lado a lado, recortados alrededor de las cajas marcadas."""
    import cv2

    boxes = [b for _, bs in frames_boxes for b, _ in bs]
    cx = float(np.mean([(b.x1 + b.x2) / 2 for b in boxes]))
    cy = float(np.mean([(b.y1 + b.y2) / 2 for b in boxes]))
    span = max(160.0, max(max(b.x2 for b in boxes) - min(b.x1 for b in boxes), 1.6 * (max(b.y2 for b in boxes) - min(b.y1 for b in boxes))) * 1.8)
    w, h = int(span), int(span * 9 / 16)
    tiles = []
    for frame, bs in frames_boxes:
        cap.set(cv2.CAP_PROP_POS_FRAMES, frame)
        ok, img = cap.read()
        if not ok:
            img = np.zeros((1080, 1920, 3), np.uint8)
        for b, key in bs:
            cv2.rectangle(img, (int(b.x1), int(b.y1)), (int(b.x2), int(b.y2)), COLORS[key], 2)
        x0 = int(min(max(0, cx - w / 2), img.shape[1] - w))
        y0 = int(min(max(0, cy - h / 2), img.shape[0] - h))
        crop = img[max(0, y0):y0 + h, max(0, x0):x0 + w]
        tiles.append(cv2.resize(crop, (640, 360), interpolation=cv2.INTER_CUBIC))
    gap = np.full((360, 8, 3), 30, np.uint8)
    row = tiles[0]
    for t in tiles[1:]:
        row = np.hstack([row, gap, t])
    cv2.imwrite(str(out), row, [cv2.IMWRITE_JPEG_QUALITY, 88])


def main() -> None:
    import sys

    import cv2

    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--match")
    ap.add_argument("--train", default="v1")
    ap.add_argument("--disputed", type=int, default=20)
    ap.add_argument("--control", type=int, default=5)
    ap.add_argument("--switches", type=int, default=15)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()
    rng = random.Random(args.seed)
    cfg = load_config(match=args.match)
    root = project_root()
    dir_ = root / cfg["paths"]["tracking_dir"]
    names = [n for n in named_parts(dir_) if any(n.startswith(s + "_") or n == s for s in args.train.split(","))]
    parts = {n: load_part(dir_, n) for n in names}
    tl = {n: pure_tracklets(parts[n].frames, parts[n].fps) for n in names}
    data = {}
    for n in names:
        c = link_candidates(tl[n], parts[n].fps)
        data[n] = (c, np.array([x.x for x in c]), candidate_labels(c, tl[n], parts[n].truth))
    print("Entrenando dejando cada parte fuera…")
    disputed, control = [], []
    for n in names:
        X = np.vstack([data[m][1] for m in names if m != n])
        y = np.concatenate([data[m][2] for m in names if m != n])
        k = y >= 0
        model = TreeModel().fit(X[k], y[k].astype(float))
        c, Xn, yn = data[n]
        for ci, p, yi in zip(c, model.predict(Xn), yn):
            if p >= 0.99 and yi == 0:
                disputed.append((n, ci, float(p)))
            elif p >= 0.99 and yi == 1:
                control.append((n, ci, float(p)))
    switches = [(n, a, b) for n in names for a, b in no_cause_switches(parts[n])]
    print(f"Uniones discutidas: {len(disputed)} · de control posibles: {len(control)} · cambios sin causa: {len(switches)}")

    pick = lambda xs, k: rng.sample(xs, min(k, len(xs)))  # noqa: E731
    cases = []
    for n, c, p in pick(disputed, args.disputed) + pick(control, args.control):
        A, B = tl[n][c.a], tl[n][c.b]
        kind = "discutida" if any(x[1] is c for x in disputed) else "control"
        cases.append({"kind": kind, "part": n, "p_model": round(p, 4),
                      "truth_a": tracklet_truth(A, parts[n].truth)[0], "truth_b": tracklet_truth(B, parts[n].truth)[0],
                      "frames": [max(A.start, A.end - int(0.6 * parts[n].fps)), A.end, B.start],
                      "a": A, "b": B, "track_a": A.track, "track_b": B.track})
    for n, a, b in pick(switches, args.switches):
        cases.append({"kind": "cambio sin causa", "part": n, "p_model": None,
                      "truth_a": parts[n].truth[(a.frame, a.track)], "truth_b": parts[n].truth[(b.frame, b.track)],
                      "frames": [a.frame, b.frame], "box_a": a, "box_b": b, "track_a": a.track, "track_b": b.track})
    rng.shuffle(cases)

    out = dir_ / "revision" / "muestra_uniones"
    out.mkdir(parents=True, exist_ok=True)
    video = lambda n: root / cfg["paths"]["match_dir"] / "video" / f"{n.split('_')[0]}.mp4"  # noqa: E731
    caps: dict[str, object] = {}
    saved = []
    for i, case in enumerate(cases, 1):
        n = case["part"]
        cap = caps.setdefault(n.split("_")[0], cv2.VideoCapture(str(video(n))))
        if "a" in case:
            A, B = case.pop("a"), case.pop("b")
            at = lambda t, f: next((b for b in t.boxes if b.frame == f), None)  # noqa: E731
            fb = [(case["frames"][0], [(at(A, case["frames"][0]) or A.boxes[0], "a")]), (A.end, [(A.boxes[-1], "a")]), (B.start, [(B.boxes[0], "b")])]
        else:
            a, b = case.pop("box_a"), case.pop("box_b")
            fb = [(a.frame, [(a, "a")]), (b.frame, [(b, "b")])]
        render(cap, fb, out / f"caso_{i:02d}.jpg")
        case["id"] = i
        case["seconds"] = [round(f / parts[n].fps, 2) for f in case["frames"]]
        saved.append(case)
    (out / "casos.json").write_text(json.dumps(saved, indent=1, default=str), encoding="utf-8")

    cards = "\n".join(
        f'''<section class="case" data-id="{c["id"]}">
  <h2>Caso {c["id"]}</h2>
  <img src="caso_{c["id"]:02d}.jpg" alt="Caso {c["id"]}" loading="lazy">
  <p class="q">{"¿La caja <b class=a>cian</b> y la caja <b class=b>magenta</b> son la misma jugadora?" if len(c["frames"]) == 3 else "¿La caja <b class=a>cian</b> (antes) y la <b class=b>magenta</b> (después) son la misma persona?"}
  <span class="t">Video {html.escape(c["part"].split("_")[0])} · {" → ".join(f"{int(s // 60)}:{s % 60:05.2f}" for s in c["seconds"])}</span></p>
  <div class="opts">{"".join(f'<label><input type="radio" name="c{c["id"]}" value="{v}"> {t}</label>' for v, t in (("same", "Misma"), ("diff", "Distinta"), ("unsure", "No se ve")))}</div>
  <input class="note" name="n{c["id"]}" placeholder="Nota (opcional)">
</section>''' for c in saved)
    (out / "index.html").write_text(f'''<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Revisión de uniones</title><style>
:root{{color-scheme:dark;--bg:#0c0c0d;--s:#141415;--ink:#f2f2f0;--m:#b0b0ab;--line:#2b2b2e}}
body{{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,sans-serif}}
main{{max-width:1980px;margin:0 auto;padding:24px 16px 80px}}
h1{{font-size:22px;margin:0 0 4px}} .lead{{color:var(--m);max-width:70ch}}
.case{{background:var(--s);border-radius:12px;padding:16px;margin:16px 0}} .case h2{{margin:0 0 8px;font-size:16px}}
img{{width:100%;height:auto;border-radius:8px;display:block}} .q{{margin:10px 0 6px}} .t{{color:var(--m);font-size:13px;margin-left:8px}}
b.a{{color:#00c8ff}} b.b{{color:#ff3cc8}} .opts{{display:flex;gap:18px;flex-wrap:wrap}} .opts label{{cursor:pointer}}
.note{{margin-top:8px;width:100%;max-width:520px;background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:6px 10px}}
.bar{{position:fixed;bottom:0;left:0;right:0;background:#1d1d1f;border-top:1px solid var(--line);padding:10px 16px;display:flex;gap:12px;align-items:center}}
button{{background:#3a66ff;color:#fff;border:0;border-radius:8px;padding:8px 14px;font-weight:600;cursor:pointer}}
</style></head><body><main>
<h1>Revisión de uniones ({len(saved)} casos)</h1>
<p class="lead">Recortes del video con cajas marcadas. Con tres cuadros: 0.6 s antes, el último de la caja cian y el primero de la magenta.
Con dos: el antes y el después dentro de un mismo track. No dice qué opinan el modelo ni la corrección. Las respuestas se guardan en este
navegador; al terminar, «Descargar respuestas» y guarda el archivo en esta misma carpeta.</p>
{cards}
</main><div class="bar"><span id="count"></span><button id="dl">Descargar respuestas</button></div>
<script>
const KEY="revision_uniones";let st={{}};try{{st=JSON.parse(localStorage.getItem(KEY)||"{{}}")}}catch(e){{}}
const save=()=>{{try{{localStorage.setItem(KEY,JSON.stringify(st))}}catch(e){{}};count()}};
const count=()=>{{const n=Object.values(st).filter(v=>v&&v.answer).length;document.getElementById("count").textContent=n+" de {len(saved)} respondidos"}};
document.querySelectorAll(".case").forEach(c=>{{const id=c.dataset.id;const v=st[id]||{{}};
 c.querySelectorAll("input[type=radio]").forEach(r=>{{if(r.value===v.answer)r.checked=true;r.onchange=()=>{{st[id]={{...(st[id]||{{}}),answer:r.value}};save()}}}});
 const n=c.querySelector(".note");n.value=v.note||"";n.oninput=()=>{{st[id]={{...(st[id]||{{}}),note:n.value}};save()}}}});
document.getElementById("dl").onclick=()=>{{const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([JSON.stringify(st,null,1)],{{type:"application/json"}}));a.download="respuestas.json";a.click()}};
count();
</script></body></html>''', encoding="utf-8")
    print(f"Listo: {out / 'index.html'}")


if __name__ == "__main__":
    main()

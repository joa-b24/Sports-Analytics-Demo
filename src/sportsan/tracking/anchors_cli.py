"""Modo real de `anchors` (fase 3 de la unión de tracks): sugerir anclas y rellenar entre las que puso la persona.

    python -m sportsan.tracking.anchors suggest --match <id> --part v1_41994_43460 [--per-min 2]
    python -m sportsan.tracking.anchors fill    --match <id> --part v1_41994_43460

Archivos en `matches/<id>/tracking/auto/` (contrato con la app web):

- `suggest_<parte>.json`  {"part","fps","chains":[{"id","team","t0","t1","n","boxes":[[frame,track_id],...]}],
                           "suggestions":[{"chain","frame","track","score","why"}],
                           "available":{"1":n,...,"5":n,"hybrid":n,"zones":{"near":n,"center":n,"far":n}}}
  (sugerencias que salen de verdad a cada densidad; «hybrid» = cuota por franja de la cancha respecto a la cámara)
- `anchors_<parte>.json`  (lo escribe la app) {"anchors":[{"frame","track","player"}]}
  Una ancla con "player":"__no__" significa «esta cadena NO es jugadora» (árbitro, banca, público, sombra): fill no la asigna a
  nadie, la saca del relleno y de las dudas (informativa `no_jugadora`, lista en "not_player") y suggest no vuelve a sugerirla
  ni a las cadenas que comparten su track. Si la cadena también tiene una jugadora, manda la jugadora. Las anclas saltadas
  NO se envían: las guarda solo el navegador y no influyen en el relleno.
- Cada duda trae "boxes":[{frame,track,player,role,t,chain}] con las cajas implicadas y sus cuadros exactos (salto: antes y
  despues + "jump"; dos_sitios: a y b; union_dudosa: a, b y candidata(s); hueco_largo: antes y despues + t0,t1; sin_nombre: a +
  t0,t1) y, en salto/dos_sitios/union_dudosa, "resolution":{"options":[...],"default":...} (ver RESOLUTION).
- `links_<parte>_exp.json` (fill --variant exp, variante B) mismo formato + "variant":"exp" y "passes" (conteos por pasada:
                           exclusion, doubles, jumps, holes); drops con reason exclusion|ruta|ambas|salto
- `links_<parte>.json`    {"part","identities":[{"player","chains","tracks","t_ranges","interpolated"}],
                           "doubts":[{"kind","frame","track","players","note"}],
                           "drops":[{"frame","track","player","reason"}]  (dobles cajas descartadas, doubles.py;
                           reason ruta|ambas; la app las aplica como TrackEdits.dropped),
                           "coverage":{"per_player":{id:segundos},"interpolated_s":float},"ignored_anchors":[...]}

Sin verdad (`labels_*`): el equipo de cada cadena es el de process, los pies se corrigen con `feet.py` y los modelos son los
de `tracking/link_model.json`. Tiempos en segundos de video (cuadro / fps). Nada se inventa: un hueco solo se marca como
interpolado si una persona pudo recorrerlo (velocidad y aceleración físicas, `coverage.bridge_possible`); los demás quedan
como dudas.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from sportsan.tracking.anchors import (
    ANCHOR_ISOLATION_M,
    ANCHOR_MIN_S,
    DOUBT_COST,
    GK_RATE,
    HYBRID_RATES,
    Chain,
    Fill,
    _finite_end,
    build_chains,
    camera_sign,
    hybrid_rate,
    in_goal_zone,
    lateral,
    mean_position,
    zone_edges,
    zone_of,
    ZONES,
    fill_both,
    transition_cost,
)
from sportsan.tracking.doubles import box_entry, jump_info
from sportsan.tracking.tracklets import (
    FEATURES,
    LINK_P_MIN,
    PLAYER_FEATURES,
    TEAM_S0_MS,
    LINK_SLACK_M,
    Box,
    TreeModel,
    accept_greedy,
    link_candidates,
    player_features,
    pure_tracklets,
    boxes_from_part,
)

UNNAMED_COST_REAL = 2.0        # costo de dejar una cadena sin nombre (medido en la simulación)
MAX_BOXES = 60                 # cajas por cadena en suggest_*.json
SAME_PLAYER_COST = 2.5         # dos cadenas con transición más barata que esto se consideran la misma persona probable
SAME_PLAYER_S = 20.0           # ...si el hueco entre ellas es de hasta tantos segundos
MAX_PER_WINDOW = 11
LONG_S = 8.0                   # cadena «larga»
UNCERTAIN = 0.5
BRIDGE_S = 4.0                 # huecos de hasta tantos segundos se interpolan
TASK_KINDS = ('salto', 'dos_sitios', 'union_dudosa')   # lo que revisa la persona; hueco_largo y sin_nombre solo se cuentan
DOS_SITIOS_RATIO = 2.0         # sin ancla, la cadena mayor gana si dura al menos tantas veces la otra
MAX_ANCHOR_SNAP = 15           # cuadros: tolerancia para encontrar la caja de un ancla en su track
NOT_PLAYER = "__no__"          # ancla «esta cadena no es jugadora» (árbitro, banca, público, sombra); la escribe la app
MAX_CANDIDATES = 3             # candidatas que se muestran en una union_dudosa
CANDIDATE_WINDOW_S = 2.0       # ...que empiezan a lo más tanto antes o después de la cadena dudosa
# Opciones de resolución de cada tipo de tarea: la app elige una; `default` es lo que ya hace el relleno.
RESOLUTION = {
    "salto": (["antes_es_ella", "despues_es_ella", "ninguna", "esta_bien"], "esta_bien"),
    "dos_sitios": (["a_es_ella", "b_es_ella", "ninguna", "las_dos"], "ninguna"),
    "union_dudosa": (["unir", "no_unir", "otra"], "unir"),
}


def not_player_chains(prep: "Prepared", anchors: list[dict]) -> set[int]:
    """Cadenas marcadas «no es jugadora» (ancla con player `__no__`) y las que comparten track con ellas. Una cadena que
    tenga ancla de una jugadora nunca entra."""
    index = {(b.frame, b.track): c.id for c in prep.chains for b in c.tl.boxes}
    by_track: dict[int, list[tuple[int, int]]] = {}
    for (f, t), cid in index.items():
        by_track.setdefault(t, []).append((f, cid))
    seeds, named = set(), set()
    for a in anchors:
        cid = resolve_anchor(prep, index, by_track, int(a["frame"]), int(a["track"]))
        if cid is not None:
            (seeds if str(a["player"]) == NOT_PLAYER else named).add(cid)
    seeds -= named
    if not seeds:
        return set()
    by_id = {c.id: c for c in prep.chains}
    tracks = {b.track for cid in seeds for b in by_id[cid].tl.boxes}
    return {c.id for c in prep.chains if c.id not in named and (c.id in seeds or any(b.track in tracks for b in c.tl.boxes))}


class Progress:
    """Registro de avance con fase, n/N, % y ETA en `tracking/revision/progreso_<tarea>.log`."""

    def __init__(self, path: Path | None):
        self.path = path
        self.t0 = time.time()
        self.phase, self.p0 = "", time.time()
        if path:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("", encoding="utf-8")

    def log(self, phase: str, n: int, total: int) -> None:
        if phase != self.phase:
            self.phase, self.p0 = phase, time.time()
        el = time.time() - self.p0
        eta = el / n * (total - n) if n else float("nan")
        line = f"{time.strftime('%H:%M:%S')} {phase} {n}/{total} {100 * n / max(1, total):.0f}% ETA {eta:.0f}s (total {time.time() - self.t0:.0f}s)"
        if self.path:
            with self.path.open("a", encoding="utf-8") as f:
                f.write(line + "\n")


# ------------------------------------------------------------------------------------------------ preparación

@dataclass
class Models:
    link: TreeModel
    player: TreeModel

    @classmethod
    def load(cls, dir_: Path) -> "Models":
        d = json.loads((dir_ / "link_model.json").read_text(encoding="utf-8"))
        if d["link"].get("features") != FEATURES:
            raise SystemExit("link_model.json no corresponde a las variables actuales (FEATURES): hay que reentrenarlo con links_eval")
        player = TreeModel.from_dict(d["player"])
        if len(player.cuts) != len(PLAYER_FEATURES):
            raise SystemExit("link_model.json: el modelo «¿es jugadora?» no corresponde a PLAYER_FEATURES")
        return cls(TreeModel.from_dict(d["link"]), player)


@dataclass
class Prepared:
    part: str
    fps: float
    frames: list[list[Box]]
    chains: list[Chain]
    allowed: set[int]              # cadenas que son de jugadora (primer trozo clasificado como jugadora)
    link_p: dict[tuple[int, int], float]
    rows: dict[int, list[Box]]
    image_wh: tuple[float, float]
    cands_in: dict[int, list[float]] = field(default_factory=dict)   # trozo -> p de sus candidatos de entrada
    venue_lw: tuple[float, float] = (105.0, 68.0)   # largo y ancho de la sede en metros
    sign: int = 1                  # +1 si `ym` crece hacia la cámara (camera_sign)
    conf: dict[tuple[int, int], float] = field(default_factory=dict)   # (cuadro, track) -> confianza del detector
    stride: int = 0                # paso entre cuadros procesados (0: se deduce de `rows`)


def prepare(dir_: Path, part: str, models: Models, progress: Progress | None = None, feet: bool = True,
            p_min: float = LINK_P_MIN) -> Prepared:
    pg = progress or Progress(None)
    pg.log("lectura", 0, 1)
    raw = json.loads((dir_ / f"tracks_{part}.json").read_text(encoding="utf-8"))
    fps = float(raw["fps"])
    pg.log("lectura", 1, 1)
    fixed = None
    if feet:
        from sportsan.tracking.feet import corrected_meters

        pg.log("pies", 0, 1)
        fixed = corrected_meters(raw)[0]
        pg.log("pies", 1, 1)
    frames = boxes_from_part(raw, fixed)
    venue = raw.get("venue") or {}
    L, W = float(venue.get("length_m") or 105), float(venue.get("width_m") or 68)
    wh = (float(raw.get("image_w") or 1920), float(raw.get("image_h") or 1080))
    ci = {n: i for i, n in enumerate(raw["box_columns"])}
    conf = {(fr["frame"], int(b[ci["track_id"]])): float(b[ci["conf"]] or 0.0) for fr in raw["frames"] for b in fr["boxes"]} if "conf" in ci else {}
    stride = int(raw.get("stride") or 1)
    del raw
    pg.log("trozos", 0, 1)
    tl = pure_tracklets(frames, fps)
    pg.log("trozos", 1, 1)
    X = np.array([player_features(t, L, W, fps) for t in tl]) if tl else np.zeros((0, len(PLAYER_FEATURES)))
    player_ok = {t.id for t, p in zip(tl, models.player.predict(X)) if p >= 0.5}
    pg.log("candidatos", 0, 1)
    cands = link_candidates(tl, fps)
    if cands:
        for c, p in zip(cands, models.link.predict(np.array([c.x for c in cands]))):
            c.p = float(p)
    pg.log("candidatos", 1, 1)
    links = accept_greedy(cands, p_min=p_min, allowed=player_ok)
    link_p = {(c.a, c.b): c.p for c in cands}
    cands_in: dict[int, list[float]] = {}
    for c in cands:
        if c.a in player_ok and c.b in player_ok:
            cands_in.setdefault(c.b, []).append(c.p)
    chs = build_chains(tl, links)
    allowed = {c.id for c in chs if c.first in player_ok}
    rows = {r[0].frame: r for r in frames if r}
    return Prepared(part, fps, frames, chs, allowed, link_p, rows, wh, cands_in, (L, W), camera_sign(frames), conf, stride)


def team_label(c: Chain, allowed: set[int]) -> str:
    if c.id not in allowed:
        return "out"
    return c.team if c.team in ("own", "opp", "ref") else "out"


# ------------------------------------------------------------------------------------------------ suggest

def central_box(c: Chain, rows: dict[int, list[Box]], radius: float = ANCHOR_ISOLATION_M) -> Box | None:
    """Caja central de la cadena si nadie está a menos de `radius` m de ella en ese cuadro."""
    b = c.tl.boxes[len(c.tl.boxes) // 2]
    if not np.isfinite(b.xm):
        return None
    for o in rows.get(b.frame, []):
        if o.track != b.track and o.on_pitch and np.isfinite(o.xm) and np.hypot(o.xm - b.xm, o.ym - b.ym) < radius:
            return None
    return b


def uncertainty(c: Chain, cands_in: dict[int, list[float]]) -> float:
    """0 (su predecesora más probable es clara) a 1 (ninguna, o varias parecidas): mitad por lo lejos que está de seguro la
    mejor, mitad por lo poco que le saca a la segunda."""
    ps = sorted(cands_in.get(c.first, []), reverse=True)
    best = ps[0] if ps else 0.0
    second = ps[1] if len(ps) > 1 else 0.0
    return 0.5 * (1 - best) + 0.5 * (1 - (best - second))


def _same_person(a: Chain, b: Chain, fps: float, link_p) -> bool:
    if a.start > b.start:
        a, b = b, a
    dt = (b.start - a.end) / fps
    if dt <= 0 or dt > SAME_PLAYER_S:
        return False
    return transition_cost(a, b, fps, link_p) < SAME_PLAYER_COST


def chain_zone(c: Chain, prep: Prepared, edges: tuple[float, float]) -> tuple[str, bool]:
    """Franja (near/center/far) de una cadena por su posición media y si cae en la zona de portería."""
    x, y = mean_position(c.tl.boxes)
    L, W = prep.venue_lw
    if not np.isfinite(y):
        return "center", False
    return zone_of(lateral(y, W, prep.sign), edges), in_goal_zone(x, y, L, W)


def suggest(prep: Prepared, per_min: "float | str" = 2.0, covered: set[int] | None = None,
            zone_rates: dict[str, float] | None = None, zone_mode: str = "thirds") -> dict:
    """`per_min`: número (una densidad para todas) o "hybrid" (cada cadena propia pide la cuota de su franja de la cancha,
    `zone_rates`, y las de la zona de portería a lo más GK_RATE)."""
    hybrid = per_min == "hybrid"
    zone_rates = zone_rates or HYBRID_RATES
    fps = prep.fps
    chs = prep.chains
    covered = covered or set()
    by_id = {c.id: c for c in chs}
    frames = sorted(prep.rows)
    out_chains = []
    for c in chs:
        n = len(c.tl.boxes)
        idx = np.unique(np.linspace(0, n - 1, min(n, MAX_BOXES)).round().astype(int))
        out_chains.append({"id": c.id, "team": team_label(c, prep.allowed), "t0": round(c.start / fps, 3),
                           "t1": round(c.end / fps, 3), "n": n,
                           "boxes": [[c.tl.boxes[i].frame, c.tl.boxes[i].track] for i in idx]})
    cand: list[tuple[int, Chain, Box, float, str]] = []
    for c in chs:
        if c.id not in prep.allowed or c.team != "own" or c.id in covered or (c.end - c.start) / fps < ANCHOR_MIN_S:
            continue
        b = central_box(c, prep.rows)
        if b is None:
            continue
        u = uncertainty(c, prep.cands_in)
        dur = (c.end - c.start) / fps
        score = u + 0.1 * min(dur / 10, 1.0)
        why = "incierta" if u >= UNCERTAIN else "larga" if dur >= LONG_S else "aislada"
        cand.append((b.frame, c, b, score, why))
    L, W = prep.venue_lw
    mids = [mean_position(c.tl.boxes)[1] for _, c, _, _, _ in cand]
    edges = zone_edges([lateral(y, W, prep.sign) for y in mids if np.isfinite(y)], zone_mode)
    zone_info = {c.id: chain_zone(c, prep, edges) for _, c, _, _, _ in cand}

    def pick(rate: float, pool: list | None = None) -> list[dict]:
        pool = cand if pool is None else pool
        slot = 60.0 / rate * fps
        sugg = []
        prev: list[Chain] = []
        n_win = max(1, int(np.ceil((frames[-1] + 1 - frames[0]) / slot))) if frames else 0
        for k in range(n_win):
            lo, hi = frames[0] + k * slot, frames[0] + (k + 1) * slot
            opts = sorted((x for x in pool if lo <= x[0] < hi), key=lambda x: -x[3])
            picked: list[Chain] = []
            for f, c, b, score, why in opts:
                if len(picked) >= MAX_PER_WINDOW:
                    break
                if any(_same_person(p, c, fps, prep.link_p) for p in picked + prev):
                    continue
                picked.append(c)
                sugg.append({"chain": c.id, "frame": int(f), "track": int(b.track), "score": round(float(score), 4), "why": why})
            prev = picked
        sugg.sort(key=lambda s: s["frame"])
        return sugg

    def pick_hybrid() -> tuple[list[dict], dict[str, int]]:
        """Cada cadena pide la cuota de su franja; las de portería, GK_RATE. Se sugiere por grupo de cuota."""
        groups: dict[float, list] = {}
        for x in cand:
            z, goal = zone_info[x[1].id]
            groups.setdefault(min(zone_rates[z], GK_RATE) if goal else zone_rates[z], []).append(x)
        out = [s for r, g in groups.items() for s in pick(r, g)]
        out.sort(key=lambda s: s["frame"])
        zones = {z: 0 for z in ZONES}
        for s in out:
            zones[zone_info[s["chain"]][0]] += 1
        return out, zones

    available = {str(r): len(pick(r)) for r in range(1, 6)}
    h_sugg, h_zones = pick_hybrid()
    available["hybrid"] = len(h_sugg)
    available["zones"] = h_zones
    return {"part": prep.part, "fps": prep.fps, "chains": out_chains,
            "suggestions": h_sugg if hybrid else pick(float(per_min)), "available": available}


# ------------------------------------------------------------------------------------------------ fill

@dataclass
class FillResult:
    names: list[str]                       # índice de jugadora -> id
    owner: dict[int, int]                  # cadena -> índice de jugadora
    fill: Fill
    ignored: list[dict]
    out: dict


def resolve_anchor(prep: Prepared, index: dict[tuple[int, int], int], by_track: dict[int, list[tuple[int, int]]],
                   frame: int, track: int) -> int | None:
    cid = index.get((frame, track))
    if cid is not None:
        return cid
    near = [(abs(f - frame), c) for f, c in by_track.get(track, []) if abs(f - frame) <= MAX_ANCHOR_SNAP]
    return min(near)[1] if near else None


def _overlap_boxes(a: Chain, b: Chain, player: str, fps: float) -> list[dict]:
    """Una caja de cada cadena que se solapa: en un cuadro donde ambas existen (el del medio del solape) o, si no coinciden
    cuadros exactos, el final de a y el inicio de b."""
    fa, fb = {x.frame: x for x in a.tl.boxes}, {x.frame: x for x in b.tl.boxes}
    common = sorted(set(fa) & set(fb))
    if common:
        f = common[len(common) // 2]
        ba, bb = fa[f], fb[f]
    else:
        ba, bb = a.tl.boxes[-1], b.tl.boxes[0]
    return [box_entry(ba.frame, ba.track, player, "a", fps), box_entry(bb.frame, bb.track, player, "b", fps)]


def _union_boxes(prep: "Prepared", c: Chain, seq: list[Chain], player: str, owner: dict[int, int]) -> list[dict]:
    """Final de la cadena anterior de la jugadora (a), inicio de la cadena dudosa (b) e inicio de otras candidatas que
    empiezan cerca y a las que la anterior también podría llegar (candidata), de menor a mayor costo."""
    fps = prep.fps
    prev = None
    for k, s in enumerate(seq):
        if s.id == c.id:
            prev = seq[k - 1] if k > 0 else None
    out = []
    if prev is not None:
        lb = prev.tl.boxes[-1]
        out.append(box_entry(lb.frame, lb.track, player, "a", fps))
    fb = c.tl.boxes[0]
    out.append(box_entry(fb.frame, fb.track, player, "b", fps))
    alts = []
    for o in prep.chains:
        if o.id == c.id or o.id not in prep.allowed or (prev is not None and o.id == prev.id):
            continue
        if o.team != c.team and "unk" not in (o.team, c.team):
            continue
        if abs(o.start - c.start) / fps > CANDIDATE_WINDOW_S:
            continue
        cost = transition_cost(prev, o, fps, prep.link_p) if prev is not None else abs(o.start - c.start) / fps
        if np.isfinite(cost):
            alts.append((cost, o))
    for _, o in sorted(alts, key=lambda x: x[0])[:MAX_CANDIDATES]:
        ob = o.tl.boxes[0]
        out.append(box_entry(ob.frame, ob.track, None, "candidata", fps))
    return out


def _ranges(seq: list[Chain], fps: float) -> list[list[float]]:
    return [[round(c.start / fps, 3), round(c.end / fps, 3)] for c in seq]


def _stride(prep: Prepared) -> int:
    if prep.stride:
        return max(1, prep.stride)
    return max(1, int(np.median(np.diff(sorted(prep.rows))))) if len(prep.rows) > 1 else 1


def exp_passes(prep: Prepared, identities: list[dict], names: list[str], owner: dict[int, int], anchor_of: dict[int, int],
               weights=None, progress: "Progress | None" = None) -> tuple[list[dict], list[dict], dict, dict[str, list]]:
    """Pasadas 1b-4 de la variante B sobre las identidades (tracks completos, como las aplica la app). Devuelve
    (drops, dudas, conteos por pasada, tramos interpolados por jugadora).

    1b. Exclusión en la mesa: en un cuadro en que la jugadora tiene la caja de una cadena suya, las cajas de sus tracks que
        pertenecen a otra cadena (que no es suya: perdió en la asignación) se descartan (`exclusion`).
    2.  Dobles cajas residuales (doubles.resolve, pesos por defecto, margen ROUTE_MARGIN): `ruta` / `ambas` / dos_sitios.
    3.  Saltos imposibles: picos y excursiones <= 0.8 s se descartan (`salto`); los demás, tarea `salto`. Arranques y
        frenadas imposibles se cuentan (informativo).
    4.  Huecos <= 4 s posibles: interpolados; imposibles: tarea `salto`; > 4 s: `hueco_largo` (informativo)."""
    from sportsan.tracking import doubles as D

    pg = progress or Progress(None)
    fps, stride = prep.fps, _stride(prep)
    tracks_of = D.player_tracks(identities)
    anchored: dict[str, set] = {}
    own: dict[str, set] = {}
    chain_s: dict[tuple[int, int], float] = {}
    for c in prep.chains:
        keys = [(b.frame, b.track) for b in c.tl.boxes]
        for k in keys:
            chain_s[k] = (c.end - c.start) / fps
        if c.id in owner:
            own.setdefault(names[owner[c.id]], set()).update(keys)
            if anchor_of.get(c.id) == owner[c.id]:
                anchored.setdefault(names[owner[c.id]], set()).update(keys)
    drops: list[dict] = []
    dropped: set[tuple[int, int]] = set()

    def drop(f: int, t: int, player: str, reason: str) -> None:
        if (f, t) not in dropped:
            dropped.add((f, t))
            drops.append(dict(frame=int(f), track=int(t), player=player, reason=reason))

    # 1b. exclusión
    before = 0
    for p, tracks in tracks_of.items():
        mine = own.get(p, set())
        for f, r in prep.rows.items():
            bs = [b for b in r if b.track in tracks]
            if len(bs) < 2:
                continue
            before += 1
            if any((f, b.track) in mine for b in bs):
                for b in bs:
                    if (f, b.track) not in mine:
                        drop(f, b.track, p, "exclusion")
    n_excl = len(drops)
    pg.log("dobles", 0, 1)
    # 2. dobles cajas que quedan (dos cadenas suyas solapadas, o tracks suyos fuera de toda cadena suya)
    rows2 = {f: [b for b in r if (f, b.track) not in dropped] for f, r in prep.rows.items()}
    dr = D.resolve(rows2, tracks_of, fps, stride, anchored, own, chain_s, prep.conf, weights)
    for d in dr.drops:
        drop(d["frame"], d["track"], d["player"], d["reason"])
    doubts = list(dr.doubts)
    pg.log("dobles", 1, 1)
    # 3 y 4. saltos y huecos sobre la ruta de cada jugadora
    jumps_before = jumps_after = accel = n_salto = 0
    interp: dict[str, list] = {}
    holes = {"interpolated": 0, "interpolated_s": 0.0, "impossible": 0, "long": 0}
    for k, (p, tracks) in enumerate(tracks_of.items()):
        pg.log("saltos", k, len(tracks_of))
        path = D.route(prep.rows, tracks, dropped, prep.conf)
        jumps_before += sum(D._is_jump(a, b, fps) for a, b in zip(path, path[1:]))
        out, left, clean = D.jump_pass(path, fps, stride)
        for q in out:
            drop(q[0], q[3], p, "salto")
            n_salto += 1
        jumps_after += len(left)
        accel += D.accel_violations(clean, fps)
        for a, b in left:
            d = float(np.hypot(b[1] - a[1], b[2] - a[2]))
            dt = (b[0] - a[0]) / fps
            doubts.append(dict(kind="salto", frame=int(b[0]), track=int(b[3]), players=[p],
                               boxes=[box_entry(a[0], a[3], p, "antes", fps), box_entry(b[0], b[3], p, "despues", fps)],
                               jump=jump_info(a, b, fps),
                               note=f"salto de {d:.1f} m en {dt:.1f} s de {p}: no es físicamente posible"))
        fill, impossible, long_ = D.holes_pass(clean, fps, stride)
        interp[p] = [list(x) for x in fill]
        holes["interpolated"] += len(fill)
        holes["interpolated_s"] += sum(b - a for a, b in fill)
        holes["impossible"] += len(impossible)
        holes["long"] += len(long_)
        for a, b in impossible:
            d = float(np.hypot(b[1] - a[1], b[2] - a[2]))
            doubts.append(dict(kind="salto", frame=int(b[0]), track=int(b[3]), players=[p],
                               boxes=[box_entry(a[0], a[3], p, "antes", fps), box_entry(b[0], b[3], p, "despues", fps)],
                               jump=jump_info(a, b, fps),
                               note=f"{p} reaparece a {d:.1f} m tras {(b[0] - a[0]) / fps:.1f} s: no es físicamente posible"))
        for a, b in long_:
            doubts.append(dict(kind="hueco_largo", frame=int(a[0]), track=int(a[3]), players=[p],
                               boxes=[box_entry(a[0], a[3], p, "antes", fps), box_entry(b[0], b[3], p, "despues", fps)],
                               t0=round(a[0] / fps, 3), t1=round(b[0] / fps, 3),
                               note=f"{p} sin verse {(b[0] - a[0]) / fps:.0f} s"))
    pg.log("saltos", len(tracks_of), len(tracks_of))
    holes["interpolated_s"] = round(holes["interpolated_s"], 2)
    left_dbl = sum(sum(b.track in tr and (f, b.track) not in dropped for b in r) > 1
                   for tr in tracks_of.values() for f, r in prep.rows.items())
    passes = {"exclusion": {"dropped": n_excl},
              "doubles": {"frames_before": before, "frames_after": int(left_dbl), "dropped": dict(dr.by_reason),
                          "undecided": len(dr.doubts)},
              "jumps": {"before": int(jumps_before), "dropped": n_salto, "tasks": int(jumps_after), "accel_impossible": int(accel)},
              "holes": holes}
    drops.sort(key=lambda d: (d["frame"], d["track"]))
    return drops, doubts, passes, interp


def fill_part(prep: Prepared, anchors: list[dict], unnamed_cost: float = UNNAMED_COST_REAL, doubles: bool = False,
              weights=None, variant: str = "", progress: "Progress | None" = None) -> FillResult:
    """`variant=""`: versión A (la de siempre). `variant="exp"`: variante B, relleno con exclusión (una jugadora no recibe
    dos cadenas solapadas) y después `exp_passes`; ignora `doubles`."""
    from sportsan.tracking.coverage import at_edge, bridge_possible

    exp = variant == "exp"
    if exp:
        doubles = False
    fps = prep.fps
    by_id = {c.id: c for c in prep.chains}
    index = {(b.frame, b.track): c.id for c in prep.chains for b in c.tl.boxes}
    by_track: dict[int, list[tuple[int, int]]] = {}
    for (f, t), cid in index.items():
        by_track.setdefault(t, []).append((f, cid))
    names: list[str] = []
    ignored: list[dict] = []
    anchor_of: dict[int, int] = {}
    for a in anchors:
        player = str(a["player"])
        cid = resolve_anchor(prep, index, by_track, int(a["frame"]), int(a["track"]))
        if cid is None:
            ignored.append({**a, "reason": "la caja no está en ninguna cadena de la parte"})
            continue
        if player == NOT_PLAYER:      # «no es jugadora»: se resuelve aparte (not_player_chains)
            continue
        if player not in names:
            names.append(player)
        p = names.index(player)
        if anchor_of.setdefault(cid, p) != p:
            ignored.append({**a, "reason": "la cadena ya tiene otra jugadora"})
    team_of_person: dict[int, str] = {}
    for cid, p in anchor_of.items():
        team_of_person.setdefault(p, by_id[cid].team)
    no_chains = not_player_chains(prep, anchors)
    for a in anchors:             # una cadena con jugadora y con «no es jugadora» a la vez: manda la jugadora
        if str(a["player"]) == NOT_PLAYER:
            cid = resolve_anchor(prep, index, by_track, int(a["frame"]), int(a["track"]))
            if cid is not None and cid in anchor_of:
                ignored.append({**a, "reason": "la cadena ya tiene una jugadora"})
    own_ok = {c.id for c in prep.chains if c.id in prep.allowed and c.team in ("own", "unk") and c.id not in no_chains}
    f = fill_both(prep.chains, anchor_of, fps, prep.link_p, team_of_person, own_ok, unnamed_cost, exclusive=exp)
    owner = f.owner

    owner = dict(owner)
    auto_resolved: list[dict] = []

    def build_seqs() -> dict[int, list[Chain]]:
        out_: dict[int, list[Chain]] = {}
        for cid_, p_ in owner.items():
            out_.setdefault(p_, []).append(by_id[cid_])
        for s_ in out_.values():
            s_.sort(key=lambda c: c.start)
        return out_

    seqs = build_seqs()
    # dos_sitios que se resuelven solos: una sola de las dos cadenas tiene ancla de esa jugadora, o ninguna y una dura >= 2x la otra
    changed = True
    while changed:
        changed = False
        for p, seq in seqs.items():
            for a, b in zip(seq, seq[1:]):
                if (b.start - a.end) / fps > 0:
                    continue
                anchored = [c for c in (a, b) if anchor_of.get(c.id) == p]
                da, db = a.end - a.start, b.end - b.start
                if len(anchored) == 1:
                    win, lose = anchored[0], (b if anchored[0] is a else a)
                    reason = f"solo la cadena {win.id} tiene ancla de {names[p]}"
                elif not anchored and max(da, db) >= DOS_SITIOS_RATIO * max(min(da, db), 1e-9):
                    win, lose = (a, b) if da >= db else (b, a)
                    reason = f"ninguna tiene ancla; la cadena {win.id} dura al menos {DOS_SITIOS_RATIO:g}x la {lose.id}"
                else:
                    continue
                del owner[lose.id]
                auto_resolved.append(dict(kind="dos_sitios", frame=int(lose.start), track=int(lose.tl.boxes[0].track),
                                          players=[names[p]], task=False,
                                          note=f"{names[p]} en dos cadenas a la vez: se separó la cadena {lose.id}", reason=reason))
                changed = True
                break
            if changed:
                break
        if changed:
            seqs = build_seqs()

    doubts: list[tuple[int, float, dict]] = []     # (prioridad, desempate, duda)
    interp_ranges: dict[int, list[list[float]]] = {p: [] for p in seqs}
    interp_s = 0.0
    for p, seq in seqs.items():
        for a, b in zip(seq, seq[1:]):
            if exp:          # en B los huecos, saltos y solapes los miden las pasadas sobre la ruta (exp_passes)
                break
            dt = (b.start - a.end) / fps
            tb = b.tl.boxes[0]
            if dt <= 0:
                if doubles:      # las cajas dobles las resuelve la segunda pasada (doubles.py)
                    continue
                doubts.append((1, 0.0, dict(kind="dos_sitios", frame=int(b.start), track=int(tb.track), players=[names[p]],
                                            boxes=_overlap_boxes(a, b, names[p], fps),
                                            note=f"{names[p]} aparece en dos cadenas a la vez (se solapan {-dt:.1f} s)")))
                continue
            e, s = _finite_end(a.tl, True), _finite_end(b.tl, False)
            if e is None or s is None:
                continue
            d = float(np.hypot(s.xm - e.xm, s.ym - e.ym))
            reach = TEAM_S0_MS * dt + LINK_SLACK_M
            if dt <= BRIDGE_S and bridge_possible(a, b, fps, BRIDGE_S):
                interp_s += dt
                interp_ranges[p].append([round(a.end / fps, 3), round(b.start / fps, 3)])
            elif dt <= BRIDGE_S or d > reach:
                doubts.append((0, d / max(dt, 1e-3), dict(kind="salto", frame=int(b.start), track=int(tb.track), players=[names[p]],
                                                          boxes=[box_entry(e.frame, e.track, names[p], "antes", fps),
                                                                 box_entry(s.frame, s.track, names[p], "despues", fps)],
                                                          jump=jump_info((e.frame, e.xm, e.ym), (s.frame, s.xm, s.ym), fps),
                                                          note=f"salto de {d:.1f} m en {dt:.1f} s hacia {names[p]}: no es físicamente posible")))
            else:
                last = a.tl.boxes[-1]
                edge = at_edge(last, *prep.image_wh) or at_edge(tb, *prep.image_wh)
                if not edge:
                    doubts.append((3, dt, dict(kind="hueco_largo", frame=int(a.end), track=int(last.track), players=[names[p]],
                                               boxes=[box_entry(last.frame, last.track, names[p], "antes", fps),
                                                      box_entry(tb.frame, tb.track, names[p], "despues", fps)],
                                               t0=round(a.end / fps, 3), t1=round(b.start / fps, 3),
                                               note=f"{names[p]} sin verse {dt:.0f} s sin salir de cuadro ({d:.0f} m entre los extremos)")))
    for cid, cost in f.cost.items():
        if cid not in owner:
            continue
        if cost > DOUBT_COST or cid in f.close:
            c = by_id[cid]
            why = f"asignación cara (costo {cost:.1f})" if cost > DOUBT_COST else "otra jugadora queda casi empatada"
            pn = names[owner[cid]]
            doubts.append((2, cost, dict(kind="union_dudosa", frame=int(c.start), track=int(c.tl.boxes[0].track),
                                         players=[pn], boxes=_union_boxes(prep, c, seqs.get(owner[cid], []), pn, owner),
                                         note=f"{why}: cadena {cid} de {names[owner[cid]]}")))
    for c in prep.chains:
        if c.id in owner or c.id not in prep.allowed or c.team != "own" or (c.end - c.start) / fps < ANCHOR_MIN_S:
            continue
        if c.id in no_chains:
            continue
        dur = (c.end - c.start) / fps
        fb = c.tl.boxes[0]
        doubts.append((4, dur, dict(kind="sin_nombre", frame=int(c.start), track=int(c.tl.boxes[0].track), players=[],
                                    boxes=[box_entry(fb.frame, fb.track, None, "a", fps)],
                                    t0=round(c.start / fps, 3), t1=round(c.end / fps, 3),
                                    note=f"cadena propia de {dur:.0f} s sin jugadora (cadena {c.id})")))
    identities = []
    per_player = {}
    for p, seq in sorted(seqs.items()):
        tracks = sorted({b.track for c in seq for b in c.tl.boxes})
        identities.append({"player": names[p], "chains": [c.id for c in seq], "tracks": tracks,
                           "t_ranges": _ranges(seq, fps), "interpolated": interp_ranges[p]})
        per_player[names[p]] = round(sum((c.end - c.start) / fps for c in seq), 2)
    drops: list[dict] = []
    doubles_summary: dict = {}
    passes: dict = {}
    if exp:
        drops, exp_doubts, passes, interp = exp_passes(prep, identities, names, owner, anchor_of, weights, progress)
        for idt in identities:
            idt["interpolated"] = interp.get(idt["player"], [])
        interp_s = passes["holes"]["interpolated_s"]
        prio = {"salto": 0, "dos_sitios": 1, "hueco_largo": 3}
        for d in exp_doubts:
            doubts.append((prio.get(d["kind"], 2), 0.0, d))
    if doubles:
        from sportsan.tracking.doubles import player_tracks, resolve

        anchored: dict[str, set] = {}
        own: dict[str, set] = {}
        chain_s: dict[tuple[int, int], float] = {}
        for c in prep.chains:
            dur = (c.end - c.start) / fps
            keys = [(b.frame, b.track) for b in c.tl.boxes]
            for k in keys:
                chain_s[k] = dur
            if c.id in owner:
                own.setdefault(names[owner[c.id]], set()).update(keys)
            if c.id in anchor_of and owner.get(c.id) == anchor_of[c.id]:
                anchored.setdefault(names[anchor_of[c.id]], set()).update(keys)
        stride = prep.stride or int(np.median(np.diff(sorted(prep.rows)))) if len(prep.rows) > 1 else 1
        dr = resolve(prep.rows, player_tracks(identities), fps, max(1, stride), anchored, own, chain_s, prep.conf, weights)
        drops = dr.drops
        for d in dr.doubts:
            doubts.append((1, 0.0, d))
        doubles_summary = {"frames_before": dr.frames_before, "frames_after": dr.frames_after, "dropped": dr.by_reason,
                           "undecided": len(dr.doubts)}
    doubts.sort(key=lambda x: (x[0], -x[1]))
    all_doubts = [{**d, "task": d["kind"] in TASK_KINDS} for _, _, d in doubts]
    for d in all_doubts:
        for bx in d.get("boxes", []):
            bx["chain"] = index.get((bx["frame"], bx["track"]))
        if d["kind"] in RESOLUTION:
            d["resolution"] = {"options": list(RESOLUTION[d["kind"]][0]), "default": RESOLUTION[d["kind"]][1]}
    not_player = [{"chain": cid, "frame": int(by_id[cid].tl.boxes[0].frame), "track": int(by_id[cid].tl.boxes[0].track),
                   "t0": round(by_id[cid].start / fps, 3), "t1": round(by_id[cid].end / fps, 3)} for cid in sorted(no_chains)]
    by_kind: dict[str, int] = {}
    info: dict[str, int] = {"hueco_largo": 0, "sin_nombre": 0, "no_jugadora": len(not_player)}
    for d in all_doubts:
        if d["task"]:
            by_kind[d["kind"]] = by_kind.get(d["kind"], 0) + 1
        else:
            info[d["kind"]] = info.get(d["kind"], 0) + 1
    summary = {"tasks": sum(by_kind.values()), "by_kind": by_kind, "info": info,
               "auto_resolved": {"dos_sitios": len(auto_resolved)}}
    if doubles:
        summary["doubles"] = doubles_summary
    out = {"part": prep.part, "identities": identities, "doubts": all_doubts, "doubt_summary": summary,
           "auto_resolved": auto_resolved, "not_player": not_player, "drops": drops,
           "coverage": {"per_player": per_player, "interpolated_s": round(interp_s, 2)}, "ignored_anchors": ignored}
    if exp:
        summary["auto_resolved"]["drops"] = {r: sum(d["reason"] == r for d in drops) for r in ("exclusion", "ruta", "ambas", "salto")}
        out["variant"] = "exp"
        out["passes"] = {"exclusion": {"blocked": f.excluded, **passes["exclusion"]},
                         **{k: v for k, v in passes.items() if k != "exclusion"}}
    return FillResult(names, owner, f, ignored, out)


# ------------------------------------------------------------------------------------------------ CLI

def _paths(match: str | None, part: str, task: str, variant: str = ""):
    from sportsan.config import load_config, project_root

    cfg = load_config(match=match)
    dir_ = project_root() / cfg["paths"]["tracking_dir"]
    return dir_, dir_ / "auto", Progress(dir_ / "revision" / f"progreso_{task}_{part}{'_' + variant if variant else ''}.log")


def _write(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


def cli(argv: list[str]) -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(prog="python -m sportsan.tracking.anchors", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["suggest", "fill"])
    ap.add_argument("--match")
    ap.add_argument("--part", required=True, help="nombre de la parte, p. ej. v1_41994_43460")
    ap.add_argument("--per-min", default="2", help="suggest: ventanas por minuto (cada una pide anclas a varias jugadoras) o «hybrid» "
                    "(cuota por franja de la cancha respecto a la cámara)")
    ap.add_argument("--near", type=float, default=HYBRID_RATES["near"], help="hybrid: anclas/min en la banda cercana a la cámara")
    ap.add_argument("--center", type=float, default=HYBRID_RATES["center"], help="hybrid: anclas/min en el centro")
    ap.add_argument("--far", type=float, default=HYBRID_RATES["far"], help="hybrid: anclas/min en la banda lejana")
    ap.add_argument("--zones", choices=["thirds", "quantiles"], default="thirds", help="hybrid: cortes de franja (tercios del ancho o terciles de las cadenas)")
    ap.add_argument("--unnamed-cost", type=float, default=UNNAMED_COST_REAL, help="fill: costo de dejar una cadena sin nombre")
    ap.add_argument("--out", help="fill: escribir el resultado en este archivo (relativo a tracking/auto/ si no es absoluta) en vez de links_<parte>.json")
    ap.add_argument("--no-feet", action="store_true")
    ap.add_argument("--doubles", action="store_true", help="fill: resolver las dobles cajas con «drops» (apagado por defecto: aún no es seguro, ver revision/dobles_cajas.md)")
    ap.add_argument("--variant", choices=["exp"], help="fill: variante B (experimento): exclusión en la asignación, dobles cajas, "
                    "saltos y huecos; escribe links_<parte>_exp.json y nunca pisa links_<parte>.json")
    args = ap.parse_args(argv)
    if args.variant and args.command != "fill":
        raise SystemExit("--variant solo vale con fill")
    if args.variant and args.doubles:
        raise SystemExit("--variant exp ya resuelve las dobles cajas: no se combina con --doubles")
    if args.per_min != "hybrid":
        try:
            args.per_min = float(args.per_min)
        except ValueError:
            raise SystemExit("--per-min debe ser un número entre 1 y 5 o «hybrid»")
        if not 1 <= args.per_min <= 5:
            raise SystemExit("--per-min debe estar entre 1 y 5")
    elif not all(0.5 <= r <= 6 for r in (args.near, args.center, args.far)):
        raise SystemExit("--near/--center/--far deben estar entre 0.5 y 6")
    dir_, auto, pg = _paths(args.match, args.part, args.command, args.variant or "")
    prep = prepare(dir_, args.part, Models.load(dir_), pg, feet=not args.no_feet)
    if args.command == "suggest":
        covered = set()
        af = auto / f"anchors_{args.part}.json"
        if af.exists():       # lo que ya está nombrado no se vuelve a sugerir
            index = {(b.frame, b.track): c.id for c in prep.chains for b in c.tl.boxes}
            saved = json.loads(af.read_text(encoding="utf-8")).get("anchors", [])
            covered = {index[(int(a["frame"]), int(a["track"]))] for a in saved if (int(a["frame"]), int(a["track"])) in index}
            covered |= not_player_chains(prep, saved)     # «no es jugadora»: ni ella ni las que comparten su track
        res = suggest(prep, args.per_min, covered, {"near": args.near, "center": args.center, "far": args.far}, args.zones)
        _write(auto / f"suggest_{args.part}.json", res)
        print(f"{len(res['chains'])} cadenas, {len(res['suggestions'])} sugerencias -> {auto / f'suggest_{args.part}.json'}")
    else:
        af = auto / f"anchors_{args.part}.json"
        if not af.exists():
            raise SystemExit(f"Falta {af} (lo escribe la app)")
        pg.log("relleno", 0, 1)
        r = fill_part(prep, json.loads(af.read_text(encoding="utf-8")).get("anchors", []), args.unnamed_cost, args.doubles,
                      variant=args.variant or "", progress=pg)
        pg.log("relleno", 1, 1)
        dest = auto / (f"links_{args.part}_exp.json" if args.variant else f"links_{args.part}.json")
        if args.out:
            dest = Path(args.out)
            if not dest.is_absolute():
                dest = auto / dest
        if args.variant and dest.name == f"links_{args.part}.json":
            raise SystemExit("La variante B no puede escribir links_<parte>.json (es el de la versión A)")
        _write(dest, r.out)
        sm = r.out["doubt_summary"]
        print(f"{len(r.out['identities'])} identidades, tareas {sm['tasks']} {sm['by_kind']}, autoresueltas {sm['auto_resolved']}, "
              f"dobles cajas {sm.get('doubles', {})}, pasadas {r.out.get('passes', {})}, informativas {sm['info']}, ignoradas {len(r.ignored)} -> {dest}")


if __name__ == "__main__":
    cli(sys.argv[1:])

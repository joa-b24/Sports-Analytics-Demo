"""Unión de fragmentos de track sobre la cancha.

El seguidor trabaja en la imagen y pierde la identidad cuando una jugadora se tapa, sale del encuadre o la cámara
panea rápido: la misma persona acaba repartida en varios tracks. Con las posiciones ya en metros se pueden volver a
unir con un criterio físico: un track que termina y otro que empieza poco después, cerca de donde la primera podía
haber llegado, con camiseta del mismo color y del mismo equipo, son la misma persona.

Dos casos:

- **Se pierde a la vista** (se tapa, el seguidor falla): el hueco es corto y reaparece cerca. Hasta 3 s.
- **Sale del encuadre**: la cámara deja de verla. Se toma la dirección y la velocidad que llevaba y se estima dónde
  estará al volver; se empareja con quien entra al encuadre cerca de ese punto, no con quien esté más cerca de
  donde se la vio por última vez. Hasta 10 s, con un margen que crece con el tiempo fuera.

Es una propuesta, no una verdad: cada unión se puede deshacer en la mesa de corrección. Por eso es conservadora:
ante la duda no une.

Funciones puras (numpy): no leen archivos.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

# Tiempo máximo (s) entre el final de un fragmento y el inicio del siguiente, a la vista y fuera del encuadre.
MAX_GAP_S = 3.0
MAX_OFFSCREEN_S = 10.0
# Velocidad máxima razonable de una jugadora (m/s) y holgura por ruido de la calibración (m).
MAX_SPEED_MS = 8.0
SLACK_M = 2.0
# Fuera del encuadre nadie mantiene su carrera mucho tiempo: la velocidad se apaga con esta constante (s) y el
# margen alrededor del punto estimado crece a este ritmo (m/s), hasta un tope (m).
DAMPING_S = 2.5
OFFSCREEN_GROWTH_MS = 2.5
OFFSCREEN_MAX_M = 18.0
# Diferencia máxima de color de camiseta. La luminosidad pesa la mitad: la sombra la cambia mucho y el tono poco.
MAX_COLOR = 30.0
# Reaparición inmediata: hasta este tiempo (s) y esta distancia (m) no se exige que el color coincida con MAX_COLOR...
IMMEDIATE_S = 0.45
IMMEDIATE_M = 1.5
# ...pero sí que no sea de otro uniforme: con la luminosidad completa, azul y negro quedan a ~70 y las cajas de una
# misma persona a mucho menos. Sin este veto, una jugadora que sale de cuadro y otra del otro equipo que entra justo
# ahí se unían.
IMMEDIATE_MAX_COLOR = 50.0
# Ventana (s) para medir la velocidad con la que termina un fragmento.
VELOCITY_WINDOW_S = 1.0
# Un fragmento más corto que esto (s) no se une a nada: es demasiado poco para saber hacia dónde iba ni de qué color
# es, y servía de pegamento entre dos personas distintas. Se queda como está (la mesa lo ofrece para descartar).
MIN_LINK_S = 1.0


def color_distance(a, b, l_weight: float = 0.5) -> float:
    """Distancia entre dos camisetas en Lab. La luminosidad pesa `l_weight`: la mitad para comparar cajas de una misma
    persona (la sombra la cambia mucho); completa para decidir equipo (team.py), donde separa uniformes oscuros."""
    d = np.asarray(a, dtype=float) - np.asarray(b, dtype=float)
    return float(np.sqrt((l_weight * d[0]) ** 2 + d[1] ** 2 + d[2] ** 2))


@dataclass
class Fragment:
    track_id: int
    start: int                  # primer cuadro (número de cuadro del video)
    end: int                    # último cuadro
    start_xy: np.ndarray        # posición al empezar, en metros reales de la sede
    end_xy: np.ndarray          # posición al terminar
    velocity: np.ndarray        # m/s al terminar (0 si no se puede estimar)
    lab: np.ndarray             # color mediano de la camiseta
    team: str | None = None     # equipo por color, si se conoce; dos equipos distintos nunca se unen
    exits: bool = False         # termina pegado al borde de la imagen: salió del encuadre
    enters: bool = False        # empieza pegado al borde: entró al encuadre


def end_velocity(obs: list[tuple[int, np.ndarray]], fps: float) -> np.ndarray:
    """Velocidad (m/s) con la que termina un fragmento: recta ajustada a su último segundo."""
    last = obs[-1][0]
    recent = [(f, xy) for f, xy in obs if (last - f) / fps <= VELOCITY_WINDOW_S]
    if len(recent) < 3:
        return np.zeros(2)
    t = np.array([(f - last) / fps for f, _ in recent])
    if np.ptp(t) < 0.2:
        return np.zeros(2)
    xy = np.array([p for _, p in recent])
    v = np.array([np.polyfit(t, xy[:, 0], 1)[0], np.polyfit(t, xy[:, 1], 1)[0]])
    speed = float(np.linalg.norm(v))
    return v * (MAX_SPEED_MS / speed) if speed > MAX_SPEED_MS else v  # un salto de la calibración no es una carrera


def fragments_from_boxes(frames: list[int], boxes: list[list[dict]], fps: float) -> list[Fragment]:
    """Resume cada track. boxes[i] = lista de {"track_id", "xy" (o None), "lab", "team"?, "edge"?} del cuadro frames[i].

    `edge`: la caja toca el borde de la imagen. Solo entran los tracks con alguna posición conocida: sin posición
    no hay criterio para unirlos.
    """
    seen: dict[int, list[dict]] = {}
    for f, row in zip(frames, boxes):
        for b in row:
            seen.setdefault(b["track_id"], []).append({**b, "frame": f})
    out: list[Fragment] = []
    for tid, obs in seen.items():
        known = [(o["frame"], np.asarray(o["xy"], dtype=float)) for o in obs if o["xy"] is not None and np.isfinite(np.asarray(o["xy"], dtype=float)).all()]
        if not known:
            continue
        teams = [o.get("team") for o in obs if o.get("team") not in (None, "unk")]
        team = max(set(teams), key=teams.count) if teams else None
        out.append(Fragment(
            tid, obs[0]["frame"], obs[-1]["frame"],
            np.median([xy for _, xy in known[:3]], axis=0), np.median([xy for _, xy in known[-3:]], axis=0),
            end_velocity(known, fps), np.median(np.array([o["lab"] for o in obs], dtype=float), axis=0),
            team, bool(obs[-1].get("edge")), bool(obs[0].get("edge")),
        ))
    return out


# Una detección suelta se asigna a un track que no tiene caja en ese cuadro si cae a menos de esto (m) de donde el
# track estaría (interpolando entre lo anterior y lo siguiente), mirando como mucho este tiempo (s) a cada lado.
ABSORB_M = 2.0
ABSORB_WINDOW_S = 1.5


# Una detección suelta a menos de esto (m) de un track en el mismo cuadro es la misma persona vista dos veces.
DUPLICATE_M = 1.2


def duplicate_loose(row: list[dict], is_loose) -> set[int]:
    """Detecciones sueltas de un cuadro que caen encima de alguien que el seguidor ya lleva. Devuelve sus track_id.

    El detector a veces da dos cajas para una persona (el cuerpo entero y medio cuerpo, por ejemplo) y el seguidor
    solo usa una; la otra quedaría como una "persona" de un cuadro pegada a la primera. Entre dos sueltas no se
    decide nada: ninguna de las dos es más fiable que la otra.
    """
    tracked = [np.asarray(b["xy"], dtype=float) for b in row if not is_loose(b["track_id"]) and b["xy"] is not None]
    out: set[int] = set()
    if not tracked:
        return out
    for b in row:
        if not is_loose(b["track_id"]) or b["xy"] is None:
            continue
        xy = np.asarray(b["xy"], dtype=float)
        if min(float(np.linalg.norm(xy - t)) for t in tracked) < DUPLICATE_M:
            out.add(b["track_id"])
    return out


def absorb_loose(frames: list[int], boxes: list[list[dict]], is_loose, fps: float) -> dict[int, int]:
    """Rellena los huecos de un track con las detecciones sueltas que le corresponden.

    El seguidor a veces deja de devolver a una jugadora durante unos cuadros aunque el detector la sigue viendo:
    el track tiene un hueco y en esos cuadros hay una detección suelta justo donde ella estaría. Devuelve
    track_id suelto -> track_id del track al que pertenece. Las que no encajan en ningún hueco no aparecen.
    """
    series: dict[int, list[tuple[int, np.ndarray, np.ndarray]]] = {}
    loose: list[tuple[int, int, np.ndarray, np.ndarray, str | None]] = []
    for f, row in zip(frames, boxes):
        for b in row:
            if b["xy"] is None:
                continue
            xy = np.asarray(b["xy"], dtype=float)
            if not np.isfinite(xy).all():
                continue
            if is_loose(b["track_id"]):
                loose.append((f, b["track_id"], xy, np.asarray(b["lab"], dtype=float), b.get("team")))
            else:
                series.setdefault(b["track_id"], []).append((f, xy, np.asarray(b["lab"], dtype=float)))
    track_team: dict[int, str | None] = {}
    for row in boxes:
        for b in row:
            if not is_loose(b["track_id"]) and b.get("team") not in (None, "unk"):
                track_team[b["track_id"]] = b["team"]
    window = ABSORB_WINDOW_S * fps
    options: list[tuple[float, int, int, int]] = []
    for f, lid, xy, lab, team in loose:
        for tid, obs in series.items():
            before = [o for o in obs if 0 < f - o[0] <= window]
            after = [o for o in obs if 0 < o[0] - f <= window]
            if not before or not after or any(o[0] == f for o in obs):
                continue  # solo huecos: el track existe antes y después, y no tiene caja en este cuadro
            if team not in (None, "unk") and track_team.get(tid) and team != track_team[tid]:
                continue
            p0, p1 = before[-1], after[0]
            w = (f - p0[0]) / (p1[0] - p0[0])
            d = float(np.linalg.norm(xy - ((1 - w) * p0[1] + w * p1[1])))
            if d <= ABSORB_M and color_distance(lab, p0[2]) <= MAX_COLOR:
                options.append((d, f, lid, tid))
    out: dict[int, int] = {}
    taken: set[tuple[int, int]] = set()
    for d, f, lid, tid in sorted(options):
        if lid in out or (tid, f) in taken:
            continue
        out[lid] = tid
        taken.add((tid, f))
    return out


def predicted_position(a: Fragment, dt: float) -> np.ndarray:
    """Dónde estaría tras `dt` segundos sin verla: sigue su dirección, frenando poco a poco."""
    return a.end_xy + a.velocity * DAMPING_S * (1 - np.exp(-dt / DAMPING_S))


def link_cost(a: Fragment, b: Fragment, fps: float, immediate_veto: bool = True) -> float | None:
    """Coste de decir que `b` continúa a `a`; None si no es creíble."""
    dt = (b.start - a.end) / fps
    if dt <= 0:
        return None
    if a.team and b.team and a.team != b.team:
        return None
    color = color_distance(a.lab, b.lab)
    reach = float(np.linalg.norm(b.start_xy - a.end_xy))
    # Continuidad inmediata: reaparece casi en el mismo sitio en menos de medio segundo. Ahí manda la posición; el
    # color de una caja pequeña y lejana es demasiado ruidoso para vetar la unión (el equipo, si se conoce, sí veta).
    immediate = dt <= IMMEDIATE_S and reach <= IMMEDIATE_M and (not immediate_veto or color_distance(a.lab, b.lab, l_weight=1.0) <= IMMEDIATE_MAX_COLOR)
    if color > MAX_COLOR and not immediate:
        return None
    if reach > MAX_SPEED_MS * dt + SLACK_M:
        return None
    if immediate:
        return reach + 0.5 * dt

    if dt <= MAX_GAP_S:
        # Dónde estaría si siguiera como iba.
        miss = float(np.linalg.norm(b.start_xy - (a.end_xy + a.velocity * dt)))
        return miss + 0.05 * color + 0.5 * dt
    if dt <= MAX_OFFSCREEN_S and a.exits and b.enters:
        miss = float(np.linalg.norm(b.start_xy - predicted_position(a, dt)))
        if miss > min(OFFSCREEN_MAX_M, SLACK_M + OFFSCREEN_GROWTH_MS * dt):
            return None
        # Algo más caro que una unión a la vista: si hay una explicación más simple, gana esa.
        return miss + 0.05 * color + 0.3 * dt + 1.0
    return None


def stitch(fragments: list[Fragment], fps: float, min_link_s: float = MIN_LINK_S, immediate_veto: bool = True) -> dict[int, int]:
    """Propone qué fragmentos son la misma persona. Devuelve track_id -> identidad (el track_id del primer fragmento).

    Emparejamiento voraz de menor a mayor coste: cada fragmento tiene como mucho una continuación y un antecesor.
    Si dos candidatos que están a la vez en la cancha compiten por el mismo hueco con costes parecidos, no se une
    ninguno: es justo el caso (dos jugadoras que se cruzan) en el que una unión automática se equivoca.
    """
    candidates: list[tuple[float, int, int]] = []
    long_enough = [(f.end - f.start) / fps >= min_link_s for f in fragments]
    for i, a in enumerate(fragments):
        for j, b in enumerate(fragments):
            if i == j or not long_enough[i] or not long_enough[j]:
                continue
            c = link_cost(a, b, fps, immediate_veto)
            if c is not None:
                candidates.append((c, i, j))
    candidates.sort()
    out_of: dict[int, list[tuple[float, int]]] = {}
    into: dict[int, list[tuple[float, int]]] = {}
    for c, i, j in candidates:
        out_of.setdefault(i, []).append((c, j))
        into.setdefault(j, []).append((c, i))
    # Dos fragmentos que coinciden en el tiempo son dos personas distintas; dos que van uno tras otro pueden ser
    # trozos de la misma, así que no compiten entre sí.
    coexist = lambda x, y: fragments[x].start <= fragments[y].end and fragments[y].start <= fragments[x].end

    def ambiguous(options: list[tuple[float, int]], cost: float, chosen: int) -> bool:
        # Hay duda si otra persona distinta encaja casi igual de bien: a menos de medio metro de coste, o de la
        # mitad del coste cuando este ya es grande. Una opción clara (0.1 m frente a 1 m) no se bloquea.
        margin = max(0.5, 0.5 * cost)
        return any(k != chosen and c - cost < margin and coexist(k, chosen) for c, k in options)

    succ: dict[int, int] = {}
    pred: dict[int, int] = {}
    for c, i, j in candidates:
        if i in succ or j in pred:
            continue
        if ambiguous(out_of[i], c, j) or ambiguous(into[j], c, i):
            continue
        succ[i] = j
        pred[j] = i

    identity: dict[int, int] = {}
    for i, frag in enumerate(fragments):
        root = i
        while root in pred:
            root = pred[root]
        identity[frag.track_id] = fragments[root].track_id
    return identity

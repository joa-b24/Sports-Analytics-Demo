"""Aplicar el relleno por tramos (propuesta_union_tracks.md, sección «Tramos por identidad»).

La app antigua aplicaba tracks completos y descartaba los que reclamaban dos jugadoras. Aquí el relleno entrega, por
identidad, solo los tramos que decidió asignar: `segments: [[track_id, frame_ini, frame_fin], ...]` (frames inclusivos, los
de `tracks_<parte>.json`). Funciones puras, sin leer archivos.

Qué entra en un tramo (política `SegmentPolicy`):
- Cadena asignada por el relleno: solo si su costo, la p de la unión que la enlazó con la cadena anterior y (opcional) el
  hecho de que no hubiera candidato de unión pasan los umbrales. Si no, se abstiene (queda sin nombre: la llena la persona).
- Dentro de una cadena, solo los trozos alcanzables desde el trozo que se decidió (el primero; el último si se rellenó hacia
  atrás; el de la caja marcada en un ancla) por uniones con p >= `internal_p`. Un trozo unido por una unión floja se suelta.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class SegmentPolicy:
    max_cost: float | None = None       # costo máximo de la asignación (None: el del relleno, UNNAMED_COST)
    min_entry_p: float | None = None    # p mínima de la unión de entrada si hubo candidato (None: sin umbral)
    prior_ok: bool = True               # aceptar asignaciones sin candidato de unión (costo a priori)
    internal_p: float | None = None     # p mínima de las uniones internas de la cadena (None: toda la cadena)
    reject_close: bool = False          # abstenerse si otra jugadora quedó casi empatada en la asignación (Fill.close)

    def as_dict(self) -> dict:
        return dict(max_cost=self.max_cost, min_entry_p=self.min_entry_p, prior_ok=self.prior_ok, internal_p=self.internal_p,
                    reject_close=self.reject_close)


# Defecto: el punto MÁS PRECISO medido (ningún punto llegó a 98 % contra labels, ver docs/propuesta_union_tracks.md §11).
DEFAULT_POLICY = SegmentPolicy(max_cost=1.0, min_entry_p=0.8, prior_ok=False, internal_p=0.995, reject_close=True)
SUGGEST_P_MIN = 0.8      # trozos libres que se ofrecen (no se asignan): p de la unión y costo
SUGGEST_COST_MAX = 1.0


def chain_members(c) -> tuple:
    """Trozos de la cadena; una cadena sin trozos registrados (hecha a mano) es un solo trozo."""
    return tuple(c.members) if c.members else (c.tl,)


def reachable(n: int, link_ps, seeds, internal_p: float | None) -> list[int]:
    """Índices de trozos (0..n-1) alcanzables desde `seeds` por uniones consecutivas con p >= internal_p. Una unión sin p
    conocida se considera cortada cuando hay umbral."""
    if internal_p is None:
        return list(range(n))
    keep = set(seeds)
    for s in list(seeds):
        k = s
        while k + 1 < n and link_ps[k] is not None and link_ps[k] >= internal_p:
            k += 1
            keep.add(k)
        k = s
        while k - 1 >= 0 and link_ps[k - 1] is not None and link_ps[k - 1] >= internal_p:
            k -= 1
            keep.add(k)
    return sorted(keep)


def accepts(policy: SegmentPolicy, cost: float | None, entry_p: float | None, close: bool = False) -> bool:
    """¿La asignación del relleno (no un ancla) pasa la política? `cost` None: viene de un ancla, siempre pasa."""
    if cost is None:
        return True
    if close and policy.reject_close:
        return False
    if policy.max_cost is not None and cost > policy.max_cost:
        return False
    if entry_p is None:
        return policy.prior_ok
    return policy.min_entry_p is None or entry_p >= policy.min_entry_p


def selected_boxes(c, seeds, internal_p: float | None) -> set[tuple[int, int]]:
    """(cuadro, track) de las cajas de los trozos de la cadena que entran, partiendo de los trozos `seeds`."""
    members = chain_members(c)
    idx = reachable(len(members), c.link_ps if c.members else (), seeds, internal_p)
    return {(b.frame, b.track) for k in idx for b in members[k].boxes}


def to_segments(selected: set[tuple[int, int]], track_frames: dict[int, list[int]]) -> list[list[int]]:
    """Cajas elegidas -> [[track, cuadro_ini, cuadro_fin], ...] inclusivos. Un tramo no cruza un cuadro del mismo track que no
    esté elegido (por ejemplo, el que pertenece a otra jugadora): así dos tramos de identidades distintas nunca se solapan."""
    by_track: dict[int, set[int]] = {}
    for f, t in selected:
        by_track.setdefault(t, set()).add(f)
    out: list[list[int]] = []
    for t in sorted(by_track):
        frames = by_track[t]
        run: list[int] = []
        for f in track_frames.get(t) or sorted(frames):
            if f in frames:
                run.append(f)
            elif run:
                out.append([t, run[0], run[-1]])
                run = []
        if run:
            out.append([t, run[0], run[-1]])
    out.sort(key=lambda s: (s[1], s[0]))
    return out


def segment_boxes(segments, track_frames: dict[int, list[int]]) -> set[tuple[int, int]]:
    """Inverso de to_segments: las cajas (cuadro, track) que cubren los tramos."""
    out = set()
    for t, f0, f1 in segments:
        out.update((f, t) for f in track_frames.get(t, ()) if f0 <= f <= f1)
    return out


def conflicts(identities: list[dict]) -> int:
    """Pares de tramos de identidades distintas que comparten track y cuadros (debe ser 0)."""
    spans: dict[int, list[tuple[int, int, str]]] = {}
    for idt in identities:
        for t, f0, f1 in idt.get("segments", []):
            spans.setdefault(int(t), []).append((int(f0), int(f1), idt["player"]))
    n = 0
    for lst in spans.values():
        lst.sort()
        for (a0, a1, pa), (b0, b1, pb) in zip(lst, lst[1:]):
            if b0 <= a1 and pa != pb:
                n += 1
    return n

"""Equipo de cada persona por el color de su camiseta. Funciones puras (numpy).

Los colores de referencia son los `jersey_colors` de match.yaml (own, opp, ref, own_gk, opp_gk; la portera cuenta para
su equipo). Dos cuidados, porque un equipo mal puesto deja unir a dos jugadoras distintas:

- Para decidir equipo, la luminosidad pesa completa (`TEAM_L_WEIGHT`): dos uniformes oscuros, como azul y negro, se
  distinguen sobre todo por ella. (Para comparar dos cajas de una misma persona, en stitch, pesa la mitad: la sombra
  la cambia mucho.)
- Se decide solo con margen: la mejor referencia debe estar a menos de `MAX_COLOR_DISTANCE` y la mejor de otro
  equipo al menos `TEAM_MARGIN` veces más lejos. Un color a medio camino queda `unk`.

Un track se decide por votación de sus cajas: el equipo con al menos `MIN_SHARE` de los votos y `MIN_VOTES` votos.
"""
from __future__ import annotations

import numpy as np

from .stitch import color_distance

# Claves de `jersey_colors` en match.yaml y el equipo al que pertenece cada una (las porteras visten distinto).
JERSEY_KEYS = {"own": "own", "opp": "opp", "ref": "ref", "own_gk": "own", "opp_gk": "opp"}
MAX_COLOR_DISTANCE = 40.0
TEAM_L_WEIGHT = 1.0
TEAM_MARGIN = 1.3
MIN_VOTES = 5
MIN_SHARE = 0.7


def hex_to_lab(color: str) -> np.ndarray:
    """'#rrggbb' -> Lab en la escala de 8 bits de OpenCV (L 0-255, a y b centrados en 128)."""
    c = color.strip().lstrip("#")
    if len(c) != 6:
        raise ValueError(f"Color inválido: {color!r} (se espera #rrggbb)")
    rgb = np.array([int(c[i:i + 2], 16) for i in (0, 2, 4)], dtype=float) / 255
    lin = np.where(rgb > 0.04045, ((rgb + 0.055) / 1.055) ** 2.4, rgb / 12.92)
    xyz = np.array([[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.0721750], [0.0193339, 0.1191920, 0.9503041]]) @ lin
    f = xyz / np.array([0.95047, 1.0, 1.08883])
    f = np.where(f > 0.008856, np.cbrt(f), 7.787 * f + 16 / 116)
    return np.array([(116 * f[1] - 16) * 255 / 100, 500 * (f[0] - f[1]) + 128, 200 * (f[1] - f[2]) + 128])


def lab_to_hex(lab: np.ndarray) -> str:
    L, a, b = lab[0] * 100 / 255, lab[1] - 128, lab[2] - 128
    fy = (L + 16) / 116
    f = np.array([fy + a / 500, fy, fy - b / 200])
    xyz = np.where(f ** 3 > 0.008856, f ** 3, (f - 16 / 116) / 7.787) * np.array([0.95047, 1.0, 1.08883])
    lin = np.array([[3.2404542, -1.5371385, -0.4985314], [-0.9692660, 1.8760108, 0.0415560], [0.0556434, -0.2040259, 1.0572252]]) @ xyz
    lin = np.clip(lin, 0, 1)
    rgb = np.where(lin > 0.0031308, 1.055 * lin ** (1 / 2.4) - 0.055, 12.92 * lin)
    return "#" + "".join(f"{int(round(v * 255)):02x}" for v in np.clip(rgb, 0, 1))


def classify_team(lab, refs: dict[str, np.ndarray], max_distance: float = MAX_COLOR_DISTANCE, margin: float = TEAM_MARGIN) -> str:
    """Equipo de un color de camiseta, o 'unk' si ninguna referencia está cerca o la decisión no tiene margen."""
    if not refs:
        return "unk"
    dist = sorted((color_distance(lab, v, l_weight=TEAM_L_WEIGHT), JERSEY_KEYS.get(k, "unk")) for k, v in refs.items())
    best, team = dist[0]
    if best > max_distance:
        return "unk"
    other = [d for d, t in dist[1:] if t != team]
    if other and other[0] < margin * best:
        return "unk"
    return team


TEAM_RUN = 10


def team_changes(seq: list[tuple[int, str]], run: int = TEAM_RUN) -> list[int]:
    """Cuadros donde una serie de equipos por caja (cuadro, equipo) pasa de un equipo al otro y se queda: al menos `run`
    cajas decididas de cada lado (las 'unk' no cortan las rachas). Misma regla que cutHints en web/lib/cuts.ts."""
    decided = [(f, t) for f, t in seq if t in ("own", "opp")]
    out: list[int] = []
    run_team, run_start, prev_team, prev_len = None, 0, None, 0
    for i in range(len(decided) + 1):
        t = decided[i][1] if i < len(decided) else None
        if t == run_team:
            continue
        length = i - run_start
        if run_team and length >= run:
            if prev_team and prev_team != run_team and prev_len >= run:
                out.append(decided[run_start][0])
            prev_team, prev_len = run_team, length
        run_team, run_start = t, i
    return out


def vote_teams(rows: list[dict], refs: dict[str, np.ndarray]) -> dict[int, tuple[str, float]]:
    """track_id -> (equipo, fracción de votos a favor). Cada caja con equipo decidido vota; el track toma el equipo
    con al menos MIN_SHARE de los votos y MIN_VOTES votos, si no 'unk' (con la fracción del más votado)."""
    votes: dict[int, dict[str, int]] = {}
    for r in rows:
        v = votes.setdefault(r["track_id"], {})
        team = classify_team(r["lab"], refs)
        if team != "unk":
            v[team] = v.get(team, 0) + 1
    out: dict[int, tuple[str, float]] = {}
    for t, v in votes.items():
        n = sum(v.values())
        if not n:
            out[t] = ("unk", 0.0)
            continue
        team, k = max(v.items(), key=lambda kv: kv[1])
        share = k / n
        out[t] = (team if n >= MIN_VOTES and share >= MIN_SHARE else "unk", round(share, 3))
    return out


def track_teams_legacy(rows: list[dict], refs: dict[str, np.ndarray]) -> dict[int, str]:
    """Regla anterior a la fase 1 (la que usa `process` por defecto mientras no se mida algo mejor): color mediano del
    track, luminosidad a la mitad, la referencia más cercana a menos de MAX_COLOR_DISTANCE, sin margen ni votación."""
    by_track: dict[int, list] = {}
    for r in rows:
        by_track.setdefault(r["track_id"], []).append(r["lab"])
    out: dict[int, str] = {}
    for t, v in by_track.items():
        lab = np.median(np.array(v, dtype=float), axis=0)
        if not refs:
            out[t] = "unk"
            continue
        name, d = min(((k, color_distance(lab, ref)) for k, ref in refs.items()), key=lambda kv: kv[1])
        out[t] = JERSEY_KEYS.get(name, "unk") if d <= MAX_COLOR_DISTANCE else "unk"
    return out


def track_teams(rows: list[dict], refs: dict[str, np.ndarray]) -> dict[int, str]:
    """track_id -> equipo, por votación de sus cajas (ver vote_teams)."""
    return {t: team for t, (team, _) in vote_teams(rows, refs).items()}

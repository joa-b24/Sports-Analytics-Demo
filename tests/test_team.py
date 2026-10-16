"""Equipo por el color de la camiseta: con margen, y por votación de las cajas de cada track."""
import numpy as np

from sportsan.tracking.stitch import color_distance
from sportsan.tracking.team import classify_team, hex_to_lab, vote_teams

# Colores de matches/partido_2026_09_25/match.yaml (como los mide process: azul apagado y negro).
KITS = {"own": "#5c5a72", "own_gk": "#d84242", "opp": "#261f18", "opp_gk": "#ff9a58", "ref": "#c4d581"}
REFS = {k: hex_to_lab(v) for k, v in KITS.items()}


def test_azul_y_negro_se_separan_con_la_luminosidad_completa():
    own, opp = REFS["own"], REFS["opp"]
    assert color_distance(own, opp) < 40                 # con la luminosidad a la mitad casi no se separan
    assert color_distance(own, opp, l_weight=1.0) >= 60


def test_equipo_con_margen():
    darker = REFS["own"] - np.array([20.0, 0, 0])        # el azul a la sombra
    assert classify_team(darker, REFS) == "own"
    middle = (REFS["own"] + REFS["opp"]) / 2              # a medio camino: no se decide
    assert classify_team(middle, REFS) == "unk"
    assert classify_team(REFS["own_gk"], REFS) == "own"  # las porteras cuentan para su equipo
    assert classify_team(REFS["opp_gk"], REFS) == "opp"
    assert classify_team(REFS["own"], {}) == "unk"


def test_votacion_por_track():
    own, opp = list(REFS["own"]), list(REFS["opp"])
    rows = (
        [{"track_id": 1, "lab": own}] * 6 + [{"track_id": 1, "lab": opp}] * 4      # 60 % own: no alcanza
        + [{"track_id": 2, "lab": own}] * 3                                        # 3 votos: muy pocos
        + [{"track_id": 3, "lab": opp}] * 8 + [{"track_id": 3, "lab": own}] * 2    # 80 % opp
    )
    v = vote_teams(rows, REFS)
    assert v[1] == ("unk", 0.6) and v[2] == ("unk", 1.0) and v[3] == ("opp", 0.8)

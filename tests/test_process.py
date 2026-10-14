"""De píxeles a cancha: normalización, filtro de fuera de la cancha, equipos por color y tabla del contrato."""
import numpy as np
import pytest

from sportsan.schema import TRACKING_COLUMNS
from sportsan.tracking.detect import Chunk
from sportsan.tracking.process import (
    calibrate_processed,
    classify_team,
    dominant_colors,
    hex_to_lab,
    lab_to_hex,
    on_pitch,
    to_normalized,
    track_teams,
    tracking_table,
)
from sportsan.tracking.propagate import apply_h, venue_grid

# Cámara plausible sobre una sede de 100 x 65 m: metros -> píxeles.
M2P = np.array([[14.0, -6.0, 300.0], [0.4, 9.0, 420.0], [0.0, -0.004, 1.0]])
H = np.linalg.inv(M2P)


def test_feet_go_to_the_normalised_pitch_with_the_venue_scale():
    meters = np.array([[50.0, 32.5], [100.0, 65.0], [0.0, 0.0]])
    feet = apply_h(M2P, meters)
    xy = to_normalized(H, feet, 100, 65)
    # El centro de la sede es el centro de la cancha normalizada; la esquina lejana, (105, 68).
    assert np.allclose(xy, [[52.5, 34.0], [105.0, 68.0], [0.0, 0.0]], atol=1e-6)
    # Sin calibración no se inventa la posición.
    assert np.isnan(to_normalized(None, feet, 100, 65)).all()
    assert to_normalized(H, np.empty((0, 2)), 100, 65).shape == (0, 2)


def test_on_pitch_uses_the_contract_margin_and_never_guesses():
    xy = np.array([[52.5, 34.0], [-2.9, 0.0], [-3.1, 0.0], [105.0, 71.0], [105.0, 71.5], [np.nan, np.nan]])
    assert on_pitch(xy).tolist() == [True, True, False, True, False, False]


def test_colours_round_trip_and_match_opencv_scale():
    assert lab_to_hex(hex_to_lab("#1e3a8a")) == "#1e3a8a"
    white, black = hex_to_lab("#ffffff"), hex_to_lab("#000000")
    assert white[0] == pytest.approx(255, abs=0.5) and black[0] == pytest.approx(0, abs=0.5)
    assert white[1:] == pytest.approx([128, 128], abs=0.5)  # gris: sin color
    with pytest.raises(ValueError):
        hex_to_lab("azul")


def test_teams_by_jersey_colour():
    refs = {"own": hex_to_lab("#2a4fb0"), "opp": hex_to_lab("#1a1a1a"), "ref": hex_to_lab("#e6e04b")}
    assert classify_team(hex_to_lab("#3155a8"), refs) == "own"   # azul algo distinto por la sombra
    assert classify_team(hex_to_lab("#262220"), refs) == "opp"
    assert classify_team(hex_to_lab("#d9d657"), refs) == "ref"
    assert classify_team(hex_to_lab("#c2185b"), refs) == "unk"   # ningún equipo viste así
    assert classify_team(hex_to_lab("#3155a8"), {}) == "unk"     # sin referencias no se decide

    # Un track se decide por el color mediano de sus cajas: un cuadro mal medido no lo cambia.
    blue, dark = list(hex_to_lab("#2a4fb0")), list(hex_to_lab("#1a1a1a"))
    rows = [{"track_id": 7, "lab": blue}] * 5 + [{"track_id": 7, "lab": dark}] + [{"track_id": 9, "lab": dark}] * 3
    assert track_teams(rows, refs) == {7: "own", 9: "opp"}


def test_dominant_colours_find_the_two_kits_and_the_referee():
    rng = np.random.default_rng(1)
    kits = {"#2a4fb0": 11, "#1a1a1a": 11, "#e6e04b": 1}
    labs = np.vstack([hex_to_lab(c) + rng.normal(0, 3, (n, 3)) for c, n in kits.items()])
    found = dominant_colors(labs, k=3)
    assert sorted(n for _, n in found) == [1, 11, 11]
    # Cada color encontrado queda cerca de una de las camisetas.
    for color, _ in found:
        assert min(np.linalg.norm(hex_to_lab(color) - hex_to_lab(k)) for k in kits) < 8
    assert dominant_colors(np.empty((0, 3))) == []


def test_calibration_of_processed_frames_spreads_from_the_library_anchors():
    # Cámara quieta: el movimiento entre cuadros procesados es la identidad.
    n = 30
    motions = {i: np.eye(3) for i in range(n - 1)}
    Hs, dropped, _ = calibrate_processed({0: H, 10: H, 20: H}, motions, n, venue_grid(100, 65), 1920, 1080, 2.0)
    assert dropped == [] and all(h is not None for h in Hs)
    px = np.array([[960.0, 700.0]])
    assert np.allclose(apply_h(Hs[25], px), apply_h(H, px), atol=1e-6)  # también después de la última ancla

    # Una ubicación corrida 5 m se descarta y no arrastra a las demás.
    shifted = np.array([[1, 0, 5.0], [0, 1, 0], [0, 0, 1]]) @ H
    Hs, dropped, _ = calibrate_processed({0: H, 10: shifted, 20: H, 29: H}, motions, n, venue_grid(100, 65), 1920, 1080, 2.0)
    assert dropped == [10]
    assert np.allclose(apply_h(Hs[10], px), apply_h(H, px), atol=1e-6)

    # Sin ninguna ubicación, la parte queda sin calibrar.
    assert calibrate_processed({}, motions, n, venue_grid(100, 65), 1920, 1080, 2.0)[0] == [None] * n


def test_tracking_table_follows_the_contract_and_leaves_out_who_is_off_the_pitch():
    meta = {"match_id": "m", "video_id": "v1", "fps": 30.0}
    chunk = Chunk(900, 1800)
    box = lambda tid, x, y, inside, team: [tid, 100, 200, 120, 260, 0.8, 50, 128, 128, x, y, inside, team]
    boxes = [
        [box(1, 50.0, 30.0, True, "own"), box(2, -10.0, 30.0, False, "unk")],   # el 2 está en la banca
        [box(1, 50.5, 30.2, True, "own"), box(3, None, None, False, "opp")],    # el 3, en un cuadro sin calibración
    ]
    df = tracking_table(meta, chunk, [900, 903], boxes)
    assert list(df.columns) == [*TRACKING_COLUMNS, "px", "py"]
    assert list(df["track_id"]) == [1, 1]
    assert list(df["frame"]) == [0, 3]                       # cuadro dentro de la parte
    assert df["t_video"].tolist() == pytest.approx([30.0, 30.1])
    assert df["segment_id"].unique().tolist() == ["v1_900_1800"]
    assert df["py"].tolist() == [260, 260]                   # el pie: borde inferior de la caja


def test_goalkeeper_colours_count_for_their_team():
    refs = {"own": hex_to_lab("#2a4fb0"), "opp": hex_to_lab("#1a1a1a"), "own_gk": hex_to_lab("#f28c28"), "opp_gk": hex_to_lab("#39b54a")}
    assert classify_team(hex_to_lab("#ef8a2c"), refs) == "own"   # portera de naranja
    assert classify_team(hex_to_lab("#3cb24d"), refs) == "opp"   # portera de verde
    assert classify_team(hex_to_lab("#2b50ad"), refs) == "own"

"""Tracker de balón (sportsan.tracking.ball): decisiones puras y candidatos sobre imágenes sintéticas."""
import numpy as np
import pytest

from sportsan.tracking import ball as b

VENUE = {"length_m": 100.0, "width_m": 65.0}
# Cámara cenital sintética: píxel -> metros reales por escala (10 px por metro, con 50 px de margen).
H = [0.1, 0, -5.0, 0, 0.1, -5.0, 0, 0, 1]


def test_pitch_polygon_and_pixels_round_trip():
    poly = b.pitch_polygon(H, VENUE, margin_m=0)
    assert poly.shape == (8, 2)
    assert np.allclose(poly[0], [50, 50]) and np.allclose(poly[4], [1050, 700])
    # Centro de la cancha normalizada -> centro en píxeles.
    assert np.allclose(b.to_pixel(H, VENUE, 52.5, 34), [550, 375])
    assert b.pitch_polygon(None, VENUE) is None


def test_candidates_find_a_small_white_blob_and_ignore_lines_and_outside():
    cv2 = pytest.importorskip("cv2")
    img = np.full((800, 1200, 3), (40, 110, 40), np.uint8)
    cv2.circle(img, (600, 400), 5, (240, 240, 240), -1)  # balón
    cv2.line(img, (100, 200), (1100, 200), (230, 230, 230), 3)  # línea pintada larga
    cv2.circle(img, (8, 8), 4, (240, 240, 240), -1)  # fuera de la cancha (y de su margen de 3 m)
    pts = b.candidates(img, b.pitch_polygon(H, VENUE))
    assert len(pts) == 1 and np.allclose(pts[0], [600, 400], atol=1)


def test_feet_regions():
    boxes = [[1, 100, 100, 140, 200, 0.9]]
    r = b.feet_regions(boxes)
    assert b.at_feet(np.array([[120, 198], [120, 120], [300, 198]], np.float32), r).tolist() == [True, False, False]
    assert b.at_feet(np.array([[1, 1]], np.float32), b.feet_regions([])).tolist() == [False]


def test_decide_only_sure_and_supported():
    def fr(f, pts, p):
        return (f, np.array(pts, np.float32).reshape(-1, 2), np.array(p, np.float32))

    seq = [
        fr(0, [[100, 100]], [0.6]),
        fr(3, [[110, 100]], [0.7]),
        fr(6, [[120, 100], [800, 500]], [0.97, 0.99]),  # el mejor (0.99) no tiene apoyo; el otro no es el mejor
        fr(9, [[130, 100]], [0.98]),
        fr(12, [[140, 100]], [0.96]),
        fr(15, [[900, 600]], [0.99]),  # seguro pero solo: ningún vecino lo apoya
    ]
    out = b.decide(seq)
    assert [x["frame"] for x in out] == [9, 12]
    assert out[0]["px"] == 130.0
    # Nada seguro: nada.
    assert b.decide([fr(0, [], [])]) == []


def test_ask_frames_one_per_second_inside_play_only():
    frames = list(range(0, 300, 3))  # 10 s a 30 fps
    asks = b.ask_frames(found=list(range(0, 60, 3)), frames=frames, fps=30, segments=[(0, 240)])
    # Seguro hasta 57: lo cubre hasta 57 + 15; de ahí a 240 sin balón, una petición por segundo; después de 240 no es juego.
    assert asks == [75, 105, 135, 165, 195, 225]
    # Un hueco corto entre dos detecciones no pide nada.
    assert b.ask_frames(found=[0, 3, 6, 18, 21], frames=list(range(0, 24, 3)), fps=30) == []
    assert b.ask_frames(found=frames, frames=frames, fps=30) == []

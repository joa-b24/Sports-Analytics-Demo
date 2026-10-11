"""Biblioteca de calibración: selección de referencias, comprobación entre anclas y ubicación de un cuadro."""
import numpy as np
import pytest

from sportsan.tracking.library import (
    Library,
    anchor_consistency,
    camera_shift_px,
    localize,
    reject_inconsistent,
    select_keyframes,
)
from sportsan.tracking.propagate import apply_h, venue_grid

W, H_IMG = 1920, 1080
GRID = venue_grid(100, 65)
M2P = np.array([[14.0, -6.0, 300.0], [0.4, 9.0, 420.0], [0.0, -0.004, 1.0]])


def camera(k: float) -> np.ndarray:
    """px -> m: la cámara panea 6 px por cuadro."""
    move = np.array([[1, 0, 6.0 * k], [0, 1, -1.0 * k], [0, 0, 1]])
    return np.linalg.inv(move @ M2P)


def motions(n: int) -> dict[int, np.ndarray]:
    return {k: np.linalg.inv(camera(k + 1)) @ camera(k) for k in range(n)}


def test_camera_shift_is_measured_in_pixels():
    assert camera_shift_px(camera(0), camera(0), W, H_IMG) == pytest.approx(0, abs=1e-6)
    assert camera_shift_px(camera(0), camera(10), W, H_IMG) == pytest.approx(np.hypot(60, 10), rel=1e-3)


def test_keyframes_are_spaced_by_camera_movement_and_keep_both_ends():
    frames = [(k, camera(k)) for k in range(101)]
    keep = select_keyframes(frames, W, H_IMG, min_shift_px=150)
    # ~6.1 px por cuadro: una referencia cada 25 cuadros.
    assert keep[0] == 0 and keep[-1] == 100
    assert np.all(np.diff(keep[:-1]) == 25)
    # Cámara quieta: bastan los extremos.
    assert select_keyframes([(k, camera(0)) for k in range(50)], W, H_IMG) == [0, 49]
    assert select_keyframes([], W, H_IMG) == []


def test_consistent_anchors_agree_with_their_neighbours():
    anchors = {f: camera(f) for f in (0, 10, 20, 30)}
    errors = anchor_consistency(anchors, motions(30), GRID, W, H_IMG)
    assert set(errors) == {10, 20}  # los extremos no tienen dos vecinas
    assert max(errors.values()) < 1e-6


def test_a_misplaced_anchor_is_dropped_and_its_neighbours_survive():
    anchors = {f: camera(f) for f in (0, 10, 20, 30, 40)}
    # La biblioteca ubicó el cuadro 20 una línea de yarda (4.57 m) más allá.
    shift = np.array([[1, 0, 4.572], [0, 1, 0], [0, 0, 1]])
    anchors[20] = shift @ anchors[20]

    errors = anchor_consistency(anchors, motions(40), GRID, W, H_IMG)
    assert errors[20] == pytest.approx(4.572, abs=0.05)
    # Sus vecinas también parecen malas mientras la errónea siga ahí...
    assert errors[10] > 1 and errors[30] > 1

    kept, dropped = reject_inconsistent(anchors, motions(40), GRID, W, H_IMG, max_error_m=2.0)
    # ...pero solo se quita la peor, y con eso las demás vuelven a cuadrar.
    assert dropped == [20]
    assert sorted(kept) == [0, 10, 30, 40]
    assert max(anchor_consistency(kept, motions(40), GRID, W, H_IMG).values()) < 1e-6


def test_nothing_is_dropped_when_everything_agrees():
    anchors = {f: camera(f) for f in (0, 10, 20)}
    kept, dropped = reject_inconsistent(anchors, motions(20), GRID, W, H_IMG)
    assert dropped == [] and sorted(kept) == [0, 10, 20]


# ---------------------------------------------------------------- con OpenCV: imágenes sintéticas

def _world(cv2, seed=5):
    """Una escena plana con textura que SIFT pueda reconocer."""
    rng = np.random.default_rng(seed)
    img = np.zeros((1400, 3200), np.uint8)
    for _ in range(1400):
        x, y = int(rng.integers(20, 3180)), int(rng.integers(20, 1380))
        cv2.circle(img, (x, y), int(rng.integers(4, 22)), int(rng.integers(60, 255)), -1)
        cv2.rectangle(img, (x, y), (x + int(rng.integers(5, 40)), y + int(rng.integers(5, 30))), int(rng.integers(40, 220)), 2)
    return cv2.GaussianBlur(img, (5, 5), 0)


def _view(cv2, world, dx, zoom=1.0, angle=0.0):
    """Cuadro de 960x540 que ve la escena desplazada dx píxeles. Devuelve (imagen, escena px -> cuadro px)."""
    c, s = np.cos(angle) * zoom, np.sin(angle) * zoom
    A = np.array([[c, -s, -dx * zoom], [s, c, -300.0 * zoom], [0, 0, 1]])
    return cv2.warpPerspective(world, A, (960, 540)), A


def test_localize_recovers_the_calibration_of_a_new_view(tmp_path):
    cv2 = pytest.importorskip("cv2")
    from sportsan.tracking.library import features

    world = _world(cv2)
    # "Metros" = píxeles de la escena / 10. La calibración de un cuadro es (cuadro px -> escena px) y esa escala.
    to_m = np.diag([0.1, 0.1, 1.0])
    xys, dess, Hs, offsets = [], [], [], [0]
    for dx in (200, 700, 1200, 1700):  # barrido de lado a lado
        img, A = _view(cv2, world, dx)
        xy, des = features(img, 1.0)
        xys.append(xy)
        dess.append(des)
        Hs.append(to_m @ np.linalg.inv(A))
        offsets.append(offsets[-1] + len(xy))
    lib = Library(np.arange(4), np.array(Hs), np.array(offsets), np.concatenate(xys), np.concatenate(dess),
                  {"schema_version": 1, "image_w": 960, "image_h": 540, "work_width": 960, "venue": {}})

    # Un cuadro que no está en la biblioteca: entre dos referencias, con algo de zoom y giro.
    img, A = _view(cv2, world, 950, zoom=1.15, angle=0.03)
    loc = localize(*features(img, 1.0), lib)
    assert loc.H is not None and loc.inliers >= 60 and loc.n_refs >= 2
    px = np.array([[150, 120], [800, 100], [480, 270], [200, 450], [820, 430]], dtype=float)
    truth = apply_h(to_m @ np.linalg.inv(A), px)
    assert np.linalg.norm(apply_h(loc.H, px) - truth, axis=1).max() < 0.1  # menos de 1 px de la escena
    assert loc.spread_m is not None and loc.spread_m < 0.1

    # Un encuadre que el barrido nunca vio no se inventa.
    far, _ = _view(cv2, world, 2700)
    assert localize(*features(far, 1.0), lib).H is None

    # Guardar y volver a cargar da la misma respuesta.
    lib.save(tmp_path / "lib.npz")
    again = localize(*features(img, 1.0), Library.load(tmp_path / "lib.npz"))
    assert np.allclose(again.H, loc.H)

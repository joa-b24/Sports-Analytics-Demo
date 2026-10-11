"""Propagación de la calibración entre anclas: cadenas, mezcla y anclas de control (numpy puro)."""
import json

import numpy as np
import pytest

from sportsan.tracking.propagate import (
    apply_h,
    blend,
    fit_homography,
    leave_one_out,
    propagate,
    read_anchors,
    track_to_json,
    venue_grid,
)

W, H_IMG = 1920, 1080
GRID = venue_grid(100, 65)

# Cámara plausible: metros -> píxeles con perspectiva real; la banda cercana queda abajo.
M2P = np.array([[14.0, -6.0, 300.0], [0.4, 9.0, 420.0], [0.0, -0.004, 1.0]])


def camera(k: int) -> np.ndarray:
    """px -> m en el cuadro k: la cámara panea y hace zoom poco a poco."""
    a, z = 0.0015 * k, 1 + 0.002 * k
    move = np.array([[z * np.cos(a), -z * np.sin(a), 6.0 * k], [z * np.sin(a), z * np.cos(a), -1.5 * k], [0, 0, 1]])
    return np.linalg.inv(move @ M2P)


def true_motions(n: int) -> dict[int, np.ndarray]:
    # px_k -> px_{k+1}
    return {k: np.linalg.inv(camera(k + 1)) @ camera(k) for k in range(n)}


def error_m(H: np.ndarray, k: int) -> float:
    px = np.array([[400, 500], [960, 600], [1500, 700], [700, 900], [1300, 950]], dtype=float)
    return float(np.linalg.norm(apply_h(H, px) - apply_h(camera(k), px), axis=1).max())


def test_fit_homography_recovers_a_known_one():
    px = np.array([[100, 400], [900, 380], [1800, 420], [300, 800], [1500, 820], [960, 1000]], dtype=float)
    Hfit = fit_homography(px, apply_h(camera(0), px))
    assert Hfit is not None
    assert error_m(Hfit, 0) < 1e-6


def test_fit_homography_refuses_collinear_points():
    px = np.array([[0, 0], [10, 10], [20, 20], [30, 30], [40, 40]], dtype=float)
    assert fit_homography(px, px * 2) is None
    assert fit_homography(px[:3], px[:3]) is None


def test_exact_motion_reproduces_every_frame():
    calib = propagate({0: camera(0), 20: camera(20)}, true_motions(20), 0, 20, GRID, W, H_IMG)
    assert [c.frame for c in calib] == list(range(21))
    assert calib[0].source == "anchor" and calib[20].source == "anchor"
    for c in calib[1:20]:
        assert c.source == "propagated"
        assert error_m(c.H, c.frame) < 1e-6
        assert c.disagreement_m < 1e-6


def test_blending_beats_one_direction_when_motion_drifts():
    rng = np.random.default_rng(3)
    motions = true_motions(40)
    # Deriva: cada paso lleva un pequeño error, como al seguir puntos reales.
    drifted = {k: G @ np.array([[1, 0, rng.normal(0, 0.4)], [0, 1, rng.normal(0, 0.4)], [0, 0, 1]]) for k, G in motions.items()}

    forward_only = propagate({0: camera(0)}, drifted, 0, 40, GRID, W, H_IMG)
    both = propagate({0: camera(0), 40: camera(40)}, drifted, 0, 40, GRID, W, H_IMG)

    # Sin ancla al final el error se acumula; con ella queda acotado en los dos extremos.
    assert error_m(both[39].H, 39) < error_m(forward_only[39].H, 39)
    assert max(error_m(c.H, c.frame) for c in both) < error_m(forward_only[40].H, 40)
    # La discrepancia avisa de la deriva y solo existe entre dos anclas.
    assert both[20].disagreement_m > 0
    assert forward_only[20].disagreement_m is None


def test_a_lost_frame_cuts_the_chain_but_not_the_other_side():
    motions: dict = true_motions(10)
    motions[4] = None  # no se pudo estimar el paso del cuadro 4 al 5
    calib = propagate({0: camera(0), 10: camera(10)}, motions, 0, 10, GRID, W, H_IMG)
    assert all(c.H is not None for c in calib)
    assert calib[3].disagreement_m is None  # solo llega la cadena hacia adelante
    assert error_m(calib[3].H, 3) < 1e-6 and error_m(calib[7].H, 7) < 1e-6

    alone = propagate({0: camera(0)}, motions, 0, 10, GRID, W, H_IMG)
    assert alone[4].H is not None and alone[5].H is None and alone[5].source == "none"


def test_blend_weights_follow_the_nearest_anchor():
    Hf, Hb = camera(5), camera(5) @ np.array([[1, 0, 8.0], [0, 1, 0], [0, 0, 1]])
    near_f, dis = blend(Hf, Hb, 0.0, GRID, W, H_IMG)
    near_b, _ = blend(Hf, Hb, 1.0, GRID, W, H_IMG)
    px = np.array([[960, 700]], dtype=float)
    assert np.allclose(apply_h(near_f, px), apply_h(Hf, px), atol=1e-6)
    assert np.allclose(apply_h(near_b, px), apply_h(Hb, px), atol=1e-6)
    assert dis > 0


def test_leave_one_out_measures_the_error_at_the_removed_anchor():
    px = np.array([[300, 500], [960, 480], [1600, 520], [500, 850], [1400, 880], [960, 1000]], dtype=float)
    points = {f: (px, apply_h(camera(f), px)) for f in (0, 10, 20)}

    exact = leave_one_out(points, true_motions(20), GRID, W, H_IMG)
    assert [c["frame"] for c in exact] == [10]
    assert exact[0]["from"] == [0, 20]
    assert exact[0]["error_max_m"] < 1e-6

    # Si el movimiento estimado es malo en un lado, la comprobación lo delata. (Un sesgo igual en todos
    # los pasos se cancela al mezclar las dos direcciones en el punto medio: por eso solo la primera mitad.)
    bad = {k: G @ np.array([[1, 0, 2.0 if k < 10 else 0.0], [0, 1, 0], [0, 0, 1]]) for k, G in true_motions(20).items()}
    assert leave_one_out(points, bad, GRID, W, H_IMG)[0]["error_mean_m"] > 0.2

    assert leave_one_out({0: points[0], 20: points[20]}, true_motions(20), GRID, W, H_IMG) == []


def test_read_anchors_rejects_the_old_export(tmp_path):
    old = tmp_path / "anchors.json"
    old.write_text(json.dumps({"schema_version": 1, "anchors": [{"frame": 0, "points": []}]}), encoding="utf-8")
    with pytest.raises(ValueError, match="Vuelve a exportar"):
        read_anchors(old)


def test_track_json_is_serialisable_and_keeps_missing_frames_as_null():
    motions: dict = true_motions(4)
    motions[1] = None
    calib = propagate({0: camera(0)}, motions, 0, 4, GRID, W, H_IMG)
    out = json.loads(json.dumps(track_to_json({"match_id": "m", "video_id": "v1"}, calib, [])))
    assert out["kind"] == "calib_track" and out["start_frame"] == 0 and out["end_frame"] == 4
    assert len(out["frames"][0]["H"]) == 9
    assert out["frames"][3]["H"] is None and out["frames"][3]["source"] == "none"

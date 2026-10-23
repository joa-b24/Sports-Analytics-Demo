"""Reid por apariencia (tracking/reid.py) con recortes y video sintéticos."""
import numpy as np
import pytest

cv2 = pytest.importorskip("cv2")

from sportsan.tracking.reid import (  # noqa: E402
    NO_SIM,
    auc,
    classic_descriptor,
    extract,
    pick_boxes,
    overlap_by_box,
    reid_column,
    tracklet_vectors,
)
from sportsan.tracking.tracklets import Box, Candidate, Tracklet  # noqa: E402


def person(shirt, shorts, h=120, w=50, seed=0):
    rng = np.random.default_rng(seed)
    img = np.full((h, w, 3), (40, 140, 40), np.uint8)  # césped (BGR)
    cv2.rectangle(img, (w // 4, 0), (3 * w // 4, h // 5), (90, 120, 170), -1)        # cabeza
    cv2.rectangle(img, (w // 5, h // 5), (4 * w // 5, int(h * 0.55)), shirt, -1)
    cv2.rectangle(img, (w // 5, int(h * 0.55)), (4 * w // 5, h), shorts, -1)
    return np.clip(img.astype(int) + rng.integers(-10, 10, img.shape), 0, 255).astype(np.uint8)


def box(frame, track, x1, y1, x2, y2):
    return Box(frame, track, x1, y1, x2, y2, (0, 0, 0), 0.0, 0.0, "own", True)


def test_descriptor_separates_kits():
    red = classic_descriptor(person((0, 0, 200), (255, 255, 255), seed=1))
    red2 = classic_descriptor(person((0, 0, 200), (255, 255, 255), h=90, w=40, seed=2))
    blue = classic_descriptor(person((200, 0, 0), (20, 20, 20), seed=3))
    assert abs(np.linalg.norm(red) - 1) < 1e-6
    assert red @ red2 > red @ blue + 0.2


def test_auc():
    assert auc(np.array([3.0, 4.0]), np.array([1.0, 2.0])) == 1.0
    assert auc(np.array([1.0]), np.array([1.0])) == 0.5
    assert np.isnan(auc(np.array([]), np.array([1.0])))


def test_pick_boxes_prefers_large_and_isolated():
    t = Tracklet(0, 1, [box(f, 1, 100, 100, 130, 100 + 40 + f) for f in range(0, 30, 3)])
    other = box(27, 2, 100, 100, 130, 167)        # overlaps the tallest one
    frames = [[b] for b in t.boxes[:-1]] + [[t.boxes[-1], other]]
    picked = pick_boxes(t, overlap_by_box(frames), 1920, 1080, n=3)
    assert len(picked) == 3
    assert picked[0].frame == 24                  # tallest without overlap


def test_reid_column_gates_small_boxes():
    V = np.array([[1, 0], [1, 0], [0, 1]], dtype=float)
    H = np.array([120.0, 110.0, 50.0])
    cands = [Candidate(0, 1, np.zeros(1)), Candidate(1, 2, np.zeros(1))]
    col = reid_column(cands, V, H, h_min=100)
    assert col[0] == pytest.approx(1.0) and col[1] == NO_SIM


def test_extract_from_synthetic_video(tmp_path):
    path = tmp_path / "v.avi"
    wr = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"MJPG"), 30, (320, 240))
    a, b = person((0, 0, 200), (255, 255, 255)), person((200, 0, 0), (20, 20, 20))
    for _ in range(10):
        img = np.full((240, 320, 3), (40, 140, 40), np.uint8)
        img[60:180, 20:70] = a
        img[60:180, 200:250] = b
        wr.write(img)
    wr.release()
    ta = Tracklet(0, 1, [box(f, 1, 20, 60, 70, 180) for f in (0, 3, 6)])
    tb = Tracklet(1, 2, [box(f, 2, 200, 60, 250, 180) for f in (0, 3, 6)])
    tc = Tracklet(2, 3, [box(f, 3, 20, 60, 70, 180) for f in (8, 9)])   # same player as a, later
    wanted = {}
    for t in (ta, tb, tc):
        for bx in t.boxes:
            wanted.setdefault(bx.frame, []).append(bx)
    d = extract(path, wanted)
    assert len(d["keys"]) == 8
    V, H = tracklet_vectors([ta, tb, tc], d)
    assert np.all(H == 120)
    assert V[0] @ V[2] > V[0] @ V[1] + 0.2

import numpy as np

from sportsan.tracking.feet import LOOSE_ID, correct_rows, correct_sequence

FPS = 30.0


def running(n=40, dy=1.5, h0=90.0, dh=0.6):
    """A player moving down the image (towards the camera): top and bottom both move, and the box grows (perspective)."""
    t = np.arange(n) * 0.1
    top = 300 + dy * np.arange(n)
    h = h0 + dh * np.arange(n)
    x = 800 + 2 * np.arange(n)
    return t, np.c_[x - 15, top, x + 15, top + h]


def test_normal_running_with_perspective_is_not_changed():
    t, b = running()
    feet, fixed = correct_sequence(t, b)
    assert not fixed.any()
    assert np.allclose(feet[:, 1], b[:, 3])


def test_cut_feet_are_put_back_under_the_head():
    t, b = running()
    true_bottom = b[:, 3].copy()
    b[20:23, 3] -= 35  # someone in front hides her feet for 3 positions
    feet, fixed = correct_sequence(t, b)
    assert fixed[20:23].all() and fixed.sum() == 3
    assert np.abs(feet[20:23, 1] - true_bottom[20:23]).max() < 4


def test_box_stretched_down_to_the_player_in_front():
    t, b = running()
    true_bottom = b[:, 3].copy()
    b[10, 3] += 40
    feet, fixed = correct_sequence(t, b)
    assert fixed[10] and fixed.sum() == 1
    assert abs(feet[10, 1] - true_bottom[10]) < 4


def test_head_cut_is_not_mistaken_for_feet():
    # The top moves (head hidden), the bottom is right: nothing to correct.
    t, b = running()
    b[15:17, 1] += 30
    _, fixed = correct_sequence(t, b)
    assert not fixed.any()


def test_short_tracks_and_loose_boxes_are_left_as_they_are():
    t, b = running(n=5)
    b[2, 3] -= 30
    _, fixed = correct_sequence(t, b)
    assert not fixed.any()
    rows = [[{"track_id": LOOSE_ID + 1, "box": [0, 0, 10, 30]}]]
    feet, n = correct_rows([0], rows, FPS)
    assert n == 0 and feet[0][0].tolist() == [5, 30]


def test_rows_are_corrected_by_tracker_track():
    t, b = running()
    b[20, 3] -= 35
    frames = [int(round(x * FPS)) for x in t]
    rows = [[{"track_id": 7, "box": list(bx)}, {"track_id": 8, "box": [100, 100, 130, 190]}] for bx in b]
    feet, n = correct_rows(frames, rows, FPS)
    assert n == 1
    assert feet[20][0][1] > b[20, 3] + 20
    assert feet[20][1].tolist() == [115, 190]


def test_dancing_bottom_is_steadied():
    from sportsan.tracking.feet import combined_sequence

    t, b = running(dy=0.0, dh=0.0)
    true_bottom = b[:, 3].copy()
    # The bottom edge goes up and down by 20-25 px every position for 1 s, the head stays.
    for k, i in enumerate(range(15, 25)):
        b[i, 3] += 22 if k % 2 == 0 else -20
    feet, fixed = combined_sequence(t, b)
    off = [i for i in range(15, 25) if abs(b[i, 3] - true_bottom[i]) > 10]
    assert all(abs(feet[i, 1] - true_bottom[i]) < 8 for i in off)


def test_approaching_the_camera_is_not_dancing():
    from sportsan.tracking.feet import combined_sequence

    t, b = running(dy=2.0, dh=1.2)
    feet, fixed = combined_sequence(t, b)
    assert not fixed.any()


def test_after_the_dance_the_box_keeps_its_own_bottom():
    # Case 12 of the review: once the box is back to its usual height, its own bottom is used, not a lagging median.
    from sportsan.tracking.feet import combined_sequence

    t, b = running(dy=0.0, dh=0.0)
    for k, i in enumerate(range(10, 20)):
        b[i, 3] += 30 if k % 2 == 0 else -5
    feet, _ = combined_sequence(t, b)
    assert np.allclose(feet[22:, 1], b[22:, 3])

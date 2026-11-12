import numpy as np
import pytest

from sportsan.tracking.library import Library, rescale_library


def tiny():
    H = np.array([[[0.1, 0, 5.0], [0, 0.1, 2.0], [0, 0, 1.0]]])
    return Library(np.array([10]), H, np.array([0, 2]), np.array([[960.0, 540.0], [1920.0, 1080.0]], np.float32), np.zeros((2, 128), np.uint8),
                   {"image_w": 1920, "image_h": 1080, "video_id": "v2", "match_id": "m", "mask": [[0, 0, 192, 108]], "work_width": 960})


def test_rescaled_points_and_homographies_describe_the_same_world():
    lib = tiny()
    out = rescale_library(lib, 1280, 720, "v2", "v1", "m")
    assert out.meta["image_w"] == 1280 and out.meta["video_id"] == "v1" and out.meta["borrowed_from"] == "v2"
    assert np.allclose(out.xy[1], [1280, 720])
    # The same pixel of the scene: p_src = 1.5 * p_dst, so H_dst(p_dst) == H_src(p_src).
    p_dst = np.array([640.0, 360.0, 1.0])
    p_src = np.array([960.0, 540.0, 1.0])
    a, b = out.H[0] @ p_dst, lib.H[0] @ p_src
    assert np.allclose(a / a[2], b / b[2])
    assert out.meta["mask"] == [[0, 0, 128, 72]]
    assert lib.meta["image_w"] == 1920  # the original is not touched


def test_different_aspect_is_refused():
    with pytest.raises(ValueError):
        rescale_library(tiny(), 1000, 1000, "v2", "v1")

"""refine: pies y calibración suavizada sobre una parte ya procesada (datos sintéticos, sin GPU)."""
import json

import numpy as np
import pandas as pd

from sportsan.tracking.feet import apply_h
from sportsan.tracking.refine import backup_path, fit_h, refine_file, refine_tracks, smooth_homographies

FPS = 30.0
STRIDE = 3
PTS = np.array([[300, 650], [960, 650], [1600, 650], [300, 950], [960, 950], [1600, 950]], dtype=float)
# Imagen -> metros con algo de perspectiva (bien condicionada en la mitad baja).
H0 = np.array([[0.05, 0.0, 0.0], [0.0, 0.08, -30.0], [0.0, 0.0004, 1.0]])


def true_h(k: int, cut_at: int | None = None) -> np.ndarray:
    """Cámara que barre 6 m/s a lo largo; con `cut_at`, la calibración salta 20 m desde esa muestra."""
    dx = 6.0 * k * STRIDE / FPS + (20.0 if cut_at is not None and k >= cut_at else 0.0)
    T = np.array([[1, 0, 10 + dx], [0, 1, 5], [0, 0, 1]])
    return T @ H0


def noisy(n: int, sigma: float, cut_at=None, seed=0):
    rng = np.random.default_rng(seed)
    out = []
    for k in range(n):
        dst = apply_h(true_h(k, cut_at), PTS) + rng.normal(0, sigma, (len(PTS), 2))
        out.append(fit_h(PTS, dst))
    return out


def err(Hs, n, cut_at=None):
    return np.array([np.abs(apply_h(H, PTS) - apply_h(true_h(k, cut_at), PTS)).max() for k, H in zip(range(n), Hs)])


def test_fit_h_exact():
    dst = apply_h(H0, PTS)
    assert np.allclose(apply_h(fit_h(PTS, dst), PTS), dst, atol=1e-6)


def test_smoothing_reduces_jitter_and_follows_pan():
    n = 90
    Hs = noisy(n, 0.3)
    sm, info = smooth_homographies(Hs, np.arange(n) * STRIDE / FPS, PTS)
    assert info["cuts"] == 0
    assert err(sm, n).mean() < 0.75 * err(Hs, n).mean()
    # Barrido de 6 m/s: sin retraso (error medio en el centro de la serie, lejos de los bordes).
    assert err(sm, n)[10:-10].mean() < 0.3


def test_cut_is_not_smoothed_across():
    n, cut = 90, 45
    Hs = noisy(n, 0.2, cut_at=cut)
    sm, info = smooth_homographies(Hs, np.arange(n) * STRIDE / FPS, PTS)
    assert info["cuts"] >= 1
    e = err(sm, n, cut_at=cut)
    # Los cuadros pegados al corte no se arrastran hacia el otro lado (20 m de salto).
    assert e[cut - 2:cut + 2].max() < 1.0


def test_none_frames_stay_none():
    n = 40
    Hs = noisy(n, 0.2)
    Hs[20] = None
    sm, _ = smooth_homographies(Hs, np.arange(n) * STRIDE / FPS, PTS)
    assert sm[20] is None and sm[19] is not None


def part(n=60):
    cols = ["track_id", "x1", "y1", "x2", "y2", "conf", "lab_l", "lab_a", "lab_b", "x", "y", "on_pitch", "team", "identity"]
    Hs = noisy(n, 0.3)
    frames = []
    for k in range(n):
        boxes = []
        for tid, cx in ((1, 500.0), (2, 1200.0)):
            y2 = 900.0 + (60 if (tid == 1 and k == 30) else 0)   # pies que «se estiran» un cuadro
            boxes.append([tid, cx - 15, 800.0, cx + 15, y2, 0.9, 50, 0, 0, 0.0, 0.0, True, "own", tid])
        frames.append({"frame": 1000 + k * STRIDE, "H": [float(v) for v in Hs[k].reshape(-1)], "boxes": boxes})
    return {"schema_version": 3, "kind": "tracks_px", "match_id": "m", "video_id": "v1", "fps": FPS, "image_w": 1920,
            "image_h": 1080, "venue": {"length_m": 105, "width_m": 68}, "start_frame": 1000, "end_frame": 1000 + n * STRIDE,
            "stride": STRIDE, "box_columns": cols, "frames": frames, "quality": {}}


def test_refine_is_idempotent_and_marks():
    data = part()
    out, s = refine_tracks(data)
    assert not s["skipped"] and out["refined"]["feet"] and out["refined"]["smooth_h"]
    assert s["refined"]["feet_fixed"] >= 1
    again, s2 = refine_tracks(out)
    assert s2["skipped"] and again is out
    # Solo pies primero, luego la calibración: la segunda suaviza una vez y no repite pies.
    a, _ = refine_tracks(data, smooth_h=False)
    b, sb = refine_tracks(a)
    assert not sb["skipped"] and b["refined"] == {**b["refined"], "feet": True, "smooth_h": True}
    assert refine_tracks(b)[1]["skipped"]
    assert data.get("refined") is None   # la entrada no se modifica


def test_refine_file_out_and_in_place(tmp_path):
    src = tmp_path / "tracks_v1_1000_1180.json"
    src.write_text(json.dumps(part()), encoding="utf-8")
    original = src.read_text(encoding="utf-8")
    out = tmp_path / "copia" / "refinada.json"
    refine_file(src, out)
    assert src.read_text(encoding="utf-8") == original and out.exists()
    assert not backup_path(src).exists()

    s = refine_file(src)
    assert backup_path(src).read_text(encoding="utf-8") == original
    assert json.loads(src.read_text(encoding="utf-8"))["refined"]["smooth_h"]
    pq = tmp_path / "tracking_v1_1000_1180.parquet"
    assert len(pd.read_parquet(pq)) > 0 and not s["skipped"]
    # Segunda vez: no cambia nada y la copia sigue siendo el original.
    before = src.read_text(encoding="utf-8")
    assert refine_file(src)["skipped"]
    assert src.read_text(encoding="utf-8") == before and backup_path(src).read_text(encoding="utf-8") == original


def test_feet_marks_only_corrected_boxes(tmp_path):
    from sportsan.tracking.refine import feet_marks, feet_marks_path

    data = part()
    m = feet_marks(data, "v1_1000_1180")
    assert m["part"] == "v1_1000_1180" and m["stride"] == STRIDE
    # Solo la caja estirada (track 1, muestra 30) y con el pie arriba de su borde inferior.
    assert list(m["boxes"]) == [str(1000 + 30 * STRIDE)]
    (tid, (x, y)), = m["boxes"][str(1000 + 30 * STRIDE)].items()
    assert tid == "1" and x == 500.0 and y < 960.0
    # refine en sitio lo escribe junto a los tracks; las marcas no dependen de la H suavizada.
    src = tmp_path / "tracks_v1_1000_1180.json"
    src.write_text(json.dumps(data), encoding="utf-8")
    refine_file(src)
    assert json.loads(feet_marks_path(src).read_text(encoding="utf-8")) == json.loads(json.dumps(m))

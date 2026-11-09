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


def test_drop_detours_removes_out_and_back_but_keeps_a_jump_that_stays():
    # H of the synthetic camera: 10 px per meter (pixel 50 = 0 m). Ball at 30 m, jumps to 80 m for two processed frames
    # and comes back: an aerial ball taken to the ground.
    Hs = {f: H for f in range(0, 60, 3)}
    px = lambda m: 50 + 10 * m  # noqa: E731
    found = [{"frame": f, "px": px(x), "py": px(30), "p": 0.95} for f, x in [(0, 30), (3, 31), (6, 80), (9, 79), (12, 33), (15, 34)]]
    kept = b.drop_detours(found, Hs, VENUE, 30)
    assert [x["frame"] for x in kept] == [0, 3, 12, 15]
    # A jump that does not come back stays (a clearance seen after a hole).
    found2 = [{"frame": f, "px": px(x), "py": px(30), "p": 0.95} for f, x in [(0, 30), (3, 31), (6, 80), (9, 81), (12, 82)]]
    assert [x["frame"] for x in b.drop_detours(found2, Hs, VENUE, 30)] == [0, 3, 6, 9, 12]


def test_progress_line_format_and_log(tmp_path):
    from sportsan.tracking.ball import BallProgress, progress_line, progress_path

    assert progress_line("cuadros", 40, 120, 10.0, 12.0, "10:00:03") == "10:00:03 cuadros 40/120 33% ETA 20s (total 12s)"
    assert progress_line("cuadros", 0, 120, 0.0, 0.0, "10:00:00") == "10:00:00 cuadros 0/120 0% ETA nans (total 0s)"
    part = tmp_path / "tracking" / "tracks_v1_10_20.json"
    assert progress_path(tmp_path, part).name == "progreso_ball_v1_10_20.log"
    pr = BallProgress(progress_path(tmp_path, part))
    pr.log("cuadros", 5, 10)
    pr.log("listo", 1, 1)
    lines = progress_path(tmp_path, part).read_text(encoding="utf-8").splitlines()
    assert len(lines) == 2 and " cuadros 5/10 50% ETA " in lines[0] and " listo 1/1 100% " in lines[1]


# ------------------------------------------------------------------ entrenamiento con muestras (Playground)

def _samples_doc(**over):
    doc = {"kind": "ball_samples", "video_id": "v1", "fps": 30.0,
           "samples": [{"t_video": 1.5, "px": [100, 50], "aerial": False, "shadow_px": None},
                       {"t_video": 2.0, "px": [110.5, 60], "aerial": True, "shadow_px": [110, 90]}],
           "negatives": [{"t_video": 3.0}, {"t_video": 3.0}]}
    doc.update(over)
    return doc


def test_parse_samples_valid_and_dedupes_negatives():
    d = b.parse_samples(_samples_doc())
    assert d["video_id"] == "v1" and d["fps"] == 30.0
    assert d["samples"][1]["aerial"] is True and d["samples"][1]["shadow_px"] == (110.0, 90.0)
    assert d["samples"][0]["shadow_px"] is None
    assert d["negatives"] == [{"t_video": 3.0}]


@pytest.mark.parametrize("bad", [
    {"kind": "other"},
    {"video_id": ""},
    {"samples": [{"t_video": -1, "px": [1, 2]}]},
    {"samples": [{"t_video": 1, "px": [1]}]},
    {"samples": [{"t_video": 1, "px": [1, float("nan")]}]},
    {"samples": [{"t_video": 1, "px": [1, 2], "shadow_px": "x"}]},
    {"negatives": [{"t_video": "a"}]},
    {"fps": 0},
])
def test_parse_samples_rejects_bad(bad):
    with pytest.raises(ValueError):
        b.parse_samples(_samples_doc(**bad))


def test_parse_samples_reads_file(tmp_path):
    import json

    p = tmp_path / "ball_samples_v1.json"
    p.write_text(json.dumps(_samples_doc()), encoding="utf-8")
    assert len(b.parse_samples(p)["samples"]) == 2


def test_split_holdout_by_time_blocks_is_disjoint_deterministic_and_sized():
    ts = [i * 0.25 for i in range(80)]  # 20 s
    tr, ho = b.split_holdout(ts, 0.2, seed=1)
    assert sorted(tr + ho) == list(range(80)) and not set(tr) & set(ho)
    assert 16 <= len(ho) <= 24
    # Nunca comparten bloque de 2 s: sin cuadros vecinos a ambos lados.
    assert not {int(ts[i] // 2) for i in tr} & {int(ts[i] // 2) for i in ho}
    assert b.split_holdout(ts, 0.2, seed=1) == (tr, ho)
    assert b.split_holdout(ts, 0.0)[1] == []
    # Todo en un bloque: no se deja el entrenamiento vacio.
    tr1, ho1 = b.split_holdout([0.0, 0.1, 0.2], 0.5)
    assert len(tr1) == 3 and ho1 == []


def test_flag_points_marks_isolated_jump_and_boxes_but_keeps_them():
    Hs = {f: H for f in range(0, 30, 3)}
    px = lambda m: 50 + 10 * m  # noqa: E731
    # 10 procesados por segundo: un salto de 20 m en 0.1 s son 200 m/s y vuelve enseguida.
    found = [{"frame": f, "px": px(x), "py": px(30), "p": 0.95} for f, x in [(0, 30), (3, 30.2), (6, 50), (9, 30.4), (12, 30.6)]]
    out = b.flag_points(found, {}, Hs, 30.0)
    assert [o["frame"] for o in out] == [0, 3, 6, 9, 12]  # no se borra nada
    flags = {o["frame"]: o["flags"] for o in out}
    assert flags[6] == ["jump"] and flags[0] == [] and flags[12] == []
    # Un salto que se queda (despeje) no se marca.
    stay = [{"frame": f, "px": px(x), "py": px(30), "p": 0.95} for f, x in [(0, 30), (3, 30.2), (6, 50), (9, 50.1), (12, 50.2)]]
    assert all("jump" not in o["flags"] for o in b.flag_points(stay, {}, Hs, 30.0))
    # Dentro de la caja pero a los pies: no se marca; en la cabeza: si.
    boxes = {12: [[1, px(30.6) - 20, px(30) - 120, px(30.6) + 20, px(30) + 5, 0.9]]}
    head = [{"frame": 12, "px": px(30.6), "py": px(30) - 100, "p": 0.9}]
    feet = [{"frame": 12, "px": px(30.6), "py": px(30) - 2, "p": 0.9}]
    assert b.flag_points(head, boxes, Hs, 30.0)[0]["flags"] == ["in_player_box"]
    assert b.flag_points(feet, boxes, Hs, 30.0)[0]["flags"] == []
    # Sin H ni cajas no se inventa nada.
    assert b.flag_points([{"frame": 0, "px": 1.0, "py": 1.0, "p": 1}], {}, {}, 30.0)[0]["flags"] == []


def test_safe_model_path_never_the_current_model_nor_existing(tmp_path):
    with pytest.raises(SystemExit):
        b.safe_model_path(tmp_path / b.MODEL_NAME, "v1")
    existing = tmp_path / "otro.pt"
    existing.write_bytes(b"x")
    with pytest.raises(SystemExit):
        b.safe_model_path(existing, "v1")
    assert b.safe_model_path(tmp_path / "nuevo.pt", "v1") == tmp_path / "nuevo.pt"
    default = b.safe_model_path(None, "v2")
    assert default.name.startswith("ball_model_v2_") and default.name != b.MODEL_NAME


def _synthetic_match(tmp_path, seconds=10, fps=30):
    """Video corto: balon blanco que se mueve y una mancha blanca quieta (numero pintado)."""
    cv2 = pytest.importorskip("cv2")
    folder = tmp_path / "m"
    (folder / "video").mkdir(parents=True)
    w, h = 640, 360
    vw = cv2.VideoWriter(str(folder / "video" / "v1.mp4"), cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))
    if not vw.isOpened():
        pytest.skip("OpenCV sin codificador mp4v")
    truth = {}
    for f in range(seconds * fps):
        img = np.full((h, w, 3), (40, 110, 40), np.uint8)
        x, y = 40 + (f * 3) % 560, 60 + 120 * (1 + np.sin(f / 20.0))
        cv2.circle(img, (int(x), int(y)), 4, (245, 245, 245), -1)
        cv2.circle(img, (500, 300), 5, (245, 245, 245), -1)
        vw.write(img)
        truth[f] = (x, y)
    vw.release()
    return folder, truth, fps


def test_sample_frames_use_exact_t_video(tmp_path):
    folder, truth, fps = _synthetic_match(tmp_path, seconds=3)
    sf = b.SampleFrames(folder, "v1")
    assert abs(sf.fps - 30) < 1e-3 and sf.frame_of(1.0) == 30 and sf.frame_of(1 / 30) == 1
    _, H, pts, P = sf.features(sf.frame_of(1.0))
    assert H is None and P.shape[1:] == (4, b.PATCH, b.PATCH)
    x, y = truth[30]
    assert np.hypot(pts[:, 0] - x, pts[:, 1] - y).min() < 3  # el balon esta entre los candidatos
    assert np.hypot(pts[:, 0] - 500, pts[:, 1] - 300).min() < 3  # y la mancha quieta tambien


def test_train_samples_end_to_end_with_holdout_and_no_overwrite(tmp_path, monkeypatch, capsys):
    pytest.importorskip("torch")
    import json

    folder, truth, fps = _synthetic_match(tmp_path, seconds=10)
    monkeypatch.setattr(b, "match_dir", lambda m: folder)
    samples = [{"t_video": float(t), "px": list(truth[round(t * fps)]), "aerial": i % 5 == 0, "shadow_px": None}
               for i, t in enumerate(np.arange(0.2, 9.8, 0.2))]
    doc = {"kind": "ball_samples", "video_id": "v1", "fps": fps, "samples": samples, "negatives": [{"t_video": 9.9}]}
    sp = folder / "tracking" / "ball_samples_v1.json"
    sp.parent.mkdir()
    sp.write_text(json.dumps(doc), encoding="utf-8")
    old = tmp_path / "ball_model.pt"
    old.write_bytes(b"viejo")
    out = tmp_path / "ball_model_test.pt"
    res = b.train_samples("m", sp, out=out, exclude_aerial=True, holdout=0.2, epochs=3)
    text = capsys.readouterr().out
    assert res == out and out.exists() and out.with_suffix(".json").exists()
    assert "AVISO" in text and "%" in text and "ETA" in text  # menos de 100 muestras avisa; hay progreso con % y ETA
    meta = json.loads(out.with_suffix(".json").read_text(encoding="utf-8"))
    assert meta["samples"]["exclude_aerial"] is True and len(meta["samples"]["sha256"]) == 64
    assert meta["skipped_aerial"] > 0 and meta["samples"]["holdout_t_video"]
    val = meta["samples"]["validation"]
    assert set(val["p>=0.5"]) >= {"ground", "aerial", "all", "precision"} and val["meters"] is False
    m = json.loads((folder / "tracking" / "ball_metrics_v1.json").read_text(encoding="utf-8"))
    assert m["kind"] == "ball_metrics" and m["video_id"] == "v1" and m["model_file"] == str(out) and m["n_train"] > 0 and m["n_val"] > 0
    for k in ("ground", "aerial"):
        assert {"n", "precision", "recall", "error_px_median"} <= set(m[k])
        assert m[k]["precision"] is None or 0 <= m[k]["precision"] <= 1
    assert (folder / "tracking" / "revision" / "progreso_train_v1.log").exists()
    # No pisa el modelo viejo ni el recien creado.
    assert old.read_bytes() == b"viejo"
    with pytest.raises(SystemExit):
        b.train_samples("m", sp, out=out, epochs=1)
    with pytest.raises(SystemExit):
        b.train_samples("m", sp, out=old, epochs=1)
    assert old.read_bytes() == b"viejo"

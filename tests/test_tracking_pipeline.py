"""Prueba del pipeline de tracking con modelos falsos y un video sintético.

Se conoce la posición real (en metros) de cada jugadora, se proyecta a píxeles con una
homografía conocida y se verifica que el pipeline recupere las coordenadas de cancha.
"""
import numpy as np
import pytest

cv2 = pytest.importorskip("cv2")
sv = pytest.importorskip("supervision")

from sportsan.schema import validate_ball, validate_tracking
from sportsan.tracking.geometry import fit_homography
from sportsan.tracking.pipeline import (GOALKEEPER_CLASS_ID, PLAYER_CLASS_ID, REFEREE_CLASS_ID, Models,
                                        collect_player_crops, run_segment)

W, H, FPS, N_FRAMES = 640, 360, 25, 60
BLACK_FRAME = 30

# Homografía verdadera cancha(m) -> imagen(px): perspectiva suave
H_TRUE = np.array([[5.0, 1.0, 40.0], [0.3, 3.2, 20.0], [0.0004, 0.0012, 1.0]], dtype=np.float64)
H_INV = np.linalg.inv(H_TRUE)

# Puntos de referencia ("vértices") repartidos por la cancha, en metros
VERTS = np.array([[x, y] for x in (5, 30, 55, 80, 100) for y in (5, 25, 45, 63)], dtype=np.float32)

PLAYERS = {  # id -> (x_m, y_m, color BGR, clase)
    1: (30, 20, (0, 0, 255), PLAYER_CLASS_ID), 2: (40, 40, (0, 0, 255), PLAYER_CLASS_ID),
    3: (50, 25, (0, 0, 255), PLAYER_CLASS_ID), 4: (60, 30, (255, 0, 0), PLAYER_CLASS_ID),
    5: (70, 45, (255, 0, 0), PLAYER_CLASS_ID), 6: (55, 50, (255, 0, 0), PLAYER_CLASS_ID),
    7: (8, 34, (0, 0, 255), GOALKEEPER_CLASS_ID), 8: (45, 10, (200, 200, 200), REFEREE_CLASS_ID),
}
BALL_M = (52.0, 33.0)


def to_px(pts_m):
    pts = np.asarray(pts_m, dtype=np.float32).reshape(-1, 1, 2)
    return cv2.perspectiveTransform(pts, H_TRUE).reshape(-1, 2)


def make_frame(i):
    frame = np.full((H, W, 3), (40, 120, 40), dtype=np.uint8)
    if i == BLACK_FRAME:
        return np.zeros_like(frame)
    for _, (x, y, color, _) in PLAYERS.items():
        bx, by = to_px([[x, y]])[0]
        cv2.rectangle(frame, (int(bx - 6), int(by - 24)), (int(bx + 6), int(by)), color, -1)
    return frame


@pytest.fixture(scope="module")
def video(tmp_path_factory):
    path = tmp_path_factory.mktemp("vid") / "seg.mp4"
    vw = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), FPS, (W, H))
    for i in range(N_FRAMES):
        vw.write(make_frame(i))
    vw.release()
    return path


def fake_models(with_ball=True):
    ids = list(PLAYERS)
    boxes = []
    for pid in ids:
        x, y, _, _ = PLAYERS[pid]
        bx, by = to_px([[x, y]])[0]
        boxes.append([bx - 6, by - 24, bx + 6, by])
    boxes = np.array(boxes, dtype=np.float32)
    classes = np.array([PLAYERS[p][3] for p in ids])

    def detect_people(frame):
        return sv.Detections(xyxy=boxes.copy(), confidence=np.full(len(ids), 0.9, dtype=np.float32),
                             class_id=classes.copy())

    def detect_pitch(frame):
        px = to_px(VERTS)
        vis = (px[:, 0] > 2) & (px[:, 0] < W - 2) & (px[:, 1] > 2) & (px[:, 1] < H - 2)
        xy = np.where(vis[:, None], px, 0.0).astype(np.float32)
        return xy, np.where(vis, 0.95, 0.0).astype(np.float32)

    def detect_ball(frame):
        bx, by = to_px([BALL_M])[0]
        return sv.Detections(xyxy=np.array([[bx - 4, by - 8, bx + 4, by]], dtype=np.float32),
                             confidence=np.array([0.7], dtype=np.float32), class_id=np.array([0]))

    def team_predict(crops):  # cluster por color dominante: rojo -> 0, azul -> 1
        return np.array([0 if c[..., 2].mean() > c[..., 0].mean() else 1 for c in crops])

    return Models(detect_people=detect_people, detect_pitch=detect_pitch, pitch_vertices_m=VERTS,
                  detect_ball=detect_ball if with_ball else None, team_predict=team_predict)


def test_homografia_recupera_la_verdad():
    px = to_px(VERTS)
    cal = fit_homography(px, VERTS, np.full(len(VERTS), 0.9))
    assert cal.H is not None and cal.reason == "ok"
    back = cv2.perspectiveTransform(px.reshape(-1, 1, 2), cal.H).reshape(-1, 2)
    assert np.abs(back - VERTS).max() < 0.05


def test_homografia_rechaza_pocos_puntos_y_colineales():
    px = to_px(VERTS)
    assert fit_homography(px[:3], VERTS[:3], np.full(3, 0.9)).reason == "pocos_keypoints"
    colin = VERTS[VERTS[:, 1] == 5][:4]  # 4 puntos sobre la misma línea
    assert fit_homography(to_px(colin), colin, np.full(4, 0.9)).reason == "puntos_casi_colineales"
    assert fit_homography(px, VERTS, np.full(len(VERTS), 0.1)).reason == "pocos_keypoints"  # confianza baja


def test_pipeline_end_to_end(video, tmp_path):
    models = fake_models()
    crops = collect_player_crops(video, models, fit_stride_frames=10)
    assert len(crops) > 0
    seg_start = 600.0
    tracking, ball, calib, stats = run_segment(
        video, "s_test", seg_start, models, match_id="m", own_cluster=0, stride=2, out_dir=tmp_path,
        preview_path=tmp_path / "prev.mp4")

    validate_tracking(tracking); validate_ball(ball)
    assert (tmp_path / "tracking_s_test.parquet").exists() and (tmp_path / "prev.mp4").stat().st_size > 0
    assert stats["frames_negros_saltados"] == 1                                # frame 30 es negro
    assert stats["pct_homografia_ok"] == 100.0
    assert (tracking["t_video"] - tracking["t_local"] == seg_start).all()      # base de tiempo
    assert set(tracking["frame"]) <= set(range(0, N_FRAMES, 2)) and BLACK_FRAME not in set(tracking["frame"])

    # Posiciones recuperadas vs verdad (metros), por rol/equipo
    truth = {pid: np.array(v[:2]) for pid, v in PLAYERS.items()}
    last = tracking[tracking["frame"] == tracking["frame"].max()]
    assert len(last) == len(PLAYERS)
    errs = []
    for _, r in last.iterrows():
        d = [np.linalg.norm(truth[pid] - np.array([r["x"], r["y"]])) for pid in truth]
        errs.append(min(d))
    assert max(errs) < 0.3, errs

    # Equipos: rojas -> own (cluster 0), azules -> opp, árbitro -> ref, portera roja -> own
    counts = last["team"].value_counts().to_dict()
    assert counts == {"own": 4, "opp": 3, "ref": 1}, counts

    # Balón y calibración
    ok_ball = ball.dropna(subset=["x", "y"])
    assert len(ok_ball) > 0 and np.abs(ok_ball["x"] - BALL_M[0]).max() < 0.3 and np.abs(ok_ball["y"] - BALL_M[1]).max() < 0.3
    assert calib["ok"].all() and calib[[f"fov{i}" for i in range(8)]].notna().all().all()


def test_sin_balon_y_sin_homografia_deja_nan(video):
    models = fake_models(with_ball=False)
    models.detect_pitch = lambda f: (np.zeros((0, 2), dtype=np.float32), np.zeros(0, dtype=np.float32))
    tracking, ball, calib, stats = run_segment(video, "s_nh", 0.0, models, match_id="m", own_cluster=1, stride=3)
    assert tracking["x"].isna().all() and tracking["px"].notna().all()         # sin H no se inventan metros
    assert stats["pct_homografia_ok"] == 0.0 and ball["px"].isna().all()


def test_exige_own_cluster(video):
    with pytest.raises(ValueError):
        run_segment(video, "s", 0.0, fake_models(), match_id="m", own_cluster=None)


def test_rechaza_salto_temporal_de_camara(video):
    models = fake_models()
    good, calls = models.detect_pitch, {"n": 0}

    def flaky(frame):
        calls["n"] += 1
        xy, conf = good(frame)
        if calls["n"] in (6, 7):  # homografía consistente pero la cámara "salta" ~8 m en un frame
            xy = xy.copy()
            xy[conf > 0] += np.array([[40.0, -30.0]], dtype=np.float32)
        return xy, conf

    models.detect_pitch = flaky
    tracking, _, calib, stats = run_segment(video, "s_j", 0.0, models, match_id="m", own_cluster=0, stride=2)
    bad = calib[calib["reason"] == "salto_temporal"]
    assert len(bad) == 2 and not bad["ok"].any()
    assert tracking[tracking["frame"].isin(bad["frame"])]["x"].isna().all()   # esos frames no inventan metros
    assert tracking[~tracking["frame"].isin(bad["frame"])]["x"].notna().all()

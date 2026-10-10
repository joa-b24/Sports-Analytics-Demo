"""Carga de los modelos reales (Ultralytics YOLO + clasificador de equipos de Roboflow/sports).

Solo se importa en Colab/Kaggle: requiere `pip install -e ".[tracking]"` o las celdas del notebook.
Los pesos los baja el notebook (mismos archivos que usa roboflow/sports/examples/soccer).
"""
from __future__ import annotations

from pathlib import Path

import numpy as np

from ..schema import PITCH_LENGTH_M, PITCH_WIDTH_M  # noqa: F401  (documenta las unidades destino)
from .geometry import scale_vertices_to_meters
from .pipeline import Models

PLAYER_WEIGHTS = "football-player-detection.pt"
PITCH_WEIGHTS = "football-pitch-detection.pt"
BALL_WEIGHTS = "football-ball-detection.pt"


def load_models(weights_dir: str | Path, device: str = "cuda", *, with_ball: bool = True,
                with_teams: bool = True, people_imgsz: int = 1280) -> Models:
    import supervision as sv
    from sports.configs.soccer import SoccerPitchConfiguration
    from ultralytics import YOLO

    weights_dir = Path(weights_dir)
    cfg = SoccerPitchConfiguration()
    vertices_m = scale_vertices_to_meters(cfg.vertices, cfg.length, cfg.width)

    player_model = YOLO(str(weights_dir / PLAYER_WEIGHTS)).to(device=device)
    pitch_model = YOLO(str(weights_dir / PITCH_WEIGHTS)).to(device=device)

    def detect_people(frame):
        return sv.Detections.from_ultralytics(player_model(frame, imgsz=people_imgsz, verbose=False)[0])

    def detect_pitch(frame):
        kp = sv.KeyPoints.from_ultralytics(pitch_model(frame, verbose=False)[0])
        if len(kp.xy) == 0:
            return np.zeros((0, 2), dtype=np.float32), np.zeros(0, dtype=np.float32)
        conf = kp.confidence[0] if kp.confidence is not None else np.ones(len(kp.xy[0]), dtype=np.float32)
        return kp.xy[0], conf

    models = Models(detect_people=detect_people, detect_pitch=detect_pitch, pitch_vertices_m=vertices_m)

    if with_ball:
        ball_model = YOLO(str(weights_dir / BALL_WEIGHTS)).to(device=device)

        def _ball_cb(image_slice):
            return sv.Detections.from_ultralytics(ball_model(image_slice, imgsz=640, verbose=False)[0])

        slicer = sv.InferenceSlicer(callback=_ball_cb, overlap_filter=sv.OverlapFilter.NONE, slice_wh=(640, 640))
        models.detect_ball = lambda frame: slicer(frame).with_nms(threshold=0.1)

    if with_teams:
        from sports.common.team import TeamClassifier
        tc = TeamClassifier(device=device)
        models.team_fit, models.team_predict = tc.fit, tc.predict

    return models

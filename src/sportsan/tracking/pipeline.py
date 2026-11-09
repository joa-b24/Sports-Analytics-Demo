"""Pipeline de tracking de un segmento: detección, tracking, equipos, homografía y balón.

Los modelos se inyectan (dataclass Models), de modo que la lógica se prueba sin GPU.
Implementaciones reales en models.py. Salidas siguen docs/data_contract.md.

Con `python -m sportsan.tracking.pipeline <tracking|fill-ball> ...` este módulo no corre el pipeline: delega en
`orchestrate.py` (orquestadores de línea de comandos) antes de importar nada pesado.
"""
from __future__ import annotations

if __name__ == "__main__":
    from .orchestrate import main as _orchestrate_main

    raise SystemExit(_orchestrate_main())

import contextlib
import time
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import cv2
import numpy as np
import pandas as pd
import supervision as sv

from ..schema import (PITCH_LENGTH_M, PITCH_WIDTH_M, MARGIN_M, validate_ball,
                      validate_tracking)
from .geometry import (Calibration, fit_homography, image_corners_in_pitch, is_black_frame, project)

# Clases del modelo de jugadores de Roboflow
BALL_CLASS_ID, GOALKEEPER_CLASS_ID, PLAYER_CLASS_ID, REFEREE_CLASS_ID = 0, 1, 2, 3

TEAM_COLORS_BGR = {"own": (255, 120, 0), "opp": (0, 0, 255), "ref": (170, 170, 170), "unk": (0, 220, 220)}


@dataclass
class Models:
    detect_people: Callable[[np.ndarray], sv.Detections]            # class_id: 1 portera, 2 jugadora, 3 árbitro
    detect_pitch: Callable[[np.ndarray], tuple[np.ndarray, np.ndarray]]  # (xy[K,2] px, conf[K])
    pitch_vertices_m: np.ndarray                                     # [K,2] en metros (105x68)
    detect_ball: Callable[[np.ndarray], sv.Detections] | None = None
    team_fit: Callable[[list], None] | None = None
    team_predict: Callable[[list], np.ndarray] | None = None         # -> cluster 0/1 por recorte


class SimpleBallTracker:
    """Entre varias detecciones de balón elige la más cercana al centroide de posiciones recientes."""

    def __init__(self, buffer_size: int = 20):
        self.buffer: deque = deque(maxlen=buffer_size)

    def update(self, detections: sv.Detections) -> sv.Detections:
        xy = detections.get_anchors_coordinates(sv.Position.CENTER)
        self.buffer.append(xy)
        if len(detections) == 0:
            return detections
        centroid = np.mean(np.concatenate(self.buffer), axis=0)
        return detections[[int(np.argmin(np.linalg.norm(xy - centroid, axis=1)))]]


def make_tracker(effective_fps: float, lost_seconds: float = 3.0) -> sv.ByteTrack:
    """ByteTrack ajustado al fps real de análisis (video_fps / stride).

    En supervision, max_time_lost = frame_rate/30 * lost_track_buffer frames, así que
    lost_track_buffer = 30 * segundos da `lost_seconds` de memoria sin importar el fps.
    """
    return sv.ByteTrack(
        frame_rate=max(int(round(effective_fps)), 1),
        lost_track_buffer=int(lost_seconds * 30),
        minimum_consecutive_frames=3,
    )


def collect_player_crops(video_path, models: Models, *, fit_stride_frames: int = 60,
                         max_crops: int = 1500) -> list:
    """Recortes de jugadoras para ajustar el clasificador de equipos."""
    crops: list = []
    for frame in sv.get_video_frames_generator(str(video_path), stride=fit_stride_frames):
        if is_black_frame(frame):
            continue
        det = models.detect_people(frame)
        players = det[det.class_id == PLAYER_CLASS_ID]
        crops += [sv.crop_image(frame, xyxy) for xyxy in players.xyxy]
        if len(crops) >= max_crops:
            break
    return crops


def resolve_goalkeeper_clusters(players_xy: np.ndarray, players_cluster: np.ndarray,
                                gk_xy: np.ndarray) -> np.ndarray:
    """Asigna cada portera al equipo cuyo centroide (en píxeles) esté más cerca. -1 si no se puede."""
    out = []
    cents = {}
    for c in (0, 1):
        pts = players_xy[players_cluster == c] if len(players_xy) else np.zeros((0, 2))
        cents[c] = pts.mean(axis=0) if len(pts) else None
    for g in gk_xy:
        d = [np.linalg.norm(g - cents[c]) if cents[c] is not None else np.inf for c in (0, 1)]
        out.append(-1 if np.isinf(min(d)) else int(np.argmin(d)))
    return np.array(out, dtype=int)


def _in_pitch(xy: np.ndarray) -> np.ndarray:
    return ((xy[:, 0] >= -MARGIN_M) & (xy[:, 0] <= PITCH_LENGTH_M + MARGIN_M)
            & (xy[:, 1] >= -MARGIN_M) & (xy[:, 1] <= PITCH_WIDTH_M + MARGIN_M))


def _draw_preview(frame, boxes, ids, teams, ball_px, status, radar_pts):
    img = frame.copy()
    for (x1, y1, x2, y2), tid, team in zip(boxes, ids, teams):
        color = TEAM_COLORS_BGR[team]
        cx, cy, w = int((x1 + x2) / 2), int(y2), max(int(x2 - x1), 6)
        cv2.ellipse(img, (cx, cy), (w // 2, max(w // 5, 3)), 0, -45, 235, color, 2)
        cv2.putText(img, str(tid), (cx - 8, int(y2) + 18), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 2)
    if ball_px is not None:
        cv2.circle(img, (int(ball_px[0]), int(ball_px[1])), 7, (255, 255, 255), 2)
    cv2.putText(img, status, (12, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)
    # mini radar
    s, rw, rh = 3.0, int(PITCH_LENGTH_M * 3.0), int(PITCH_WIDTH_M * 3.0)
    radar = np.full((rh, rw, 3), (40, 90, 40), dtype=np.uint8)
    cv2.rectangle(radar, (0, 0), (rw - 1, rh - 1), (220, 220, 220), 1)
    cv2.line(radar, (rw // 2, 0), (rw // 2, rh), (220, 220, 220), 1)
    cv2.circle(radar, (rw // 2, rh // 2), int(9.15 * s), (220, 220, 220), 1)
    for (x, y), team in radar_pts:
        cv2.circle(radar, (int(x * s), int(y * s)), 4, TEAM_COLORS_BGR[team], -1)
    h, w = img.shape[:2]
    y0, x0 = h - rh - 8, (w - rw) // 2
    if y0 >= 0 and x0 >= 0:
        roi = img[y0:y0 + rh, x0:x0 + rw]
        img[y0:y0 + rh, x0:x0 + rw] = cv2.addWeighted(roi, 0.4, radar, 0.6, 0)
    return img


def run_segment(
    video_path, segment_id: str, segment_start_s: float, models: Models, *,
    match_id: str, own_cluster: int | None = None, stride: int = 3,
    pitch_conf_min: float = 0.5, min_keypoints: int = 6, ball_gap_frames: int = 5,
    max_camera_speed_mps: float = 20.0, reset_after_rejects: int = 5,
    preview_path=None, max_frames: int | None = None, out_dir=None,
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, dict]:
    """Procesa un segmento. Devuelve (tracking, ball, calib, stats) y, si out_dir, guarda parquets.

    own_cluster: cuál de los clusters 0/1 del clasificador es tu equipo (obligatorio si hay team_predict).
    stride: se procesa 1 de cada `stride` frames; `frame` en las tablas siempre es el índice original.
    """
    if models.team_predict is not None and own_cluster not in (0, 1):
        raise ValueError("own_cluster debe ser 0 o 1 (mira los recortes de cada cluster y elige el de tu equipo)")

    t0 = time.time()
    info = sv.VideoInfo.from_video_path(str(video_path))
    fps = float(info.fps)
    W, Hh = info.resolution_wh
    tracker = make_tracker(fps / stride)
    ball_tracker = SimpleBallTracker()
    stack = contextlib.ExitStack()
    sink = None
    if preview_path is not None:
        Path(preview_path).parent.mkdir(parents=True, exist_ok=True)
        sink = stack.enter_context(
            sv.VideoSink(str(preview_path), sv.VideoInfo(width=W, height=Hh, fps=max(int(round(fps / stride)), 1))))

    def team_label(cluster: int) -> str:
        if cluster < 0 or own_cluster is None:
            return "unk"
        return "own" if cluster == own_cluster else "opp"

    rows, ball_rows, calib_rows = [], [], []
    n_proc = n_black = n_oob = 0
    last_center, last_t, consecutive_rejects = None, None, 0   # chequeo de salto temporal de la cámara

    gen = sv.get_video_frames_generator(str(video_path), stride=stride)
    try:
        for i, frame in enumerate(gen):
            if max_frames is not None and i >= max_frames:
                break
            frame_no = i * stride
            t_local = frame_no / fps
            t_video = segment_start_s + t_local
            if is_black_frame(frame):
                n_black += 1
                continue
            n_proc += 1

            # --- calibración ---
            kp_xy, kp_conf = models.detect_pitch(frame)
            cal = fit_homography(kp_xy, models.pitch_vertices_m, kp_conf, conf_min=pitch_conf_min,
                                 min_points=min_keypoints, image_wh=(W, Hh))
            if cal.H is not None:
                # La cámara se mueve de forma suave: el centro de la imagen no puede saltar decenas de metros
                center = project(cal.H, np.array([[W / 2, Hh / 2]], dtype=np.float32))[0]
                if last_center is not None and consecutive_rejects < reset_after_rejects:
                    limit = max_camera_speed_mps * (t_video - last_t) + 3.0
                    if np.linalg.norm(center - last_center) > limit:
                        cal = Calibration(None, cal.n_keypoints, cal.n_inliers, "salto_temporal")
                if cal.H is not None:
                    last_center, last_t, consecutive_rejects = center, t_video, 0
                else:
                    consecutive_rejects += 1
            else:
                consecutive_rejects += 1
            if cal.H is not None:
                fov = image_corners_in_pitch(cal.H, W, Hh).reshape(-1)
                h_flat = cal.H.reshape(-1)
            else:
                fov, h_flat = np.full(8, np.nan), np.full(9, np.nan)
            calib_rows.append([segment_id, frame_no, t_video, cal.n_keypoints, cal.n_inliers,
                               cal.H is not None, cal.reason, *h_flat, *fov])

            # --- personas ---
            det = models.detect_people(frame)
            det = det[det.class_id != BALL_CLASS_ID]
            det = tracker.update_with_detections(det)
            det = det[det.tracker_id != -1] if len(det) and det.tracker_id is not None else det

            players = det[det.class_id == PLAYER_CLASS_ID]
            gks = det[det.class_id == GOALKEEPER_CLASS_ID]
            refs = det[det.class_id == REFEREE_CLASS_ID]
            p_xy = players.get_anchors_coordinates(sv.Position.BOTTOM_CENTER)
            g_xy = gks.get_anchors_coordinates(sv.Position.BOTTOM_CENTER)
            r_xy = refs.get_anchors_coordinates(sv.Position.BOTTOM_CENTER)

            if models.team_predict is not None and len(players):
                p_cl = np.asarray(models.team_predict([sv.crop_image(frame, b) for b in players.xyxy]), dtype=int)
            else:
                p_cl = np.full(len(players), -1, dtype=int)
            g_cl = resolve_goalkeeper_clusters(p_xy, p_cl, g_xy) if models.team_predict is not None \
                else np.full(len(gks), -1, dtype=int)

            all_det = sv.Detections.merge([players, gks, refs]) if len(det) else det
            all_xy = np.vstack([p_xy, g_xy, r_xy]) if len(det) else np.zeros((0, 2))
            labels = [team_label(c) for c in p_cl] + [team_label(c) for c in g_cl] + ["ref"] * len(refs)

            if cal.H is not None and len(all_xy):
                pitch_xy = project(cal.H, all_xy)
                oob = ~_in_pitch(pitch_xy)
                n_oob += int(oob.sum())
                pitch_xy[oob] = np.nan
            else:
                pitch_xy = np.full((len(all_xy), 2), np.nan)

            radar_pts = []
            for k in range(len(all_det)):
                conf = float(all_det.confidence[k]) if all_det.confidence is not None else np.nan
                rows.append([match_id, segment_id, frame_no, t_local, t_video, int(all_det.tracker_id[k]),
                             labels[k], pd.NA, pitch_xy[k, 0], pitch_xy[k, 1], conf,
                             float(all_xy[k, 0]), float(all_xy[k, 1])])
                if not np.isnan(pitch_xy[k, 0]):
                    radar_pts.append((pitch_xy[k], labels[k]))

            # --- balón ---
            ball_px = None
            bx = by = bconf = np.nan
            bpx = bpy = np.nan
            if models.detect_ball is not None:
                bd = ball_tracker.update(models.detect_ball(frame))
                if len(bd):
                    ball_px = bd.get_anchors_coordinates(sv.Position.BOTTOM_CENTER)[0]
                    bpx, bpy = float(ball_px[0]), float(ball_px[1])
                    bconf = float(bd.confidence[0]) if bd.confidence is not None else np.nan
                    if cal.H is not None:
                        bxy = project(cal.H, ball_px[None, :])[0]
                        if _in_pitch(bxy[None, :])[0]:
                            bx, by = float(bxy[0]), float(bxy[1])
            ball_rows.append([match_id, segment_id, frame_no, t_local, t_video, bx, by, bconf, False, bpx, bpy])

            if sink is not None:
                status = f"t={t_video:.1f}s  keypoints={cal.n_keypoints}  H={'ok' if cal.H is not None else 'NO (' + cal.reason + ')'}"
                sink.write_frame(_draw_preview(frame, all_det.xyxy if len(det) else [], 
                                               all_det.tracker_id if len(det) else [], labels, ball_px, status, radar_pts))
    finally:
        stack.close()

    tracking = pd.DataFrame(rows, columns=["match_id", "segment_id", "frame", "t_local", "t_video", "track_id",
                                           "team", "player_id", "x", "y", "conf", "px", "py"])
    tracking["player_id"] = tracking["player_id"].astype("string")
    tracking = tracking.astype({"frame": "int64", "track_id": "int64"})

    ball = pd.DataFrame(ball_rows, columns=["match_id", "segment_id", "frame", "t_local", "t_video",
                                            "x", "y", "conf", "interpolated", "px", "py"])
    missing = ball[["x", "y"]].isna().any(axis=1)
    filled = ball[["x", "y"]].interpolate(limit=ball_gap_frames, limit_area="inside")
    newly = missing & filled.notna().all(axis=1)
    ball[["x", "y"]] = filled
    ball["interpolated"] = newly.to_numpy()

    calib = pd.DataFrame(calib_rows, columns=[
        "segment_id", "frame", "t_video", "n_keypoints", "n_inliers", "ok", "reason",
        *[f"h{i}" for i in range(9)], *[f"fov{i}" for i in range(8)]])

    validate_tracking(tracking)
    validate_ball(ball)

    elapsed = time.time() - t0
    track_len = tracking.groupby("track_id")["frame"].nunique() * stride / fps if len(tracking) else pd.Series(dtype=float)
    stats = {
        "frames_procesados": n_proc, "frames_negros_saltados": n_black,
        "segundos_de_video_procesados": round(n_proc * stride / fps, 1),
        "pct_homografia_ok": round(100 * float(calib["ok"].mean()), 1) if len(calib) else 0.0,
        "keypoints_visibles_mediana": float(calib["n_keypoints"].median()) if len(calib) else 0.0,
        "tracks_totales": int(tracking["track_id"].nunique()),
        "duracion_track_mediana_s": round(float(track_len.median()), 1) if len(track_len) else 0.0,
        "pct_filas_con_posicion": round(100 * float(tracking["x"].notna().mean()), 1) if len(tracking) else 0.0,
        "pct_filas_equipo_asignado": round(100 * float((tracking["team"].isin(["own", "opp"])).mean()), 1) if len(tracking) else 0.0,
        "pct_frames_con_balon": round(100 * float(ball["px"].notna().mean()), 1) if len(ball) else 0.0,
        "posiciones_fuera_de_cancha_descartadas": n_oob,
        "segundos_de_computo": round(elapsed, 1),
        "seg_computo_por_seg_de_video": round(elapsed / max(n_proc * stride / fps, 1e-9), 2),
    }

    if out_dir is not None:
        out = Path(out_dir)
        out.mkdir(parents=True, exist_ok=True)
        tracking.to_parquet(out / f"tracking_{segment_id}.parquet", index=False)
        ball.to_parquet(out / f"ball_{segment_id}.parquet", index=False)
        calib.to_parquet(out / f"calib_{segment_id}.parquet", index=False)
    return tracking, ball, calib, stats

"""Geometría: homografía imagen -> cancha (metros) a partir de keypoints de la cancha.

La cámara de este proyecto es de seguimiento automático (se mueve y hace zoom), así que
la homografía se calcula frame por frame y muchas veces solo se ven pocos keypoints.
"""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from ..schema import PITCH_LENGTH_M, PITCH_WIDTH_M


def scale_vertices_to_meters(vertices, cfg_length: float, cfg_width: float) -> np.ndarray:
    """Reescala los vértices de la configuración de Roboflow (cm, cancha 120x70) a 105x68 m.

    Los bordes de la cancha quedan exactos; los puntos interiores (áreas) son una
    aproximación porque Roboflow usa medidas de áreas distintas a las reglamentarias.
    """
    v = np.asarray(vertices, dtype=np.float32)
    scale = np.array([PITCH_LENGTH_M / cfg_length, PITCH_WIDTH_M / cfg_width], dtype=np.float32)
    return v * scale


@dataclass
class Calibration:
    H: np.ndarray | None      # imagen (px) -> cancha (m); None si falló
    n_keypoints: int          # keypoints visibles y confiables
    n_inliers: int
    reason: str               # "ok" o motivo del fallo


FOV_AREA_RANGE_M2 = (30.0, 20000.0)


def fov_is_plausible(H: np.ndarray, width: int, height: int) -> bool:
    """El campo de visión proyectado debe ser un cuadrilátero convexo de tamaño razonable.

    Una homografía mala (pocos keypoints, uno mal ubicado) suele dar polígonos retorcidos o gigantes.
    """
    poly = image_corners_in_pitch(H, width, height)
    if not np.isfinite(poly).all():
        return False
    area = cv2.contourArea(poly.astype(np.float32))
    return bool(cv2.isContourConvex(poly.astype(np.float32).reshape(-1, 1, 2))
                and FOV_AREA_RANGE_M2[0] <= area <= FOV_AREA_RANGE_M2[1])


def fit_homography(
    src_px: np.ndarray,
    dst_m: np.ndarray,
    conf: np.ndarray,
    *,
    conf_min: float = 0.5,
    min_points: int = 4,
    ransac_thresh_m: float = 1.0,
    min_hull_frac: float = 0.02,
    image_wh: tuple[int, int] | None = None,
) -> Calibration:
    """Homografía robusta (RANSAC). Devuelve H=None, con el motivo, si no es confiable.

    Con pocos keypoints RANSAC no puede descartar uno mal ubicado (ver docs/data_contract.md),
    por eso, si se da image_wh, también se exige que el campo de visión proyectado sea plausible.
    """
    src_px = np.asarray(src_px, dtype=np.float32).reshape(-1, 2)
    conf = np.asarray(conf, dtype=np.float32).reshape(-1)
    if len(src_px) == 0 or len(src_px) != len(dst_m):
        return Calibration(None, 0, 0, "sin_keypoints")

    visible = (conf >= conf_min) & (src_px[:, 0] > 1) & (src_px[:, 1] > 1)
    n = int(visible.sum())
    if n < min_points:
        return Calibration(None, n, 0, "pocos_keypoints")

    src, dst = src_px[visible], np.asarray(dst_m, dtype=np.float32)[visible]
    hull_area = cv2.contourArea(cv2.convexHull(dst))
    if hull_area < min_hull_frac * PITCH_LENGTH_M * PITCH_WIDTH_M:
        return Calibration(None, n, 0, "puntos_casi_colineales")

    H, inliers = cv2.findHomography(src, dst, cv2.RANSAC, ransac_thresh_m)
    if H is None or inliers is None or int(inliers.sum()) < min_points:
        return Calibration(None, n, 0 if inliers is None else int(inliers.sum()), "ransac_fallo")
    H = H.astype(np.float64)
    if image_wh is not None and not fov_is_plausible(H, *image_wh):
        return Calibration(None, n, int(inliers.sum()), "fov_implausible")
    return Calibration(H, n, int(inliers.sum()), "ok")


def project(H: np.ndarray, points_px: np.ndarray) -> np.ndarray:
    pts = np.asarray(points_px, dtype=np.float32).reshape(-1, 1, 2)
    if len(pts) == 0:
        return np.zeros((0, 2), dtype=np.float32)
    return cv2.perspectiveTransform(pts, H.astype(np.float64)).reshape(-1, 2)


def image_corners_in_pitch(H: np.ndarray, width: int, height: int) -> np.ndarray:
    """Las 4 esquinas de la imagen proyectadas a la cancha (m): campo de visión aproximado."""
    corners = np.array([[0, 0], [width, 0], [width, height], [0, height]], dtype=np.float32)
    return project(H, corners)


def is_black_frame(frame: np.ndarray, threshold: float = 8.0) -> bool:
    """Frame casi negro (corte a negro de la transmisión)."""
    return float(frame.mean()) < threshold

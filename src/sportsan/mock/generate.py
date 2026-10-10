"""Datos falsos que cumplen el contrato, para desarrollar la UI y las métricas sin esperar el tracking.

    python -m sportsan.mock.generate
Escribe data/mock/{tracking,ball,events}_mock.parquet
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from ..config import load_config, project_root
from ..schema import (PITCH_LENGTH_M, PITCH_WIDTH_M, validate_ball,
                      validate_events, validate_tracking)

# Formación 4-3-3 (equipo propio ataca hacia +x). (x, y) en metros.
_OWN = [(6, 34), (25, 12), (25, 26), (25, 42), (25, 56), (45, 18), (45, 34), (45, 50),
        (62, 14), (62, 34), (62, 54)]


def generate(out_dir: str | Path | None = None, duration_s: int = 120, video_fps: int = 25,
             stride: int = 5, seed: int = 7, segment_start_s: float = 600.0,
             match_id: str = "mock_01", segment_id: str = "mock_s01") -> Path:
    rng = np.random.default_rng(seed)
    root = project_root()
    out = Path(out_dir) if out_dir else root / load_config()["paths"]["mock_dir"]
    out.mkdir(parents=True, exist_ok=True)

    frames = np.arange(0, duration_s * video_fps, stride)
    n = len(frames)
    t_local = frames / video_fps
    t_video = segment_start_s + t_local

    own_base = np.array(_OWN, dtype=float)
    opp_base = np.column_stack([PITCH_LENGTH_M - own_base[:, 0], PITCH_WIDTH_M - own_base[:, 1]])
    base = np.vstack([own_base, opp_base])                       # 22 x 2
    team_labels = np.array(["own"] * 11 + ["opp"] * 11)

    # Deriva compartida por equipo + ruido AR(1) individual
    drift = 8 * np.sin(2 * np.pi * t_local / 40)[:, None]        # n x 1
    noise = np.zeros((n, 22, 2))
    for i in range(1, n):
        noise[i] = 0.97 * noise[i - 1] + rng.normal(0, 0.6, (22, 2))
    pos = base[None, :, :] + noise
    pos[:, :11, 0] += drift
    pos[:, 11:, 0] += drift * 0.7
    pos[:, :, 0] = np.clip(pos[:, :, 0], 0, PITCH_LENGTH_M)
    pos[:, :, 1] = np.clip(pos[:, :, 1], 0, PITCH_WIDTH_M)

    rows = []
    for k in range(22):
        rows.append(pd.DataFrame({
            "match_id": match_id, "segment_id": segment_id, "frame": frames,
            "t_local": t_local, "t_video": t_video, "track_id": k + 1,
            "team": team_labels[k], "player_id": pd.NA,
            "x": pos[:, k, 0], "y": pos[:, k, 1],
            "conf": rng.uniform(0.6, 0.99, n),
        }))
    tracking = pd.concat(rows, ignore_index=True)
    tracking["player_id"] = tracking["player_id"].astype("string")

    # Balón: sigue a una jugadora distinta cada ~3 s, suavizado
    block = 15
    holder = rng.integers(0, 22, size=n // block + 1).repeat(block)[:n]
    ball_xy = pos[np.arange(n), holder, :] + rng.normal(0, 0.4, (n, 2))
    ball_xy = pd.DataFrame(ball_xy).rolling(5, min_periods=1, center=True).mean().to_numpy()
    ball = pd.DataFrame({
        "match_id": match_id, "segment_id": segment_id, "frame": frames,
        "t_local": t_local, "t_video": t_video,
        "x": np.clip(ball_xy[:, 0], 0, PITCH_LENGTH_M),
        "y": np.clip(ball_xy[:, 1], 0, PITCH_WIDTH_M),
        "conf": rng.uniform(0.4, 0.95, n), "interpolated": rng.random(n) < 0.15,
    })

    # Eventos manuales de ejemplo
    kinds = [("shot", "own"), ("corner", "own"), ("foul", "opp"),
             ("loss", "own"), ("goal", "opp"), ("throw_in", "own")]
    idx = np.sort(rng.choice(np.arange(10, n - 10), size=len(kinds), replace=False))
    events = pd.DataFrame({
        "event_id": [f"mock_e{i+1}" for i in range(len(kinds))],
        "match_id": match_id,
        "t_video": t_video[idx],
        "period": 1,
        "type": [k[0] for k in kinds],
        "team": [k[1] for k in kinds],
        "player_id": pd.Series([pd.NA] * len(kinds), dtype="string"),
        "x": ball["x"].to_numpy()[idx], "y": ball["y"].to_numpy()[idx],
        "outcome": pd.Series([pd.NA] * len(kinds), dtype="string"),
        "note": ["evento de ejemplo"] * len(kinds),
    })

    validate_tracking(tracking); validate_ball(ball); validate_events(events)
    tracking.to_parquet(out / "tracking_mock.parquet", index=False)
    ball.to_parquet(out / "ball_mock.parquet", index=False)
    events.to_parquet(out / "events_mock.parquet", index=False)
    return out


if __name__ == "__main__":
    print("Datos de prueba escritos en", generate())

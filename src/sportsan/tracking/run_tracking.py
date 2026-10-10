"""CLI de tracking para un segmento (Colab/Kaggle).

    python -m sportsan.tracking.run_tracking --segment s03 --own-cluster 0 --weights-dir /content/weights

El notebook notebooks/tracking_test.ipynb hace lo mismo paso a paso y deja elegir el cluster
de tu equipo mirando los recortes. Contrato de salida: docs/data_contract.md.
"""
from __future__ import annotations

import argparse

from ..config import load_config, project_root
from ..timebase import load_segments
from .models import load_models
from .pipeline import collect_player_crops, run_segment


def run(segment_id: str, own_cluster: int, weights_dir: str, *, device: str = "cuda", stride: int | None = None,
        preview: bool = True, config_path: str | None = None, max_frames: int | None = None,
        match: str | None = None):
    cfg, root = load_config(config_path, match), project_root()
    seg = load_segments(root / cfg["paths"]["segments_csv"]).set_index("segment_id").loc[segment_id]
    video = root / cfg["paths"]["segments_dir"] / f"{segment_id}.mp4"
    models = load_models(weights_dir, device)
    models.team_fit(collect_player_crops(video, models))
    return run_segment(
        video, segment_id, float(seg["start_s"]), models, match_id=cfg["match_id"], own_cluster=own_cluster,
        stride=stride or int(cfg.get("analysis_stride", 3)), max_frames=max_frames,
        preview_path=(root / cfg["paths"]["match_dir"] / "preview" / f"{segment_id}.mp4") if preview else None,
        out_dir=root / cfg["paths"]["tracking_dir"],
    )


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--match", default=None, help="match_id (carpeta en matches/)")
    ap.add_argument("--segment", required=True)
    ap.add_argument("--own-cluster", type=int, required=True, choices=[0, 1])
    ap.add_argument("--weights-dir", required=True)
    ap.add_argument("--device", default="cuda")
    ap.add_argument("--stride", type=int, default=None)
    ap.add_argument("--no-preview", action="store_true")
    a = ap.parse_args()
    *_, stats = run(a.segment, a.own_cluster, a.weights_dir, device=a.device, stride=a.stride, preview=not a.no_preview,
                    match=a.match)
    for k, v in stats.items():
        print(f"{k}: {v}")

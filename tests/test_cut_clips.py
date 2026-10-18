"""Clips del informe (sportsan.clips.cut_clips). Datos sintéticos, sin nombres reales."""
import json
import shutil
from pathlib import Path

import pytest

from sportsan.clips import cut_clips as cc


def test_plan_renderiza_los_editados_y_corta_los_demas(tmp_path):
    (tmp_path / "edits").mkdir()
    (tmp_path / "edits" / "edit_c1.json").write_text("{}", encoding="utf-8")
    clips = [
        {"clip_id": "tr_e1", "video_id": "v1", "t_start": 97, "t_end": 110, "edit_id": "c1"},
        {"clip_id": "play_p1", "video_id": "v1", "t_start": 600, "t_end": 612, "edit_id": None},
        {"clip_id": "play_p2", "video_id": "v2", "t_start": 10, "t_end": 20, "edit_id": "c_sin_archivo"},
    ]
    plan = cc.plan_clips(clips, tmp_path, "whatsapp")
    assert [p["action"] for p in plan] == ["render", "cut", "cut"]
    assert plan[0]["out"] == tmp_path / "clips" / "c1_whatsapp.mp4"
    assert plan[1]["out"] == tmp_path / "clips" / "play_p1_whatsapp.mp4"
    # Una edición que no se guardó en la carpeta no se inventa: el clip sale sin dibujos, con aviso.
    assert plan[2]["missing_edit"] == "c_sin_archivo"


def test_argumentos_del_corte():
    a = cc.cut_args("ffmpeg", Path("v1.mp4"), 97, 110.5, "whatsapp", Path("o.mp4"))
    assert a[a.index("-ss") + 1] == "97.000" and a[a.index("-to") + 1] == "110.500"
    assert a[a.index("-vf") + 1] == "scale=-2:'min(720,ih)'"
    assert a[a.index("-b:v") + 1] == "1500k" and a[a.index("-movflags") + 1] == "+faststart" and "-an" in a


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="sin ffmpeg")
def test_corta_un_clip_de_un_video_sintetico(tmp_path, monkeypatch):
    cv2 = pytest.importorskip("cv2")
    import numpy as np

    folder = tmp_path / "matches" / "2026_10_10_equipo_a_vs_equipo_b"
    (folder / "video").mkdir(parents=True)
    vw = cv2.VideoWriter(str(folder / "video" / "v1.mp4"), cv2.VideoWriter_fourcc(*"mp4v"), 30, (320, 180))
    for i in range(90):
        vw.write(np.full((180, 320, 3), (40, 100 + i, 40), np.uint8))
    vw.release()
    (folder / "clips_m1.json").write_text(json.dumps({"kind": "clips", "clips": [{"clip_id": "play_p1", "kind": "play", "title": "Salida", "video_id": "v1", "t_start": 1.0, "t_end": 2.0, "edit_id": None}]}), encoding="utf-8")
    monkeypatch.setattr(cc, "project_root", lambda: tmp_path)
    out = cc.cut_clips(folder.name, "charla")
    assert out == [folder / "clips" / "play_p1_charla.mp4"] and out[0].exists()
    cap = cv2.VideoCapture(str(out[0]))
    assert abs(int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) - 30) <= 1

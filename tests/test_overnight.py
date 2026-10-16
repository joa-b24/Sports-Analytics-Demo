import pytest

from sportsan import config
from sportsan.tracking.overnight import plan_video


@pytest.fixture
def repo(tmp_path, monkeypatch):
    (tmp_path / "config").mkdir()
    (tmp_path / "config" / "project.yaml").write_text("default_match: m1\n", encoding="utf-8")
    d = tmp_path / "matches" / "m1"
    (d / "video").mkdir(parents=True)
    (d / "tracking").mkdir()
    (d / "match.yaml").write_text(
        "match_id: m1\nanalysis_stride: 3\nvideos:\n"
        "  - {video_id: v1, file: video/v1.mp4, fps: 30}\n"
        "  - {video_id: v2, file: video/v2.mp4, fps: 30}\n", encoding="utf-8")
    monkeypatch.setattr(config, "project_root", lambda: tmp_path)
    return tmp_path


def test_lo_que_falta_a_cada_video(repo):
    d = repo / "matches" / "m1"
    assert plan_video(repo, "m1", "v1").missing == "video sin descargar"
    (d / "video" / "v1.mp4").write_bytes(b"x")
    assert "tramos" in plan_video(repo, "m1", "v1").missing
    (d / "segments.csv").write_text("segment_id,video_id,start,end,tipo\ns01,v1,00:01:00,00:11:00,juego\ns02,v1,00:11:00,00:12:00,pausa\n", encoding="utf-8")
    p = plan_video(repo, "m1", "v1")
    assert "anclas" in p.missing and p.play_s == 600
    (d / "tracking" / "anchors_m1_v1.json").write_text("{}", encoding="utf-8")
    p = plan_video(repo, "m1", "v1")
    assert p.missing is None and p.steps == ["propagate", "library", "process"]
    assert p.estimate_s() == pytest.approx(600 * 3.5 + 300)
    (d / "tracking" / "library_v1.npz").write_bytes(b"x")
    assert plan_video(repo, "m1", "v1").steps == ["process"]
    # Con todas sus partes hechas, no queda nada que procesar.
    (d / "tracking" / "tracks_v1_1800_19800.json").write_text("{}", encoding="utf-8")
    (d / "tracking" / "tracks_v1_index.json").write_text(
        '{"chunks": [{"file": "tracks_v1_1800_19800.json", "start_s": 60, "end_s": 660, "calibrated_share": 1}]}', encoding="utf-8")
    assert plan_video(repo, "m1", "v1").steps == []
    assert "sin descargar" in plan_video(repo, "m1", "v3").missing

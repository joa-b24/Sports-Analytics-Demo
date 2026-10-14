import pytest

from sportsan import config


@pytest.fixture
def repo(tmp_path, monkeypatch):
    (tmp_path / "config").mkdir()
    (tmp_path / "config" / "project.yaml").write_text("default_match: m1\n", encoding="utf-8")
    for mid, fps in (("m1", 30), ("m2", 60)):
        d = tmp_path / "matches" / mid
        d.mkdir(parents=True)
        (d / "match.yaml").write_text(
            f"match_id: {mid}\nvideos:\n"
            f"  - {{video_id: v1, youtube_id: abc, file: video/v1.mp4, fps: {fps}}}\n"
            f"  - {{video_id: v2, youtube_id: def, file: video/v2.mp4, fps: {fps}}}\n", encoding="utf-8")
    monkeypatch.setattr(config, "project_root", lambda: tmp_path)
    monkeypatch.delenv("SPORTSAN_MATCH", raising=False)
    return tmp_path


def test_partido_por_defecto_y_rutas(repo):
    cfg = config.load_config()
    assert cfg["match_id"] == "m1" and cfg["video_fps"] == 30 and cfg["youtube_id"] == "abc"
    assert cfg["paths"]["raw_video"] == "matches/m1/video/v1.mp4"
    assert cfg["paths"]["segments_csv"] == "matches/m1/segments.csv"
    assert cfg["paths"]["mock_dir"] == "data/mock"


def test_elegir_partido_y_video(repo, monkeypatch):
    cfg = config.load_config(match="m2", video="v2")
    assert cfg["match_id"] == "m2" and cfg["video_fps"] == 60
    assert cfg["paths"]["raw_video"] == "matches/m2/video/v2.mp4"
    monkeypatch.setenv("SPORTSAN_MATCH", "m2")
    assert config.load_config()["match_id"] == "m2"
    assert config.list_matches() == ["m1", "m2"]


def test_errores(repo):
    with pytest.raises(FileNotFoundError):
        config.load_config(match="no_existe")
    with pytest.raises(ValueError):
        config.load_config(match="m1", video="v9")
    (repo / "matches" / "m1" / "match.yaml").write_text("match_id: otro\nvideos: []\n", encoding="utf-8")
    with pytest.raises(ValueError):
        config.load_config(match="m1")


def test_colores_del_video_o_del_partido(repo):
    (repo / "matches" / "m1" / "match.yaml").write_text(
        "match_id: m1\njersey_colors: {own: '#111111'}\nvideos:\n"
        "  - {video_id: v1, file: video/v1.mp4, fps: 30, jersey_colors: {own: '#084b9f', opp: '#020202'}}\n"
        "  - {video_id: v2, file: video/v2.mp4, fps: 30}\n", encoding="utf-8")
    assert config.load_config()["jersey_colors"] == {"own": "#084b9f", "opp": "#020202"}
    assert config.load_config(video="v2")["jersey_colors"] == {"own": "#111111"}
    assert config.load_config(match="m2")["jersey_colors"] == {}

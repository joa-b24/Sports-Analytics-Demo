import pytest

from sportsan.timebase import frame_to_video_time, load_segments, parse_hms


def test_parse_hms():
    assert parse_hms("00:03:12") == 192
    assert parse_hms("3:12") == 192
    assert parse_hms("1:02:03.5") == 3723.5
    assert parse_hms(45) == 45.0


def test_frame_to_video_time():
    assert frame_to_video_time(600.0, 50, 25) == 602.0


def test_segments_end_antes_de_start(tmp_path):
    p = tmp_path / "s.csv"
    p.write_text("segment_id,start,end,tipo\ns01,00:10:00,00:05:00,juego\n", encoding="utf-8")
    with pytest.raises(ValueError):
        load_segments(p)


def test_load_segments_ok(tmp_path):
    p = tmp_path / "s.csv"
    p.write_text("segment_id,start,end,tipo\ns01,00:03:12,00:11:40,juego\n", encoding="utf-8")
    df = load_segments(p)
    assert df.loc[0, "duration_s"] == 508


def test_segments_de_varios_videos(tmp_path):
    p = tmp_path / "segments.csv"
    p.write_text(
        "segment_id,video_id,start,end,tipo\n"
        "s01,v1,00:00:00,00:03:00,pausa\n"
        "s02,v1,00:03:00,00:48:00,juego\n"
        "s03,v2,00:00:20,00:45:20,juego\n",
        encoding="utf-8",
    )
    todos = load_segments(p)
    assert list(todos["video_id"]) == ["v1", "v1", "v2"]
    solo_v2 = load_segments(p, video_id="v2")
    assert list(solo_v2["segment_id"]) == ["s03"]
    assert solo_v2.loc[0, "start_s"] == 20  # tiempo dentro del segundo video, no del partido


def test_segments_sin_columna_de_video_son_del_primero(tmp_path):
    p = tmp_path / "segments.csv"
    p.write_text("segment_id,start,end,tipo\ns01,00:04:14,00:07:09,juego\n", encoding="utf-8")
    assert list(load_segments(p)["video_id"]) == ["v1"]
    assert len(load_segments(p, video_id="v2")) == 0


def test_segment_id_repetido_entre_videos_falla(tmp_path):
    p = tmp_path / "segments.csv"
    p.write_text("segment_id,video_id,start,end,tipo\ns01,v1,0:00,1:00,juego\ns01,v2,0:00,1:00,juego\n", encoding="utf-8")
    with pytest.raises(ValueError, match="repetido"):
        load_segments(p)

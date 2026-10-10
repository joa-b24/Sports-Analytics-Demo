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

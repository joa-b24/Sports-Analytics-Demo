import json

import pytest

from sportsan.ingest.renumber_videos import map_csv, map_json, map_name, map_yaml, parse_map, renumber

YAML = """match_id: m1
videos:
  - video_id: v1
    youtube_id: "AAA"
    file: video/v1.mp4
    fps: 30
  - video_id: v2
    youtube_id: "BBB"
    file: video/v2.mp4
    fps: 25
"""


def make(tmp_path):
    root = tmp_path
    f = root / "matches" / "m1"
    (f / "tracking").mkdir(parents=True)
    (f / "video").mkdir()
    (f / "match.yaml").write_text(YAML, encoding="utf-8")
    (f / "segments.csv").write_text("segment_id,video_id,start,end,tipo\ns1,v1,0:00:10,0:20:00,juego\ns2,v2,0:00:05,0:10:00,juego\n", encoding="utf-8")
    (f / "video" / "v1.mp4").write_bytes(b"uno")
    (f / "video" / "v2.mp4").write_bytes(b"dos")
    (f / "tracking" / "tracks_v1_0_90.json").write_text(json.dumps({"video_id": "v1", "frames": []}), encoding="utf-8")
    (f / "tracking" / "tracks_v2_0_90.json").write_text(json.dumps({"video_id": "v2", "frames": []}), encoding="utf-8")
    (f / "tracking" / "anchors_m1_v1.json").write_text(json.dumps({"anchors": [{"video_id": "v1", "t_video": 3}], "part": "tracks_v1_0_90.json"}), encoding="utf-8")
    (root / "matches" / "videos.csv").write_text("match_id,kind,video_id,label\nm1,own,v1,uno\nm1,own,v2,dos\notro,own,v1,x\n", encoding="utf-8")
    return root, f


def test_parse_map():
    assert parse_map("v1=v2,v2=v1") == {"v1": "v2", "v2": "v1"}
    assert parse_map("v3=v2") == {"v3": "v2"}
    with pytest.raises(ValueError):
        parse_map("v1=v2,v3=v2")
    with pytest.raises(ValueError):
        parse_map("v1=v1")
    with pytest.raises(ValueError):
        parse_map("uno=dos")


def test_names_change_all_at_once():
    m = {"v1": "v2", "v2": "v1"}
    assert map_name("tracks_fixed_v1_0_9.json", m) == "tracks_fixed_v2_0_9.json"
    assert map_name("anchors_2026_11_07_a_vs_b_v2.json", m) == "anchors_2026_11_07_a_vs_b_v1.json"
    assert map_name("v1.mp4.part", m) == "v2.mp4.part"
    assert map_name("tracks_v3_0_9.json", m) == "tracks_v3_0_9.json"
    assert map_name("2026_11_07_tec_ccm_vs_x.json", m) == "2026_11_07_tec_ccm_vs_x.json"


def test_content_helpers():
    m = {"v1": "v2", "v2": "v1"}
    assert map_json({"video_id": "v1", "videos": ["v1", "v2"], "part": "tracks_v2_0_9.json", "n": "v1 es otra cosa"}, m) == {"video_id": "v2", "videos": ["v2", "v1"], "part": "tracks_v1_0_9.json", "n": "v1 es otra cosa"}
    y = map_yaml(YAML, m)
    assert "- video_id: v2\n    youtube_id: \"AAA\"\n    file: video/v2.mp4\n    fps: 30" in y
    assert map_csv("match_id,video_id\nm1,v1\notro,v1\n", m, only_match="m1").splitlines() == ["match_id,video_id", "m1,v2", "otro,v1"]


def test_swap_keeps_each_video_with_its_data(tmp_path):
    root, f = make(tmp_path)
    m = {"v1": "v2", "v2": "v1"}
    dry = renumber(root, "m1", m, dry_run=True)
    assert (f / "video" / "v1.mp4").read_bytes() == b"uno" and any("v1.mp4 -> v2.mp4" in x for x in dry)
    renumber(root, "m1", m)
    assert (f / "video" / "v2.mp4").read_bytes() == b"uno" and (f / "video" / "v1.mp4").read_bytes() == b"dos"
    assert json.loads((f / "tracking" / "tracks_v2_0_90.json").read_text())["video_id"] == "v2"
    anchors = json.loads((f / "tracking" / "anchors_m1_v2.json").read_text())
    assert anchors["anchors"][0]["video_id"] == "v2" and anchors["part"] == "tracks_v2_0_90.json"
    assert "s1,v2" in (f / "segments.csv").read_text() and "s2,v1" in (f / "segments.csv").read_text()
    assert "otro,own,v1" in (root / "matches" / "videos.csv").read_text()
    # A swap is its own inverse.
    renumber(root, "m1", m)
    assert (f / "video" / "v1.mp4").read_bytes() == b"uno"
    assert (f / "match.yaml").read_text(encoding="utf-8") == YAML


def test_a_free_target_and_a_collision(tmp_path):
    root, f = make(tmp_path)
    with pytest.raises(FileExistsError):
        renumber(root, "m1", {"v1": "v2"})  # v2 exists and is not moving
    (f / "video" / "v3.mp4").write_bytes(b"tres")
    (f / "tracking" / "tracks_v3_0_90.json").write_text("{}", encoding="utf-8")
    # v3 -> v4 is fine.
    renumber(root, "m1", {"v3": "v4"})
    assert (f / "video" / "v4.mp4").exists() and not (f / "video" / "v3.mp4").exists()

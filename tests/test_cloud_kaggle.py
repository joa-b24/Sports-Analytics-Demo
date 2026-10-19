"""Procesar en Kaggle (sportsan.cloud): nombres, qué se manda, qué se baja y el lado de Kaggle en seco. Sin red."""
import json
import zipfile
from pathlib import Path

import pytest

from sportsan.cloud import kaggle as kg
from sportsan.cloud import kaggle_job as job


def test_slugs_are_valid_kaggle_names():
    assert kg.data_slug("partido_ccm_vs_up") == "sportsan-partido-ccm-vs-up-datos"
    assert kg.video_slug("partido_ccm_vs_up", "v2") == "sportsan-partido-ccm-vs-up-v2"
    long = kg.kernel_slug("2026_10_25_universidad_del_valle_de_mexico_vs_tec_ccm")
    assert len(long) <= 50 and long.startswith("sportsan-tracking-") and long == long.lower()
    assert kg.kernel_slug("2026_10_25_universidad_del_valle_de_mexico_vs_tec_ccm") == long  # estable
    assert len(kg.slug("ab")) >= 6


def test_openvino_model_becomes_its_pytorch_weights():
    assert job.gpu_model_name("yolo11s_1280_openvino_model") == "yolo11s.pt"
    assert job.gpu_model_name("yolo11n_openvino_model") == "yolo11n.pt"
    assert job.gpu_model_name("yolo11s.pt") == "yolo11s.pt"
    yml = "venue: {}\ndetector: {model: yolo11s_1280_openvino_model, tiles: 2, band: auto}\n"
    assert "model: yolo11s.pt, tiles: 2" in job.patch_detector(yml)
    assert kg.detector_models(yml) == ["yolo11n.pt", "yolo11s.pt"]
    assert kg.detector_models("venue: {}\n") == ["yolo11n.pt"]


def test_tracking_files_only_of_the_videos_sent(tmp_path):
    t = tmp_path
    for n in ["anchors_m_v2.json", "anchors_m_v1.json", "calib_v2_10_20.json", "library_v2.npz", "tracks_v2_index.json",
              "tracks_v2_0_100.json", "tracks_fixed_v2_0_100.json", "tracking_v2_0_100.parquet", "tracks_v1_0_100.json",
              "labels_v2_0_100.json"]:
        (t / n).write_text("x")
    names = [p.name for p in kg.tracking_files(t, "m", ["v2"])]
    assert names == ["anchors_m_v2.json", "calib_v2_10_20.json", "library_v2.npz", "tracks_v2_index.json", "tracks_v2_0_100.json"]


def test_copy_back_never_overwrites_yours_except_the_index(tmp_path):
    (tmp_path / "tracks_v2_0_100.json").write_text("mío")
    (tmp_path / "tracks_v2_index.json").write_text("{}")
    (tmp_path / "library_v2.npz").write_text("igual")
    sizes = {"tracks_v2_0_100.json": 99, "tracks_v2_index.json": 50, "library_v2.npz": 5, "tracks_v2_100_200.json": 10}
    plan = dict(kg.copy_plan(list(sizes), tmp_path, sizes))
    assert plan == {"library_v2.npz": "skip", "tracks_v2_0_100.json": "skip", "tracks_v2_100_200.json": "copy", "tracks_v2_index.json": "index"}
    assert dict(kg.copy_plan(list(sizes), tmp_path, sizes, force=True))["tracks_v2_0_100.json"] == "replace"


def fake_repo(root: Path):
    m = root / "matches" / "m1"
    (m / "tracking").mkdir(parents=True)
    (m / "video").mkdir()
    (root / "config").mkdir()
    (root / "src" / "sportsan").mkdir(parents=True)
    (root / "src" / "sportsan" / "__init__.py").write_text("")
    (root / "pyproject.toml").write_text("[project]\nname='sportsan'\n")
    (root / "config" / "project.yaml").write_text("default_match: m1\n")
    (m / "match.yaml").write_text("match_id: m1\ndetector: {model: yolo11s_1280_openvino_model, tiles: 2}\n")
    (m / "segments.csv").write_text("segment_id,video_id,start,end,tipo\ns01,v2,00:00:00,00:01:00,juego\n")
    (root / "matches" / "videos.csv").write_text(
        "match_id,kind,date,own_team,other_team,video_id,period,label,url,note\n"
        "m1,own,,A,B,v1,1,x,https://y/1,\nm1,own,,A,B,v2,1,x,https://y/2,\notro,own,,A,B,v1,1,x,https://y/3,\n")
    (m / "tracking" / "anchors_m1_v2.json").write_text("{}")
    (m / "video" / "v2.mp4").write_bytes(b"\x00" * 100)


def test_data_zip_carries_only_this_match_and_its_videos(tmp_path):
    fake_repo(tmp_path)
    z = tmp_path / "data.zip"
    names = kg.build_data_zip(tmp_path, "m1", ["v2"], z)
    assert "tracking/anchors_m1_v2.json" in names
    with zipfile.ZipFile(z) as f:
        rows = f.read("matches/videos.csv").decode().strip().splitlines()
        assert rows[0].startswith("match_id,") and len(rows) == 2 and ",v2," in rows[1]
        assert "matches/m1/match.yaml" in f.namelist()


@pytest.mark.parametrize("extracted", [False, True])
def test_kaggle_side_builds_the_repo_and_patches_the_detector(tmp_path, extracted):
    repo = tmp_path / "repo"
    fake_repo(repo)
    stage = tmp_path / "stage"
    stage.mkdir()
    kg.build_code_zip(repo, stage / "code.zip", [])
    kg.build_data_zip(repo, "m1", ["v2"], stage / "data.zip")
    inp = tmp_path / "input"
    for slug, z in (("sportsan-code", "code.zip"), ("sportsan-m1-datos", "data.zip")):
        d = inp / slug
        d.mkdir(parents=True)
        if extracted:  # Kaggle ya lo descomprimió en una carpeta con su nombre
            with zipfile.ZipFile(stage / z) as f:
                f.extractall(d / Path(z).stem)
        else:
            (d / z).write_bytes((stage / z).read_bytes())
    (inp / "sportsan-m1-v2").mkdir()
    (inp / "sportsan-m1-v2" / "v2.mp4").write_bytes(b"\x01" * 10)
    # Otro video con el mismo nombre en otro conjunto: no debe tomarlo.
    (inp / "sportsan-otro-v2").mkdir()
    (inp / "sportsan-otro-v2" / "v2.mp4").write_bytes(b"\x02" * 99)
    work = {"match_id": "m1", "code_slug": "sportsan-code", "data_slug": "sportsan-m1-datos", "videos": {"v2": "sportsan-m1-v2"},
            "input_dir": str(inp), "root": str(tmp_path / "demo"), "out_dir": str(tmp_path / "out"), "dry": True}
    assert job.main(work) == 0
    demo = tmp_path / "demo"
    assert (demo / "src" / "sportsan" / "__init__.py").exists()
    assert "model: yolo11s.pt" in (demo / "matches" / "m1" / "match.yaml").read_text()
    assert (demo / "matches" / "m1" / "video" / "v2.mp4").read_bytes() == b"\x01" * 10
    summary = json.loads((tmp_path / "out" / "summary.json").read_text())
    assert summary["files"] == [] and summary["videos"] == ["v2"]


def test_job_script_carries_its_parameters():
    s = kg.job_script({"match_id": "m1", "videos": {"v2": "x"}})
    assert s.startswith('JOB = {"match_id": "m1"')
    meta = kg.kernel_meta("yo/sportsan-tracking-m1", ["yo/sportsan-code"])
    assert meta["title"] == "sportsan-tracking-m1" and meta["enable_gpu"] and meta["is_private"] and meta["enable_internet"]


def test_job_script_is_valid_python():
    # Los parámetros van arriba de todo: nada en el archivo puede exigir ir primero (como from __future__).
    compile(kg.job_script({"match_id": "m1", "videos": {}}), "job.py", "exec")

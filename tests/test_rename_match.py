import json

import pytest

from sportsan.ingest.rename_match import rename, rename_in_yaml, valid_folder


def test_convencion_de_carpetas():
    assert valid_folder("2026_09_25_up_vs_anahuac")
    assert valid_folder("2011_05_28_barcelona_vs_manchester_united")
    assert not valid_folder("partido_2026_09_25")          # sin equipos
    assert not valid_folder("2026_09_25_UP_vs_anahuac")    # mayúsculas
    assert not valid_folder("2026_02_30_up_vs_tec")        # fecha que no existe
    assert not valid_folder("2026-09-25_up_vs_tec")        # guiones


def test_renombrar(tmp_path):
    d = tmp_path / "matches" / "viejo"
    (d / "tracking").mkdir(parents=True)
    (d / "match.yaml").write_text('match_id: viejo   # comentario\nvideos: []\n', encoding="utf-8")
    (d / "tracking" / "tracks_v1_0_30.json").write_text(json.dumps({"match_id": "viejo", "frames": []}), encoding="utf-8")
    (d / "tracking" / "otro.json").write_text(json.dumps([1, 2]), encoding="utf-8")

    assert "carpeta -> 2026_10_11_ccm_vs_up" in rename(tmp_path, "viejo", "2026_10_11_ccm_vs_up", dry_run=True)
    assert d.exists()  # el ensayo no toca nada

    done = rename(tmp_path, "viejo", "2026_10_11_ccm_vs_up")
    new = tmp_path / "matches" / "2026_10_11_ccm_vs_up"
    assert not d.exists() and new.exists()
    assert (new / "match.yaml").read_text(encoding="utf-8").startswith("match_id: 2026_10_11_ccm_vs_up   # comentario")
    assert json.loads((new / "tracking" / "tracks_v1_0_30.json").read_text(encoding="utf-8"))["match_id"] == "2026_10_11_ccm_vs_up"
    assert "tracking/otro.json" not in done

    with pytest.raises(ValueError):
        rename(tmp_path, "2026_10_11_ccm_vs_up", "mal nombre")
    with pytest.raises(ValueError):
        rename_in_yaml("match_id: otro\n", "viejo", "nuevo")

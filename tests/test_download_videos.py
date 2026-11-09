from sportsan.ingest.download_videos import add_video_to_yaml, downloadable, new_match_yaml, youtube_id

ROW = {"match_id": "2026_10_11_ccm_vs_up", "kind": "own", "date": "", "own_team": "Tec CCM", "other_team": "UP",
       "video_id": "v2", "period": "", "label": "Parte 2", "url": "https://youtu.be/OIvhk-vNs5c?t=3", "note": ""}


def test_id_de_youtube():
    assert youtube_id("https://www.youtube.com/watch?v=_-utAbJNqhI&t=10") == "_-utAbJNqhI"
    assert youtube_id(ROW["url"]) == "OIvhk-vNs5c"
    assert youtube_id("https://www.youtube.com/live/kjPIltXBMPs") == "kjPIltXBMPs"
    assert youtube_id("") == ""


def test_anade_el_video_a_la_lista_antes_de_los_comentarios_y_de_la_clave_siguiente():
    text = (
        "match_id: x\n"
        "videos:\n"
        "  - video_id: v1\n"
        "    file: video/v1.mp4\n"
        "    fps: 30\n"
        "  # - video_id: v2   (plantilla comentada)\n"
        "\n"
        "notes: algo\n"
    )
    out = add_video_to_yaml(text, ROW, 29.97002997)
    assert out.index("  - video_id: v2\n") > out.index("    fps: 30\n")
    assert out.index("  - video_id: v2\n") < out.index("  # - video_id: v2")
    assert '    label: "Parte 2"\n    youtube_id: "OIvhk-vNs5c"\n    file: video/v2.mp4\n    fps: 29.97003\n' in out
    assert out.endswith("notes: algo\n")
    assert add_video_to_yaml(out, ROW, 30) == out  # ya estaba


def test_partido_nuevo():
    text = add_video_to_yaml(new_match_yaml(ROW), {**ROW, "video_id": "v1"}, None)
    assert text.startswith("match_id: 2026_10_11_ccm_vs_up\nkind: own")
    assert 'date: "REEMPLAZAR"' in text and 'own_team_name: "Tec CCM"' in text
    assert "  - video_id: v1\n" in text and "fps: REEMPLAZAR" in text


def test_enlaces_que_se_pueden_bajar():
    assert downloadable("https://www.youtube.com/watch?v=_-utAbJNqhI")
    assert downloadable("https://www.facebook.com/watch/?v=1234567890")
    assert not downloadable("")
    assert not downloadable("pendiente")



def test_select_rows_por_video_y_por_enlace_de_la_app():
    import pytest
    from sportsan.ingest.download_videos import select_rows

    other = {**ROW, "video_id": "v1"}
    assert select_rows([ROW, other], ROW["match_id"], "v2", None) == [ROW]
    assert select_rows([ROW, other], None, None, None) == [ROW, other]
    # sin fila en videos.csv: se arma con el enlace de la app
    (r,) = select_rows([], "2026_10_11_a_vs_b", "v3", "OIvhk-vNs5c")
    assert r["video_id"] == "v3" and r["url"] == "https://www.youtube.com/watch?v=OIvhk-vNs5c"
    with pytest.raises(SystemExit):
        select_rows([], "m", "v1", "corto")
    with pytest.raises(SystemExit):
        select_rows([], None, "v1", "OIvhk-vNs5c")


def test_registro_con_los_videos_de_match_yaml(tmp_path, monkeypatch):
    # Un partido creado por la app solo tiene match.yaml: overnight y Kaggle lo ven igual que a los de videos.csv.
    from sportsan.ingest import download_videos as dv

    m = tmp_path / "matches"
    (m / "2026_10_23_a_vs_b").mkdir(parents=True)
    (m / "2026_10_23_a_vs_b" / "match.yaml").write_text(
        'match_id: 2026_10_23_a_vs_b\nkind: own\ndate: "2026-10-23"\nown_team_name: "A"\nother_team_name: "B"\n'
        'videos:\n  - video_id: v1\n    youtube_id: "PuvKiL-vL2s"\n    file: video/v1.mp4\n    fps: 60\n'
        '  - video_id: v2\n    file: video/v2.mp4\n',
        encoding="utf-8",
    )
    (m / "otro").mkdir()
    (m / "otro" / "match.yaml").write_text("videos:\n  - video_id: v1\n", encoding="utf-8")
    (m / "videos.csv").write_text(",".join(dv.COLUMNS) + "\notro,rival,,X,Y,v1,,Todo,https://youtu.be/AAAAAAAAAAA,\n", encoding="utf-8")
    monkeypatch.setattr(dv, "MATCHES_DIR", "matches")
    rows = dv.registry_with_yaml(tmp_path)
    got = {(r["match_id"], r["video_id"]): r for r in rows}
    assert set(got) == {("otro", "v1"), ("2026_10_23_a_vs_b", "v1"), ("2026_10_23_a_vs_b", "v2")}
    assert got[("otro", "v1")]["url"] == "https://youtu.be/AAAAAAAAAAA"   # lo de videos.csv manda y no se duplica
    nuevo = got[("2026_10_23_a_vs_b", "v1")]
    assert nuevo["kind"] == "own" and nuevo["own_team"] == "A" and nuevo["url"].endswith("PuvKiL-vL2s")
    assert list(nuevo) == dv.COLUMNS

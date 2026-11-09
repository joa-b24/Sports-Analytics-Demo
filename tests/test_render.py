"""Render de clips editados y del pizarrón (sportsan.clips). Sin video real: todo sintético, sin nombres reales."""
import json
import math
import shutil
from pathlib import Path

import pytest

from sportsan.clips import geometry as g
from sportsan.clips import render as rn

FIXTURE = Path(__file__).parent / "fixtures" / "projection_cases.json"


def test_projection_matches_app():
    fx = json.loads(FIXTURE.read_text(encoding="utf-8"))
    for c in fx["cases"]:
        to = g.pitch_to_image(c["H"], c["venue"])
        to2 = g.pitch_to_image([v * -3.7 for v in c["H"]], c["venue"])
        for p, exp in zip(c["points"], c["pixels"]):
            for f in (to, to2):
                q = f(tuple(p))
                assert math.hypot(q[0] - exp[0], q[1] - exp[1]) < fx["tolerance_px"], (c["name"], p, q, exp)
    assert g.pitch_to_image(None, {"length_m": 100, "width_m": 65}) is None


def test_shared_drawing_cases_unchanged():
    # Los dibujos del fixture los genera este módulo; la app los compara con los suyos (web/lib/clips.test.mjs).
    fx = json.loads(FIXTURE.read_text(encoding="utf-8"))
    d = fx["drawings"]
    cam = next(c for c in fx["cases"] if c["name"] == d["case"])
    to = g.pitch_to_image(cam["H"], cam["venue"])
    for item in d["items"]:
        r = g.resolve(item["annotation"], d["t"], lambda i, t: tuple(d["positions"][str(i)]) if str(i) in d["positions"] else None)
        p = g.project(r, to, (cam["image"]["w"], cam["image"]["h"]), lambda i: d["labels"].get(str(i)))
        exp = item["expected"]
        assert p.closed == exp["closed"]
        assert (p.head is not None) == (exp.get("head") is not None), item["annotation"]["id"]
        if exp.get("text"):
            assert p.text[1] == exp["text"][1] and p.anchor == exp.get("anchor", "middle")
            assert math.hypot(p.text[0][0] - exp["text"][0][0], p.text[0][1] - exp["text"][0][1]) < 1e-6
        else:
            assert p.text is None
        for path, epath in zip(p.paths, exp["paths"]):
            assert all(math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6 for a, b in zip(path, epath))


def edit(**kw):
    e = {"edit_id": "e1", "match_id": "m1", "video_id": "v1", "t_start": 10.0, "t_end": 12.0, "title": "Clip", "freezes": [],
         "annotations": [], "label_mode": "number"}
    e.update(kw)
    return e


def test_frame_plan_with_two_freezes():
    e = edit(freezes=[{"t": 11.0, "duration_s": 0.5, "reveal": []}, {"t": 10.5, "duration_s": 1.0, "reveal": ["a"]}, {"t": 30, "duration_s": 5, "reveal": []}])
    plan = g.frame_plan(e, 10)
    # 2 s de video (20 cuadros) + 1 s + 0.5 s de pausas; la pausa en 30 s queda fuera del clip.
    assert len(plan) == 20 + 10 + 5
    src = [p[0] for p in plan]
    assert src[:5] == [100, 101, 102, 103, 104]
    assert src[5:15] == [105] * 10 and all(p[2]["t"] == 10.5 for p in plan[5:15])
    assert [round(p[3], 1) for p in plan[5:15]] == [round(i / 10, 1) for i in range(10)]
    assert src[15:20] == [105, 106, 107, 108, 109]
    assert src[20:25] == [110] * 5
    assert src[25:] == list(range(110, 120))
    # Las pausas no son tiempo de video: el instante de cada cuadro de pausa es el de la pausa.
    assert {p[1] for p in plan[5:15]} == {10.5}
    assert g.reveal_count({"duration_s": 1.0, "reveal": ["a"]}, 0.4) == 0
    assert g.reveal_count({"duration_s": 1.0, "reveal": ["a"]}, 0.5) == 1


def test_no_h_hides_pitch_drawings_keeps_screen_text():
    pos = lambda i, t: (50.0, 30.0)  # noqa: E731
    ring = g.resolve({"id": "h", "kind": "highlight", "anchors": [{"kind": "player", "identity": 4}], "t_in": 0, "t_out": 9, "style": {}}, 1, pos)
    text = g.resolve({"id": "t", "kind": "text", "anchors": [{"kind": "screen", "x": 0.25, "y": 0.1}], "t_in": 0, "t_out": 9, "style": {"label": "Presión"}}, 1, pos)
    assert g.project(ring, None, (1920, 1080)) is None
    assert g.project(text, None, (1920, 1080)).text == ((480.0, 108.0), "Presión")
    # Una H lejana no sirve: sin calibración cerca, no hay H.
    assert g.homography_at([[0, [1, 0, 0, 0, 1, 0, 0, 0, 1]]], 100, 20) is None


def snap():
    rows = []
    for f in range(3000, 3301, 3):
        if not (3051 < f < 3069 or 3120 < f < 3183):
            rows.append([f, f / 100, 20, "auto"])
    return {"fps": 30, "stride": 3, "tracks": {"7": rows, "8": [[3000, 10, 10, "auto"], [3003, 11, 10, "interpolated"], [3006, 12, 10, "auto"]]},
            "people": [{"id": 7, "team": "own", "player_id": "Jugadora Siete", "number": 7}, {"id": 8, "team": "own", "player_id": "Jugadora Ocho", "number": None}]}


def test_player_missing_half_second_or_two():
    pos = g.snapshot_positions(snap())
    x, _ = pos(7, 3060 / 30)
    assert abs(x - 30.6) < 1e-6
    assert pos(7, 3150 / 30) is None
    assert pos(8, 3003 / 30) == (11.0, 10.0)
    assert pos(7, 3320 / 30) is None


def test_number_label_never_name():
    s = snap()
    assert g.label_for(7, "number", s) == "7"
    assert g.label_for(8, "number", s) is None
    assert g.label_for(8, "name", s) == "Jugadora Ocho"
    assert g.label_for(7, "none", s) is None
    assert rn.label_mode_for({"label_mode": "name"}, "whatsapp") == "number"
    assert rn.label_mode_for({"label_mode": "name"}, "charla") == "name"
    assert rn.label_mode_for({"label_mode": "none"}, "whatsapp") == "none"


def test_ffmpeg_args_by_profile():
    out = Path("x.mp4")
    charla = rn.ffmpeg_args("ffmpeg", "charla", 1920, 1080, 29.97, out)
    whats = rn.ffmpeg_args("ffmpeg", "whatsapp", 1920, 1080, 29.97, out)
    low = rn.ffmpeg_args("ffmpeg", "charla", 854, 480, 30, out)
    for a in (charla, whats):
        assert a[a.index("-c:v") + 1] == "libx264"
        assert a[a.index("-movflags") + 1] == "+faststart"
        assert a[a.index("-pix_fmt", a.index("-i")) + 1] == "yuv420p"
        assert "-an" in a and a[a.index("-i") + 1] == "-"
    assert charla[charla.index("-vf") + 1] == "scale=-2:1080" and charla[charla.index("-crf") + 1] == "18"
    assert whats[whats.index("-vf") + 1] == "scale=-2:720" and whats[whats.index("-b:v") + 1] == "1500k"
    # Nunca agranda: un video de 480p sale a 480p.
    assert low[low.index("-vf") + 1] == "scale=-2:480"


def test_board_plan_holds_each_step():
    board = {"keyframes": [{"t": 0, "pos": {"o1": [10, 10]}}, {"t": 2, "pos": {"o1": [30, 10]}}]}
    ts = rn.board_plan(board, 10)
    hold = round(rn.BOARD_HOLD_S * 10)
    assert ts[:hold] == [0] * hold
    assert len(ts) == 2 * hold + 20 + round(rn.BOARD_TAIL_S * 10)
    assert rn.interpolate(board["keyframes"], 1.0)["o1"] == [20.0, 10.0]


needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="sin ffmpeg")


@needs_ffmpeg
def test_short_render_on_synthetic_video(tmp_path):
    cv2 = pytest.importorskip("cv2")
    pytest.importorskip("PIL")
    folder = tmp_path / "matches" / "m1"
    (folder / "video").mkdir(parents=True)
    w, h, fps = 320, 180, 30
    vw = cv2.VideoWriter(str(folder / "video" / "v1.mp4"), cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))
    import numpy as np

    for i in range(2 * fps):
        vw.write(np.full((h, w, 3), (40, 120 + i, 40), np.uint8))
    vw.release()
    # Cámara cenital: píxel -> metros reales de una sede de 105 x 68 por escala.
    H = [105 / w, 0, 0, 0, 68 / h, 0, 0, 0, 1]
    e = edit(t_start=0.0, t_end=2.0, freezes=[{"t": 0.5, "duration_s": 1.0, "reveal": ["t"]}],
             annotations=[
                 {"id": "z", "kind": "zone", "anchors": [{"kind": "pitch", "x": 10, "y": 10}, {"kind": "pitch", "x": 40, "y": 10}, {"kind": "pitch", "x": 25, "y": 40}], "t_in": 0, "t_out": 2, "style": {"color": "danger"}},
                 {"id": "h", "kind": "highlight", "anchors": [{"kind": "player", "identity": 1}], "t_in": 0, "t_out": 2, "style": {"color": "warn"}},
                 {"id": "t", "kind": "text", "anchors": [{"kind": "screen", "x": 0.5, "y": 0.2}], "t_in": 0.5, "t_out": 2, "style": {"color": "ink", "label": "Presión"}},
             ],
             snapshot={"fps": fps, "stride": 3, "image_w": w, "image_h": h, "venue": {"length_m": 105, "width_m": 68},
                       "homographies": [[f, H] for f in range(0, 61, 3)], "people": [{"id": 1, "team": "own", "player_id": None, "number": 9}],
                       "tracks": {"1": [[f, 50 + f / 10, 34, "auto"] for f in range(0, 61, 3)]}})
    (folder / "edits").mkdir()
    path = folder / "edits" / "edit_e1.json"
    path.write_text(json.dumps(e), encoding="utf-8")
    out = rn.render_edit(path, "whatsapp")
    assert out == folder / "clips" / "e1_whatsapp.mp4" and out.exists()
    cap = cv2.VideoCapture(str(out))
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    assert n == len(g.frame_plan(e, fps)) == 60 + 30
    # La zona tiñe el césped donde está.
    cap.set(cv2.CAP_PROP_POS_FRAMES, 5)
    ok, img = cap.read()
    assert ok
    src = np.full((h, w, 3), (40, 125, 40), np.int32)
    zx, zy = int(25 / 105 * w), int(20 / 68 * h)
    assert np.abs(img[zy, zx].astype(np.int32) - src[zy, zx]).sum() > 30
    # Ya existe: se salta sin tocarlo.
    mtime = out.stat().st_mtime
    rn.render_edit(path, "whatsapp")
    assert out.stat().st_mtime == mtime


@needs_ffmpeg
def test_board_render(tmp_path, monkeypatch):
    cv2 = pytest.importorskip("cv2")
    pytest.importorskip("PIL")
    monkeypatch.setattr(rn, "project_root", lambda: tmp_path)
    board = {"board_id": "b1", "title": "Córner", "framing": "right", "tokens": [{"id": "o1", "team": "own", "label": "9"}, {"id": "ball", "team": "ball", "label": ""}],
             "keyframes": [{"t": 0, "pos": {"o1": [90, 30], "ball": [104, 1]}}, {"t": 1, "pos": {"o1": [99, 34], "ball": [99, 33]}}],
             "annotations": [{"id": "a", "kind": "arrow", "anchors": [{"kind": "player", "identity": "o1"}, {"kind": "pitch", "x": 100, "y": 36}], "t_in": 0, "t_out": 1, "style": {"color": "accent"}}]}
    src = tmp_path / "board_b1.json"
    src.write_text(json.dumps(board), encoding="utf-8")
    out = rn.render_board(str(src), "charla")
    assert out == tmp_path / "clips" / "board_b1_charla.mp4" and out.exists()
    cap = cv2.VideoCapture(str(out))
    assert int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) == len(rn.board_plan(board, 30))


def test_first_frame_after_a_freeze_keeps_what_appeared_in_it():
    # A 29.97 fps, la pausa en 10.02 s cae entre cuadros: el primero tras ella (300 = 10.01 s) no debe esconder lo que
    # apareció en la pausa, que empieza en 10.02.
    e = edit(t_start=10.0, t_end=10.2, freezes=[{"t": 10.02, "duration_s": 0.1, "reveal": ["t"]}])
    plan = g.frame_plan(e, 29.97)
    after = [p for p in plan if p[2] is None and p[0] >= round(10.02 * 29.97)]
    assert after and all(p[1] >= 10.02 for p in after)
    before = [p for p in plan if p[2] is None and p[0] < round(10.02 * 29.97)]
    assert all(p[1] < 10.02 for p in before)


def test_roster_numbers_reads_the_app_file(tmp_path):
    f = tmp_path / "roster.json"
    f.write_text(json.dumps({"schema_version": 1, "team": "Equipo A", "players": [{"player_id": "Jugadora Uno", "number": 9}]}), encoding="utf-8")
    assert rn.roster_numbers(f) == {"Jugadora Uno": 9}
    assert rn.roster_numbers(tmp_path / "no_existe.json") == {}


def test_color_bgr_palette_and_free_hex():
    assert rn.color_bgr("#ff8000") == (0, 128, 255)
    assert rn.color_bgr("violet") == rn.DRAW_BGR["violet"]
    # La analista cambió una casilla; un nombre desconocido cae en el azul.
    assert rn.color_bgr("warn", {"warn": "#102030"}) == (0x30, 0x20, 0x10)
    assert rn.color_bgr("no-existe") == rn.DRAW_BGR["accent"]


def test_arrow_shape_and_label_side_in_render():
    cv2 = pytest.importorskip("cv2")
    pytest.importorskip("PIL")
    import numpy as np

    w, h = 640, 360
    H = [105 / w, 0, 0, 0, 68 / h, 0, 0, 0, 1]
    to = g.pitch_to_image(H, {"length_m": 105, "width_m": 68})
    pos = lambda i, t: (50.0, 40.0)  # noqa: E731
    base = np.full((h, w, 3), 60, np.uint8)

    def render(style, **kw):
        a = {"id": "h", "kind": "highlight", "anchors": [{"kind": "player", "identity": 1}], "t_in": 0, "t_out": 9, "style": style}
        p = g.project(g.resolve(a, 1, pos), to, (w, h), lambda i: "9", **kw)
        return p, rn.draw_items(base.copy(), [p], 1.0)

    ring, img_ring = render({"color": "warn"})
    arrow, img_arrow = render({"color": "warn", "shape": "arrow"})
    none, img_none = render({"color": "warn", "shape": "none", "label_off": True})
    assert ring.closed and ring.head is None
    assert arrow.head is not None and not arrow.paths
    assert none.text is None and none.head is None and not none.paths
    assert not (img_none != base).any()
    assert (img_arrow != base).any() and (img_ring != base).any()
    # La flecha queda sobre la cabeza: más arriba que el aro.
    assert min(q[1] for q in arrow.head) < min(q[1] for p in ring.paths for q in p)
    # Lados del rótulo y rótulo oculto de una jugadora.
    left, _ = render({"color": "warn"}, side="left")
    right, _ = render({"color": "warn"}, side="right")
    assert left.anchor == "end" and right.anchor == "start" and left.text[0][0] < right.text[0][0]
    hid, _ = render({"color": "warn"}, hidden={"1"})
    assert hid.text is None


def test_players_stand_in_front_of_drawings():
    import numpy as np

    h, w = 360, 640
    base = np.full((h, w, 3), 60, np.uint8)
    wide = g.Projected("z", "zone", {"color": "danger"}, [[(100, 100), (500, 100), (500, 300), (100, 300)]], True, None, None)
    plain = rn.draw_items(base.copy(), [wide], 1.0)
    cut = rn.draw_items(base.copy(), [wide], 1.0, bodies=[(250, 150, 40, 100)])
    assert (plain[200, 270] != base[200, 270]).any()
    assert (cut[200, 270] == base[200, 270]).all()
    assert (cut[200, 400] == plain[200, 400]).all()

"""Orquestadores `pipeline tracking` y `pipeline fill-ball`: plan, orden de etapas, quick, reanudación, precondiciones y estado.
Todo con un repositorio de juguete y un ejecutor falso de comandos: no corre detección ni calibración reales."""
import json
from pathlib import Path

import pytest

from sportsan import config
from sportsan.tracking import orchestrate as orc

PARTS = ["v1_1800_5400", "v1_6000_7800"]


@pytest.fixture
def repo(tmp_path, monkeypatch):
    (tmp_path / "config").mkdir()
    (tmp_path / "config" / "project.yaml").write_text("default_match: m1\n", encoding="utf-8")
    d = tmp_path / "matches" / "m1"
    (d / "video").mkdir(parents=True)
    (d / "tracking" / "auto").mkdir(parents=True)
    (d / "video" / "v1.mp4").write_bytes(b"x")
    (d / "match.yaml").write_text("match_id: m1\nanalysis_stride: 3\nvideos:\n  - {video_id: v1, file: video/v1.mp4, fps: 30}\n", encoding="utf-8")
    (d / "segments.csv").write_text(
        "segment_id,video_id,start,end,tipo\ns01,v1,00:01:00,00:03:00,juego\ns02,v1,00:03:00,00:03:20,pausa\ns03,v1,00:03:20,00:04:20,juego\n",
        encoding="utf-8")
    (d / "tracking" / "anchors_m1_v1.json").write_text("{}", encoding="utf-8")
    (d / "tracking" / "link_model.json").write_text("{}", encoding="utf-8")
    monkeypatch.setattr(config, "project_root", lambda: tmp_path)
    return tmp_path


class Fake:
    """Ejecutor falso: anota cada comando y escribe lo que escribiría el real."""

    def __init__(self, tdir: Path, fail: str | None = None, interrupt: str | None = None):
        self.tdir, self.calls, self.fail, self.interrupt = tdir, [], fail, interrupt

    def __call__(self, cmd, tick=None):
        mod = cmd[2].removeprefix("sportsan.tracking.")
        key = mod + (" " + cmd[3] if mod in ("anchors_cli", "ball", "library") else "")
        self.calls.append((key, cmd))
        if self.interrupt == mod:
            raise KeyboardInterrupt
        if self.fail == mod:
            return 1
        t = self.tdir
        if mod == "propagate":
            (t / "calib_v1_0_10.json").write_text("{}", encoding="utf-8")
        elif mod == "library":
            (t / "library_v1.npz").write_bytes(b"x")
        elif mod == "process":
            out = Path(cmd[cmd.index("--out-dir") + 1]) if "--out-dir" in cmd else t
            out.mkdir(parents=True, exist_ok=True)
            if "--start" in cmd:
                names = [f"{round(float(cmd[cmd.index('--start') + 1]) * 30)}_{round(float(cmd[cmd.index('--end') + 1]) * 30)}"]
            else:
                names = [p.removeprefix("v1_") for p in PARTS]
            chunks = []
            for n in names:
                (out / f"tracks_v1_{n}.json").write_text("{}", encoding="utf-8")
                chunks.append({"file": f"tracks_v1_{n}.json", "calibrated_share": 0.9, "on_pitch_median": 12})
            (out / "tracks_v1_index.json").write_text(json.dumps({"chunks": chunks}), encoding="utf-8")
        elif mod == "anchors_cli" and cmd[3] == "suggest":
            (t / "auto" / f"suggest_{cmd[cmd.index('--part') + 1]}.json").write_text("{}", encoding="utf-8")
        elif mod == "anchors_cli" and cmd[3] == "fill":
            (t / "auto" / f"links_{cmd[cmd.index('--part') + 1]}_exp_tramos.json").write_text("{}", encoding="utf-8")
        elif mod == "ball":
            part = cmd[cmd.index("--part") + 1]
            (t / part.replace("tracks_", "ball_auto_", 1)).write_text("{}", encoding="utf-8")
        return 0


@pytest.fixture
def fake(repo, monkeypatch):
    f = Fake(repo / "matches" / "m1" / "tracking")
    monkeypatch.setattr(orc, "RUNNER", f)
    return f


def state(repo, cmd="tracking"):
    return json.loads((repo / "matches" / "m1" / "tracking" / "revision" / f"pipeline_{cmd}.json").read_text(encoding="utf-8"))


def keys(f):
    return [k for k, _ in f.calls]


def test_plan_no_ejecuta_ni_escribe_estado(repo, fake, capsys):
    assert orc.main(["tracking", "--match", "m1", "--plan"]) == 0
    out = capsys.readouterr().out
    assert "propagate" in out and "process" in out and "suggest v1_1800_5400" in out and "Estimado" in out
    assert fake.calls == []
    assert not (repo / "matches" / "m1" / "tracking" / "revision").exists()


def test_orden_de_etapas_y_estado(repo, fake):
    assert orc.main(["tracking", "--match", "m1"]) == 0
    assert keys(fake) == ["propagate", "library build", "process", "anchors_cli suggest", "anchors_cli suggest"]
    # Nada de --force ni --quick-only en el process real
    assert "--force" not in fake.calls[2][1]
    s = state(repo)
    assert s["state"] == "done" and s["pct"] == 100.0 and {"stage", "video", "part", "eta_s", "started", "message"} <= set(s)
    log = (repo / "matches" / "m1" / "tracking" / "revision" / "progreso_pipeline_tracking.log").read_text(encoding="utf-8").splitlines()
    assert log and all(" ETA " in line and "%" in line and "(total " in line for line in log)


def test_band_margin_se_reenvia(repo, fake):
    orc.main(["tracking", "--match", "m1", "--band-margin", "3.5"])
    proc = next(c for k, c in fake.calls if k == "process")
    assert proc[proc.index("--band-margin") + 1] == "3.5"


def test_resume_no_repite(repo, fake):
    orc.main(["tracking", "--match", "m1"])
    n = len(fake.calls)
    assert orc.main(["tracking", "--match", "m1", "--resume"]) == 0
    assert len(fake.calls) == n
    assert state(repo)["state"] == "done"


def test_sin_resume_solo_rehace_sugerencias(repo, fake):
    orc.main(["tracking", "--match", "m1"])
    fake.calls.clear()
    orc.main(["tracking", "--match", "m1"])
    assert keys(fake) == ["anchors_cli suggest", "anchors_cli suggest"]     # biblioteca y partes ya al día; process no repite


def test_partes_con_anclas_se_respetan(repo, fake, capsys):
    t = repo / "matches" / "m1" / "tracking"
    orc.main(["tracking", "--match", "m1"])
    fake.calls.clear()
    (t / "auto" / "anchors_v1_1800_5400.json").write_text('{"anchors": [1]}', encoding="utf-8")
    (t / "tracks_fixed_v1_6000_7800.json").write_text("{}", encoding="utf-8")
    assert orc.main(["tracking", "--match", "m1"]) == 3          # terminó, pero omitió etapas
    assert fake.calls == []
    assert "usa --force" in capsys.readouterr().out
    assert (t / "tracks_fixed_v1_6000_7800.json").read_text(encoding="utf-8") == "{}"


def test_quick_solo_escribe_en_revision_quick(repo, fake, monkeypatch):
    t = repo / "matches" / "m1" / "tracking"
    seen = {}

    def check(match, video, out_dir, samples):
        seen["samples"] = samples
        (out_dir / "calib_v1_1_2.json").write_text("{}", encoding="utf-8")
        (out_dir / "check.txt").write_text("tabla", encoding="utf-8")
        return [{"found": 10, "neighbours_m": 0.4, "refs_m": 0.5, "missing": 0}, {"found": 0, "neighbours_m": None, "refs_m": None, "missing": 5}]

    monkeypatch.setattr(orc, "run_library_check", check)
    monkeypatch.setattr(orc, "run_quick_suggest", lambda tdir, qdir, part, per_min: {"chains": 3, "suggestions": 2})
    # Biblioteca ya hecha: lo compartido (propagación/biblioteca) no entra en la comparación.
    (t / "library_v1.npz").write_bytes(b"x")
    before = {p.relative_to(t) for p in t.rglob("*")}
    assert orc.main(["tracking", "--match", "m1", "--quick"]) == 0
    new = {p.relative_to(t) for p in t.rglob("*")} - before
    assert all(p.parts[:2] == ("revision", "quick") or p.parts == ("revision",) or p.parts[0] == "revision" and p.name.startswith(("pipeline_", "progreso_pipeline_")) for p in new), new
    proc = next(c for k, c in fake.calls if k == "process")
    assert float(proc[proc.index("--end") + 1]) - float(proc[proc.index("--start") + 1]) == pytest.approx(60)
    assert proc[proc.index("--out-dir") + 1].endswith("quick")
    assert keys(fake) == ["process"]
    doc = json.loads((t / "revision" / "quick" / "summary.json").read_text(encoding="utf-8"))
    assert doc["calibration_check"] == {"samples": 2, "to_review": 1, "rows": doc["calibration_check"]["rows"], "table": "check.txt"}
    assert doc["suggest"] == {"chains": 3, "suggestions": 2} and doc["process"]["calibrated_share"] == 0.9
    assert seen["samples"] == 8 and doc["part"] == "v1_1800_3600"
    # --quick-s cambia el largo del tramo
    orc.main(["tracking", "--match", "m1", "--quick", "--quick-s", "30"])
    proc = [c for k, c in fake.calls if k == "process"][-1]
    assert float(proc[proc.index("--end") + 1]) - float(proc[proc.index("--start") + 1]) == pytest.approx(30)


def test_fallo_de_process_deja_error_y_no_sugiere(repo, fake):
    fake.fail = "process"
    assert orc.main(["tracking", "--match", "m1"]) == 1
    assert keys(fake) == ["propagate", "library build", "process"]
    s = state(repo)
    assert s["state"] == "error" and "process" in s["message"]


def test_ctrl_c_marca_estado_y_sale_130(repo, fake):
    fake.interrupt = "process"
    assert orc.main(["tracking", "--match", "m1"]) == 130
    s = state(repo)
    assert s["state"] == "error" and "--resume" in s["message"]
    # y se puede reanudar
    fake.interrupt = None
    fake.calls.clear()
    assert orc.main(["tracking", "--match", "m1", "--resume"]) == 0
    assert keys(fake)[0] == "process" and "propagate" not in keys(fake)


def test_sin_anclas_ni_biblioteca_es_precondicion(repo, fake, capsys):
    (repo / "matches" / "m1" / "tracking" / "anchors_m1_v1.json").unlink()
    assert orc.main(["tracking", "--match", "m1"]) == 2
    assert "faltan las anclas" in capsys.readouterr().err
    assert fake.calls == []


# ---------------------------------------------------------------- fill-ball

def test_fill_ball_precondiciones(repo, fake, capsys):
    t = repo / "matches" / "m1" / "tracking"
    assert orc.main(["fill-ball", "--match", "m1"]) == 2                     # no hay modelo
    err = capsys.readouterr().err
    assert "modelo de balón" in err and "muestras" in err
    (t / "ball_samples_v1.json").write_text("{}", encoding="utf-8")
    orc.main(["fill-ball", "--match", "m1"])
    assert "ball train" in capsys.readouterr().err                           # hay muestras: dice cómo entrenar
    (repo / "weights").mkdir()
    (repo / "weights" / "ball_model_x.pt").write_bytes(b"x")
    assert orc.main(["fill-ball", "--match", "m1"]) == 2                     # modelo bien, pero no hay partes
    assert "no hay partes procesadas" in capsys.readouterr().err
    for p in PARTS:
        (t / f"tracks_{p}.json").write_text("{}", encoding="utf-8")
    assert orc.main(["fill-ball", "--match", "m1"]) == 2                     # partes, pero ninguna con anclas
    assert "anclas" in capsys.readouterr().err
    assert fake.calls == []


def test_fill_ball_orden_y_no_pisa_balon(repo, fake):
    t = repo / "matches" / "m1" / "tracking"
    (repo / "weights").mkdir()
    (repo / "weights" / "ball_model_x.pt").write_bytes(b"x")
    for p in PARTS:
        (t / f"tracks_{p}.json").write_text("{}", encoding="utf-8")
        (t / "auto" / f"anchors_{p}.json").write_text('{"anchors": [{"frame": 1}]}', encoding="utf-8")
    (t / "ball_auto_v1_6000_7800.json").write_text("viejo", encoding="utf-8")
    assert orc.main(["fill-ball", "--match", "m1", "--model", "weights/ball_model_x.pt"]) == 0
    assert keys(fake) == ["anchors_cli fill", "ball run", "anchors_cli fill"]       # el segundo balón ya existía
    fill = fake.calls[0][1]
    assert fill[fill.index("--variant") + 1] == "exp"
    ball = fake.calls[1][1]
    assert ball[ball.index("--accept") + 1] == "0.95" and "--force" not in ball and ball[ball.index("--model") + 1].endswith("ball_model_x.pt")
    assert (t / "ball_auto_v1_6000_7800.json").read_text(encoding="utf-8") == "viejo"
    s = state(repo, "fill-ball")
    assert s["state"] == "done" and s["pct"] == 100.0
    assert (t / "revision" / "progreso_pipeline_fill-ball.log").exists()


def test_fill_ball_resume(repo, fake):
    t = repo / "matches" / "m1" / "tracking"
    (repo / "weights").mkdir()
    (repo / "weights" / "ball_model.pt").write_bytes(b"x")
    (t / "tracks_v1_1800_5400.json").write_text("{}", encoding="utf-8")
    (t / "auto" / "anchors_v1_1800_5400.json").write_text('{"anchors": [{"frame": 1}]}', encoding="utf-8")
    orc.main(["fill-ball", "--match", "m1"])
    n = len(fake.calls)
    assert n == 2
    assert orc.main(["fill-ball", "--match", "m1", "--resume"]) == 0
    assert len(fake.calls) == n


def test_estado_en_curso_bloquea_segundo_lanzamiento(repo, fake):
    rev = repo / "matches" / "m1" / "tracking" / "revision"
    rev.mkdir(parents=True)
    import os
    (rev / "pipeline_tracking.json").write_text(json.dumps({"state": "running", "pid": os.getpid() + 0}), encoding="utf-8")
    assert orc.main(["tracking", "--match", "m1"]) == 0       # es este mismo proceso: no cuenta como otro
    (rev / "pipeline_tracking.json").write_text(json.dumps({"state": "running", "pid": 999999999}), encoding="utf-8")
    assert orc.main(["tracking", "--match", "m1", "--resume"]) == 0   # pid muerto: estado viejo, se ignora


def test_el_pid_del_lanzador_no_cuenta_como_otro_tracking(repo, fake):
    # En Windows la app anota el pid del python.exe del entorno virtual, que es el padre del Python que corre esto.
    import os
    rev = repo / "matches" / "m1" / "tracking" / "revision"
    rev.mkdir(parents=True)
    (rev / "pipeline_tracking.json").write_text(json.dumps({"state": "running", "pid": os.getppid()}), encoding="utf-8")
    assert orc.main(["tracking", "--match", "m1"]) == 0


def test_otro_tracking_vivo_si_bloquea(repo, fake, monkeypatch):
    import os
    rev = repo / "matches" / "m1" / "tracking" / "revision"
    rev.mkdir(parents=True)
    other = os.getpid() + 7
    (rev / "pipeline_tracking.json").write_text(json.dumps({"state": "running", "pid": other}), encoding="utf-8")
    monkeypatch.setattr(orc, "pid_alive", lambda pid: pid == other)
    with pytest.raises(SystemExit):
        orc.main(["tracking", "--match", "m1"])

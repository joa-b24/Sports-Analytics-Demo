"""L6: tope seguro de procesos, franjas de hilos, progreso con % y ETA, y que --jobs/--workers 1 no cambian lo de siempre."""
from pathlib import Path

import pytest

from sportsan.tracking import overnight, parallel
from sportsan.tracking.detect import Chunk


def test_one_worker_is_always_one_and_never_asks_the_machine():
    assert parallel.safe_workers(1, cpus=16, free_ram_gb=0.1) == 1
    assert parallel.safe_workers(0) == 1


def test_the_cap_follows_threads_memory_and_the_hard_limit(capsys):
    # 16 hilos lógicos y memoria de sobra: la mitad de los hilos / 4 por proceso = 2
    assert parallel.safe_workers(8, cpus=16, free_ram_gb=12) == 2
    assert "se usan 2" in capsys.readouterr().out
    # máquina grande: manda el tope duro
    assert parallel.safe_workers(10, cpus=128, free_ram_gb=100) == parallel.HARD_CAP
    # poca memoria libre: baja a 1 aunque los hilos alcancen
    assert parallel.safe_workers(4, cpus=32, free_ram_gb=3.0) == 1
    assert parallel.safe_workers(4, cpus=32, free_ram_gb=parallel.RAM_RESERVE_GB + 2 * parallel.RAM_PER_WORKER_GB) == 2


def test_cpu_slices_are_disjoint_and_stay_in_half_the_machine():
    sl = parallel.cpu_slices(2, cpus=16)
    flat = [c for s in sl for c in s]
    assert len(flat) == len(set(flat)) == 8
    assert min(flat) >= 8 and max(flat) == 15
    one = parallel.cpu_slices(1, cpus=16)
    assert len(one[0]) == 8


def test_progress_log_reports_percent_and_eta_and_writes_the_file(tmp_path, capsys):
    log = parallel.ProgressLog("demo", 200, tmp_path / "sub" / "p.log")
    line = log.step(50, "una parte")
    assert " 25.0 %" in line and "faltan" in line and "una parte" in line
    log.step(500)  # no pasa de 100 %
    assert log.done == 200
    text = (tmp_path / "sub" / "p.log").read_text(encoding="utf-8")
    assert text.count("\n") == 2 and "100.0 %" in text
    assert parallel.fmt_eta(3725) == "1 h 02 min" and parallel.fmt_eta(75) == "1 min 15 s"


def test_overnight_only_passes_workers_when_asked(monkeypatch, tmp_path):
    seen: list[list[str]] = []
    monkeypatch.setattr(overnight, "run", lambda cmd, prefix="": seen.append(cmd) or True)
    plan = overnight.VideoPlan("m1", "v1", steps=["process"])
    assert overnight.run_video(plan, tmp_path, 1)
    assert "--workers" not in seen[-1]
    assert overnight.run_video(plan, tmp_path, 3)
    assert seen[-1][-2:] == ["--workers", "3"]


def test_worker_task_writes_one_part_with_the_same_calls_as_the_serial_path(monkeypatch, tmp_path):
    from sportsan.tracking import process

    calls = []
    monkeypatch.setattr(process, "run_chunk", lambda cap, model, lib, chunk, stride, every, conf, tracker, **kw: calls.append(("run", chunk.start, chunk.end, kw["tiles"])) or ([chunk.start], [[]], {}, {}))
    monkeypatch.setattr(process, "finish_chunk", lambda frames, rows, motions, anchors, lib, refs, fps, max_error, post: {"quality": {"q": 1}, "colors": []})
    monkeypatch.setattr(process, "write_outputs", lambda out_dir, meta, chunk, stride, frames, result: Path(out_dir) / f"tracks_{chunk.name}.json")
    spec = {"stride": 3, "every": 10, "conf": 0.2, "tracker": "t.yaml", "tiles": 1, "band": None, "mask": None, "band_margin": 4.0,
            "refs": {}, "fps": 30.0, "max_error": 1.0, "post": {}, "out_dir": str(tmp_path), "meta": {}}
    monkeypatch.setitem(parallel._W, "spec", spec)
    for k in ("cap", "model", "lib"):
        monkeypatch.setitem(parallel._W, k, object())
    res = parallel._run_one((90, 450))
    assert calls == [("run", 90, 450, 1)]
    assert res["frames"] == 1 and res["path"] == f"tracks_{Chunk(90, 450).name}.json" and res["quality"] == {"q": 1}


def test_process_cli_keeps_one_worker_by_default():
    import argparse
    import inspect

    from sportsan.tracking import process

    src = inspect.getsource(process.main)
    assert '"--workers", type=int, default=1' in src
    assert isinstance(argparse.ArgumentParser(), argparse.ArgumentParser)

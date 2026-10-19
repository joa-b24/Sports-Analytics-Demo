"""Lo que corre dentro de Kaggle (trabajo A: tracking). Lo sube `sportsan.cloud.kaggle`; no se corre en la laptop.

Arriba de este archivo, al subirlo, se escribe `JOB = {...}` con el partido, los videos y los nombres de los datos.
Pasos: arma el repositorio en /tmp/demo con el código y los archivos del partido, enlaza los videos, cambia el modelo
OpenVINO (CPU Intel) por el mismo en PyTorch (`.pt`, que usa la GPU solo), instala lo que falta, corre `overnight`
con un tope de tiempo (para no perder lo hecho si Kaggle corta la sesión) y deja en /kaggle/working/out/ solo los
archivos nuevos o cambiados de `tracking/`, que la laptop baja después.
"""

import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
import zipfile
from pathlib import Path

JOB: dict = globals().get("JOB") or {}


def find_in_input(input_dir: Path, slug: str, name: str, marker: str | None = None) -> Path | None:
    """Un archivo de un conjunto de datos: tal cual, ya descomprimido por Kaggle en una carpeta con su nombre, o
    descomprimido directamente en la raíz del conjunto (entonces se reconoce por `marker`, algo que debe contener).
    Solo se busca dentro de la carpeta de ese conjunto (varios tienen un v1.mp4); se siguen los enlaces de Kaggle."""
    bases = [input_dir / slug]
    for dirpath, dirnames, _ in os.walk(input_dir, followlinks=True):
        if Path(dirpath).name == slug:
            bases.append(Path(dirpath))
        if dirpath.count(os.sep) - str(input_dir).count(os.sep) >= 4:
            dirnames[:] = []
    for base in bases:
        if not base.is_dir():
            continue
        for c in [base / name, base / Path(name).stem]:
            if c.exists():
                return c
        for dirpath, _, files in os.walk(base, followlinks=True):
            if name in files:
                return Path(dirpath) / name
        if marker:
            for dirpath, dirnames, files in os.walk(base, followlinks=True):
                if marker in dirnames or marker in files:
                    return Path(dirpath)
    return None


def show_input(input_dir: Path, depth: int = 3) -> None:
    """Qué montó Kaggle (para entender un fallo sin adivinar)."""
    base_depth = str(input_dir).count(os.sep)
    for dirpath, dirnames, files in os.walk(input_dir, followlinks=True):
        level = dirpath.count(os.sep) - base_depth
        print(f"[kaggle] {'  ' * level}{Path(dirpath).name}/ {', '.join(sorted(files)[:6])}", flush=True)
        if level >= depth:
            dirnames[:] = []


def unpack(src: Path, dest: Path) -> None:
    """Un zip se extrae; una carpeta (ya extraída por Kaggle) se copia."""
    dest.mkdir(parents=True, exist_ok=True)
    if src.is_file() and zipfile.is_zipfile(src):
        with zipfile.ZipFile(src) as z:
            z.extractall(dest)
    elif src.is_dir():
        shutil.copytree(src, dest, dirs_exist_ok=True)
    else:
        raise SystemExit(f"No sé abrir {src}")


def gpu_model_name(name: str) -> str:
    """`yolo11s_1280_openvino_model` -> `yolo11s.pt`: el mismo detector en PyTorch, que en Kaggle va en la GPU."""
    m = re.fullmatch(r"(yolo[\w.]*?)(?:_\d+)?_openvino_model/?", name.strip())
    return f"{m.group(1)}.pt" if m else name


def patch_detector(yaml_text: str) -> str:
    """Cambia en match.yaml cualquier modelo OpenVINO por su versión .pt (solo en la copia de Kaggle)."""
    return re.sub(r"(yolo[\w.]*?)(?:_\d+)?_openvino_model", lambda m: f"{m.group(1)}.pt", yaml_text)


def snapshot(folder: Path) -> dict[str, tuple[int, float]]:
    return {p.name: (p.stat().st_size, p.stat().st_mtime) for p in folder.glob("*") if p.is_file()} if folder.exists() else {}


def changed(before: dict, after: dict) -> list[str]:
    return sorted(n for n, v in after.items() if before.get(n) != v)


def run_with_budget(cmd: list[str], cwd: Path, hours: float, log: Path) -> tuple[int | None, bool]:
    """Corre `cmd` mostrando y guardando su salida; si pasa del tope, lo corta (a él y a sus hijos)."""
    deadline = time.time() + hours * 3600
    with open(log, "w", encoding="utf-8") as f:
        proc = subprocess.Popen(cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
                                start_new_session=True)
        assert proc.stdout is not None
        os.set_blocking(proc.stdout.fileno(), False)
        while True:
            line = proc.stdout.readline()
            if line:
                sys.stdout.write(line)
                f.write(line)
                continue
            if proc.poll() is not None:
                rest = proc.stdout.read() or ""
                sys.stdout.write(rest)
                f.write(rest)
                return proc.returncode, False
            if time.time() > deadline:
                print(f"\n[kaggle] tope de {hours} h: se corta; lo ya escrito se conserva", flush=True)
                os.killpg(proc.pid, signal.SIGTERM)
                time.sleep(20)
                if proc.poll() is None:
                    os.killpg(proc.pid, signal.SIGKILL)
                return None, True
            time.sleep(0.5)


def main(job: dict) -> int:
    input_dir = Path(job.get("input_dir", "/kaggle/input"))
    root = Path(job.get("root", "/tmp/demo"))
    out = Path(job.get("out_dir", "/kaggle/working/out"))
    match = job["match_id"]
    t0 = time.time()

    show_input(input_dir)
    print(f"[kaggle] armando el repositorio en {root}", flush=True)
    code = find_in_input(input_dir, job["code_slug"], "code.zip", marker="pyproject.toml")
    data = find_in_input(input_dir, job["data_slug"], "data.zip", marker="matches")
    if code is None or data is None:
        raise SystemExit(f"No encuentro {'el código' if code is None else 'los datos del partido'} en {input_dir}")
    unpack(code, root)
    unpack(data, root)
    mdir = root / "matches" / match
    (mdir / "video").mkdir(parents=True, exist_ok=True)
    for vid, slug in job["videos"].items():
        src = find_in_input(input_dir, slug, f"{vid}.mp4")
        if src is None:
            raise SystemExit(f"No encuentro el video {vid} en el conjunto de datos {slug}")
        dst = mdir / "video" / f"{vid}.mp4"
        if dst.exists() or dst.is_symlink():
            dst.unlink()
        try:
            os.symlink(src, dst)
        except OSError:  # sin permiso para enlaces (Windows, en las pruebas): una copia
            shutil.copy2(src, dst)
    yml = mdir / "match.yaml"
    yml.write_text(patch_detector(yml.read_text(encoding="utf-8")), encoding="utf-8")

    if not job.get("dry"):
        print("[kaggle] instalando", flush=True)
        pip = [sys.executable, "-m", "pip", "install", "-q"]
        subprocess.run([*pip, f"ultralytics=={job.get('ultralytics', '8.4.175')}", "lap"], check=True)
        subprocess.run([*pip, "--no-deps", "-e", str(root)], check=True)
        subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv"], check=False)
        subprocess.run([sys.executable, "-c", "import torch; print('[kaggle] CUDA:', torch.cuda.is_available())"], check=False)

    tdir = mdir / "tracking"
    before = snapshot(tdir)
    out.mkdir(parents=True, exist_ok=True)
    code, timed_out = (0, False)
    if not job.get("dry"):
        code, timed_out = run_with_budget([sys.executable, "-m", "sportsan.tracking.overnight", "--match", match], root,
                                          float(job.get("hours", 10.5)), out / "overnight.log")
    new = changed(before, snapshot(tdir))
    dest = out / match / "tracking"
    dest.mkdir(parents=True, exist_ok=True)
    for name in new:
        shutil.copy2(tdir / name, dest / name)
    summary = {"match_id": match, "videos": sorted(job["videos"]), "returncode": code, "timed_out": timed_out,
               "minutes": round((time.time() - t0) / 60, 1), "files": new}
    (out / "summary.json").write_text(json.dumps(summary, indent=1), encoding="utf-8")
    print(f"[kaggle] listo: {len(new)} archivo(s) nuevos en {dest} ({summary['minutes']} min)", flush=True)
    return 0 if code == 0 else 1


if __name__ == "__main__" and JOB:
    sys.exit(main(JOB))

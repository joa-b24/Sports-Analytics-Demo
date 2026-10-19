"""Procesar con GPU en Kaggle. Trabajo A: el tracking (lo mismo que `overnight`) de los videos que le falten a un partido.

Uso (desde la raíz del repo, con .venv activado y `pip install -e ".[cloud]"`):
    python -m sportsan.cloud.kaggle run tracking --match <id> --dry-run     # arma todo en una carpeta, sin subir nada
    python -m sportsan.cloud.kaggle run tracking --match <id>               # sube, corre en GPU, espera y baja
    python -m sportsan.cloud.kaggle run tracking --match <id> --videos v2,v3 --no-wait
    python -m sportsan.cloud.kaggle status --match <id>
    python -m sportsan.cloud.kaggle pull --match <id>                        # baja lo que dejó (si cerraste la laptop)

Qué sube (todo privado en tu cuenta de Kaggle):
  - `sportsan-code`: el código tal como está en esta carpeta (con lo que no tenga commit) y los pesos `.pt` del detector.
  - `sportsan-<partido>-datos`: match.yaml, segments.csv, la fila de videos.csv de cada video y lo que haya en tracking/
    de esos videos (anclas, calibración, biblioteca y partes ya hechas, para que siga donde iba). Sin la plantilla.
  - `sportsan-<partido>-<video>`: cada video, una sola vez (no se vuelve a subir si ya está).
Qué baja: solo los archivos nuevos o cambiados de tracking/. Nunca pisa un archivo tuyo, salvo el índice de partes
(`tracks_<video>_index.json`, que en Kaggle salió de él mismo con lo nuevo añadido; el anterior queda como .bak).

Preparar una vez: cuenta de Kaggle con el teléfono verificado (sin eso no hay GPU ni internet en los cuadernos) y
    python -m sportsan.cloud.kaggle login --user <tu_usuario>
que abre el navegador para iniciar sesión y guarda tu usuario en config/kaggle.local.json (fuera de git).
Las llamadas a Kaggle usan los certificados de Windows (truststore): sin eso, en esta laptop la conexión falla.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import re
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path

from ..config import MATCHES_DIR, load_config, project_root
from ..ingest.download_videos import read_registry
from ..tracking.overnight import plan_video
from .kaggle_job import gpu_model_name

CODE_SLUG = "sportsan-code"
DEFAULT_GPU = "NvidiaTeslaT4"
DEFAULT_HOURS = 10.5
POLL_S = 60
DONE = ("complete", "error", "cancel")


# ------------------------------------------------------------------------------------------------- nombres

def slug(text: str) -> str:
    """Nombre válido de Kaggle (minúsculas, guiones, 6 a 50 caracteres); los largos se acortan con una huella."""
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    if len(s) > 50:
        s = s[:43].rstrip("-") + "-" + hashlib.sha1(s.encode()).hexdigest()[:6]
    return s if len(s) >= 6 else (s + "-sportsan")[:50]


def data_slug(match: str) -> str:
    return slug(f"sportsan-{match}-datos")


def video_slug(match: str, video: str) -> str:
    return slug(f"sportsan-{match}-{video}")


def kernel_slug(match: str) -> str:
    return slug(f"sportsan-tracking-{match}")


# ------------------------------------------------------------------------------------------- qué se manda

def pending(root: Path, match: str, only: list[str] | None = None) -> list:
    """Videos del partido a los que `overnight` aún les haría algo (o los pedidos). Cada uno con su plan."""
    rows = [r for r in read_registry(root / MATCHES_DIR / "videos.csv") if r["match_id"] == match]
    plans = [plan_video(root, match, r["video_id"]) for r in rows]
    if only:
        return [p for p in plans if p.video_id in only]
    return [p for p in plans if not p.missing and p.steps]


def tracking_files(tdir: Path, match: str, videos: list[str]) -> list[Path]:
    """Lo que hay en tracking/ de esos videos y sirve para seguir: anclas, calibración, biblioteca y partes hechas."""
    out: list[Path] = []
    for v in videos:
        pats = [f"anchors_{match}_{v}.json", f"calib_{v}_*.json", f"library_{v}.npz", f"tracks_{v}_index.json"]
        for pat in pats:
            out += sorted(tdir.glob(pat))
        out += sorted(p for p in tdir.glob(f"tracks_{v}_*_*.json") if re.fullmatch(rf"tracks_{re.escape(v)}_\d+_\d+\.json", p.name))
    return out


def detector_models(match_yaml: str) -> list[str]:
    """Pesos .pt que necesitará la GPU: el detector de match.yaml (en su versión .pt) y el de siempre."""
    names = {"yolo11n.pt"}
    m = re.search(r"model:\s*['\"]?([\w./-]+)", match_yaml.split("detector:", 1)[1]) if "detector:" in match_yaml else None
    if m:
        names.add(gpu_model_name(Path(m.group(1)).name))
    return sorted(names)


def build_code_zip(root: Path, dest: Path, models: list[str]) -> list[str]:
    """code.zip: src/, pyproject.toml, config/project.yaml y los pesos pedidos. Devuelve los pesos que no están."""
    missing = []
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as z:
        for p in sorted((root / "src").rglob("*")):
            if p.is_file() and "__pycache__" not in p.parts and p.suffix != ".pyc" and ".egg-info" not in str(p):
                z.write(p, p.relative_to(root).as_posix())
        for rel in ("pyproject.toml", "config/project.yaml"):
            z.write(root / rel, rel)
        for m in models:
            w = root / "weights" / m
            if w.exists():
                z.write(w, f"weights/{m}")
            else:
                missing.append(m)
    return missing


def build_data_zip(root: Path, match: str, videos: list[str], dest: Path) -> list[str]:
    """data.zip: lo del partido que necesita overnight para esos videos. Devuelve lo que metió."""
    mdir = root / MATCHES_DIR / match
    names: list[str] = []
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as z:
        for rel in ("match.yaml", "segments.csv"):
            if (mdir / rel).exists():
                z.write(mdir / rel, f"matches/{match}/{rel}")
                names.append(rel)
        # Solo las filas de esos videos: overnight recorre videos.csv y los demás saldrían como «sin descargar».
        rows = [r for r in read_registry(root / MATCHES_DIR / "videos.csv") if r["match_id"] == match and r["video_id"] in videos]
        buf = io.StringIO()
        if rows:
            w = csv.DictWriter(buf, fieldnames=list(rows[0].keys()), lineterminator="\n")
            w.writeheader()
            w.writerows(rows)
        z.writestr("matches/videos.csv", buf.getvalue())
        for p in tracking_files(mdir / "tracking", match, videos):
            z.write(p, f"matches/{match}/tracking/{p.name}")
            names.append(f"tracking/{p.name}")
    return names


def copy_plan(src_names: list[str], dest_dir: Path, sizes: dict[str, int], force: bool = False) -> list[tuple[str, str]]:
    """Qué hacer con cada archivo bajado: `copy` (no existe aquí), `index` (el índice de partes: se reemplaza y el
    anterior queda como .bak), `replace` (existe distinto y se pidió --force), `skip` (existe igual, o distinto sin
    --force: lo tuyo no se pisa)."""
    out = []
    for n in sorted(src_names):
        d = dest_dir / n
        if not d.exists():
            out.append((n, "copy"))
        elif d.stat().st_size == sizes.get(n):
            out.append((n, "skip"))
        elif n.endswith("_index.json"):
            out.append((n, "index"))
        else:
            out.append((n, "replace" if force else "skip"))
    return out


# ------------------------------------------------------------------------------------------------- Kaggle

def kaggle_exe() -> list[str]:
    """La herramienta de Kaggle, dentro de este Python y con los certificados de Windows (truststore): en esta laptop
    Python no confía en los certificados de los sitios por sí solo y la conexión fallaría."""
    try:
        import kaggle.cli  # noqa: F401
    except ImportError:
        raise SystemExit('Falta la herramienta de Kaggle: pip install -e ".[cloud]"')
    boot = "\n".join([
        "import sys",
        "try:",
        "    import truststore; truststore.inject_into_ssl()",
        "except ImportError:",
        "    pass",
        "sys.argv = ['kaggle'] + sys.argv[1:]",
        "from kaggle.cli import main",
        "main()",
    ])
    return [sys.executable, "-c", boot]


LOCAL_CONFIG = "config/kaggle.local.json"


def username() -> str:
    """Tu usuario de Kaggle: el guardado por `login` (config/kaggle.local.json, fuera de git), KAGGLE_USERNAME o el
    kaggle.json de antes."""
    import os

    if os.environ.get("KAGGLE_USERNAME"):
        return os.environ["KAGGLE_USERNAME"]
    local = project_root() / LOCAL_CONFIG
    if local.exists():
        return json.loads(local.read_text(encoding="utf-8"))["username"]
    legacy = Path.home() / ".kaggle" / "kaggle.json"
    if legacy.exists():
        return json.loads(legacy.read_text(encoding="utf-8"))["username"]
    raise SystemExit("No sé tu usuario de Kaggle. Una vez: python -m sportsan.cloud.kaggle login --user <tu_usuario>")


def login(user: str) -> None:
    """Inicia sesión en Kaggle en el navegador (con los certificados de Windows) y guarda tu usuario."""
    r = subprocess.run([*kaggle_exe(), "auth", "login"])
    if r.returncode != 0:
        raise SystemExit("No se pudo iniciar sesión en Kaggle.")
    local = project_root() / LOCAL_CONFIG
    local.write_text(json.dumps({"username": user}), encoding="utf-8")
    print(f"Sesión iniciada; usuario {user} guardado en {LOCAL_CONFIG}.")


def kaggle(*args: str, check: bool = True) -> subprocess.CompletedProcess:
    r = subprocess.run([*kaggle_exe(), *args], capture_output=True, text=True, encoding="utf-8", errors="replace")
    if check and r.returncode != 0:
        raise SystemExit(f"kaggle {' '.join(args[:2])} falló:\n{r.stdout}\n{r.stderr}")
    return r


def dataset_exists(ref: str) -> bool:
    r = kaggle("datasets", "status", ref, check=False)
    return r.returncode == 0 and "ready" in (r.stdout + r.stderr).lower()


def write_dataset_meta(folder: Path, ref: str, title: str) -> None:
    (folder / "dataset-metadata.json").write_text(json.dumps({"title": title[:50], "id": ref, "licenses": [{"name": "unknown"}]}), encoding="utf-8")


def push_dataset(folder: Path, ref: str, title: str, note: str) -> None:
    write_dataset_meta(folder, ref, title)
    if dataset_exists(ref):
        kaggle("datasets", "version", "-p", str(folder), "-m", note)
    else:
        kaggle("datasets", "create", "-p", str(folder))


def wait_dataset(ref: str, minutes: int = 60) -> None:
    t0 = time.time()
    while not dataset_exists(ref):
        if time.time() - t0 > minutes * 60:
            raise SystemExit(f"{ref} no quedó listo en {minutes} min; revisa en kaggle.com")
        time.sleep(15)


def parse_status(returncode: int, text: str) -> str:
    """Solo cuenta lo que diga Kaggle del cuaderno («has status "KernelWorkerStatus.ERROR"»): si la consulta misma
    falla (red caída), su mensaje también dice «error» y no significa que el cuaderno haya terminado."""
    m = re.search(r'has status "(?:\w+\.)?(\w+)"', text)
    if returncode != 0 or not m:
        return "sin respuesta"
    word = m.group(1).lower()
    return next((w for w in ("complete", "error", "cancel", "running", "queued") if w in word), word)


def kernel_status(ref: str) -> str:
    r = kaggle("kernels", "status", ref, check=False)
    return parse_status(r.returncode, r.stdout + r.stderr)


def job_script(job: dict) -> str:
    src = (Path(__file__).with_name("kaggle_job.py")).read_text(encoding="utf-8")
    return f"JOB = {json.dumps(job, ensure_ascii=False)}\n" + src


def kernel_meta(ref: str, sources: list[str], gpu: bool = True) -> dict:
    return {"id": ref, "title": ref.split("/", 1)[1], "code_file": "job.py", "language": "python", "kernel_type": "script",
            "is_private": True, "enable_gpu": gpu, "enable_tpu": False, "enable_internet": True, "dataset_sources": sources,
            "competition_sources": [], "kernel_sources": [], "model_sources": []}


# ------------------------------------------------------------------------------------------------- comandos

def run_tracking(match: str, videos: list[str] | None, dry: bool, wait: bool, hours: float, gpu: str, force: bool) -> None:
    root = project_root()
    load_config(match=match)  # que el partido exista y su match.yaml se lea
    plans = pending(root, match, videos)
    if not plans:
        print("No hay videos pendientes en este partido (overnight --plan dice lo mismo). Nada que subir.")
        return
    for p in plans:
        what = f"falta: {p.missing}" if p.missing else " -> ".join(p.steps)
        print(f"  {p.video_id}: {what} · {(p.play_s - p.done_s) / 60:.0f} min de juego por procesar")
    bad = [p for p in plans if p.missing]
    if bad:
        raise SystemExit("Resuelve lo que falta (arriba) o quita esos videos con --videos.")
    vids = [p.video_id for p in plans]
    user = "TU_USUARIO" if dry else username()
    stage = Path(tempfile.mkdtemp(prefix=f"kaggle_{match}_"))
    mdir = root / MATCHES_DIR / match

    code_dir, data_dir, kernel_dir = stage / "code", stage / "data", stage / "kernel"
    for d in (code_dir, data_dir, kernel_dir):
        d.mkdir()
    models = detector_models((mdir / "match.yaml").read_text(encoding="utf-8"))
    missing_w = build_code_zip(root, code_dir / "code.zip", models)
    names = build_data_zip(root, match, vids, data_dir / "data.zip")
    video_refs = {v: f"{user}/{video_slug(match, v)}" for v in vids}
    try:
        from importlib.metadata import version as pkg_version

        ultra = pkg_version("ultralytics")
    except Exception:
        ultra = "8.4.175"
    job = {"match_id": match, "code_slug": CODE_SLUG, "data_slug": data_slug(match),
           "videos": {v: video_slug(match, v) for v in vids}, "hours": hours, "ultralytics": ultra}
    (kernel_dir / "job.py").write_text(job_script(job), encoding="utf-8")
    kref = f"{user}/{kernel_slug(match)}"
    sources = [f"{user}/{CODE_SLUG}", f"{user}/{data_slug(match)}", *video_refs.values()]
    (kernel_dir / "kernel-metadata.json").write_text(json.dumps(kernel_meta(kref, sources), indent=1), encoding="utf-8")

    mb = lambda p: p.stat().st_size / 1e6  # noqa: E731
    print(f"Preparado en {stage}:")
    print(f"  código: {mb(code_dir / 'code.zip'):.1f} MB (pesos: {', '.join(m for m in models if m not in missing_w) or 'ninguno'})")
    if missing_w:
        print(f"  aviso: faltan {', '.join(missing_w)} en weights/; Kaggle intentará bajarlos de internet")
    print(f"  datos del partido: {mb(data_dir / 'data.zip'):.1f} MB ({len(names)} archivos)")
    for v in vids:
        print(f"  video {v}: {mb(mdir / 'video' / f'{v}.mp4'):.0f} MB -> {video_refs[v]}")
    print(f"  cuaderno: {kref}, GPU {gpu}, tope {hours} h")
    if dry:
        print("Sin subir nada (--dry-run).")
        return

    print("Subiendo el código y los datos del partido…", flush=True)
    push_dataset(code_dir, f"{user}/{CODE_SLUG}", "sportsan code", f"código {time.strftime('%Y-%m-%d %H:%M')}")
    push_dataset(data_dir, f"{user}/{data_slug(match)}", f"sportsan {match} datos", f"datos {time.strftime('%Y-%m-%d %H:%M')}")
    for v in vids:
        ref = video_refs[v]
        if dataset_exists(ref) and not force:
            print(f"  {v}: ya está en Kaggle, no se vuelve a subir")
            continue
        vdir = stage / f"video_{v}"
        vdir.mkdir()
        try:
            (vdir / f"{v}.mp4").hardlink_to(mdir / "video" / f"{v}.mp4")
        except OSError:
            shutil.copy2(mdir / "video" / f"{v}.mp4", vdir / f"{v}.mp4")
        print(f"  subiendo {v} ({mb(mdir / 'video' / f'{v}.mp4'):.0f} MB); tarda según tu conexión…", flush=True)
        push_dataset(vdir, ref, f"sportsan {match} {v}", "video")
    for ref in sources:
        wait_dataset(ref)
    print("Lanzando el cuaderno con GPU…", flush=True)
    kaggle("kernels", "push", "-p", str(kernel_dir), "--accelerator", gpu)
    print(f"  en marcha: https://www.kaggle.com/code/{kref}")
    if wait:
        wait_and_pull(match, force=False)
    else:
        print(f"Cuando termine: python -m sportsan.cloud.kaggle pull --match {match}")


def wait_and_pull(match: str, force: bool) -> None:
    kref = f"{username()}/{kernel_slug(match)}"
    last = None
    while True:
        st = kernel_status(kref)
        if st != last:
            print(f"  {time.strftime('%H:%M')} {kref}: {st}", flush=True)
            last = st
        if any(w in st for w in DONE):
            break
        time.sleep(POLL_S)
    pull(match, force)


def pull(match: str, force: bool) -> None:
    root = project_root()
    kref = f"{username()}/{kernel_slug(match)}"
    tmp = Path(tempfile.mkdtemp(prefix=f"kaggle_out_{match}_"))
    kaggle("kernels", "output", kref, "-p", str(tmp))
    summary = next(tmp.rglob("summary.json"), None)
    if summary:
        s = json.loads(summary.read_text(encoding="utf-8"))
        print(f"  Kaggle: {s['minutes']} min, código de salida {s['returncode']}{', cortado por el tope' if s['timed_out'] else ''}")
    src = next((p for p in tmp.rglob("tracking") if p.is_dir() and p.parent.name == match), None)
    if src is None:
        print(f"No hay archivos de tracking en la salida (mira el registro en {tmp}).")
        return
    dest = root / MATCHES_DIR / match / "tracking"
    dest.mkdir(parents=True, exist_ok=True)
    files = [p.name for p in src.iterdir() if p.is_file()]
    for name, action in copy_plan(files, dest, {p.name: p.stat().st_size for p in src.iterdir() if p.is_file()}, force):
        if action == "index":
            shutil.copy2(dest / name, dest / f"{name}.bak")
        if action in ("copy", "index", "replace"):
            shutil.copy2(src / name, dest / name)
        print(f"  {action:7s} {name}")
    print(f"Listo. Registro completo en {tmp}")


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="Procesar con GPU en Kaggle.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="sube, corre y baja")
    r.add_argument("job", choices=["tracking"], help="tracking = trabajo A (overnight)")
    r.add_argument("--match", required=True)
    r.add_argument("--videos", help="v2,v3: solo estos (por defecto, los que tengan algo pendiente)")
    r.add_argument("--dry-run", action="store_true", help="arma todo sin subir")
    r.add_argument("--no-wait", action="store_true", help="no espera a que termine")
    r.add_argument("--hours", type=float, default=DEFAULT_HOURS, help="tope de tiempo en Kaggle (la sesión dura como mucho 12 h)")
    r.add_argument("--gpu", default=DEFAULT_GPU, help="NvidiaTeslaT4 (por defecto) o NvidiaTeslaP100")
    r.add_argument("--force", action="store_true", help="vuelve a subir los videos aunque ya estén")
    lg = sub.add_parser("login", help="una vez: inicia sesión en Kaggle y guarda tu usuario")
    lg.add_argument("--user", required=True, help="tu usuario de Kaggle (el de la dirección de tu perfil)")
    for name in ("status", "pull"):
        s = sub.add_parser(name)
        s.add_argument("--match", required=True)
        s.add_argument("--force", action="store_true", help="(pull) reemplaza archivos tuyos distintos")
    a = ap.parse_args(argv)
    if a.cmd == "login":
        login(a.user)
    elif a.cmd == "run":
        run_tracking(a.match, a.videos.split(",") if a.videos else None, a.dry_run, not a.no_wait, a.hours, a.gpu, a.force)
    elif a.cmd == "status":
        print(kernel_status(f"{username()}/{kernel_slug(a.match)}"))
    else:
        pull(a.match, a.force)


if __name__ == "__main__":
    main()

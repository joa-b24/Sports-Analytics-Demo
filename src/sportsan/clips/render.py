"""Exporta a MP4 un clip editado en la app (dibujos y pausas sobre el video) o una jugada del pizarrón.

Uso (desde la raíz del repo, con `pip install -e ".[clips]"`):
    python -m sportsan.clips.render --edit matches/<id>/edits/edit_<id>.json --profile charla
    python -m sportsan.clips.render --edit matches/<id>/edits/edit_<id>.json --profile whatsapp
    python -m sportsan.clips.render --board <board_id> [--profile charla|whatsapp]
    ... --force                       # vuelve a escribir aunque ya exista

Un clip editado sale en matches/<id>/clips/<edit_id>_<perfil>.mp4; una jugada del pizarrón (exportada desde la app a
data/boards/board_<id>.json) en clips/board_<id>_<perfil>.mp4. Lo que ya existe se salta. Nunca toca el video original.
Perfiles: `charla` (1080p, buena calidad, para proyectar) y `whatsapp` (720p, H.264 a ~1.5 Mbps, faststart; rotula
siempre por dorsal aunque la edición diga nombre).
"""
from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path

import numpy as np

from ..config import project_root
from ..ingest.cut_segments import find_ffmpeg
from .geometry import (
    DRAW_PX,
    Projected,
    drawings_at,
    frame_plan,
    h_gap,
    homography_at,
    label_for,
    pitch_to_image,
    project,
    resolve,
    reveal_count,
    snapshot_positions,
)

PROFILES = {
    "charla": {"height": 1080, "codec": ["-preset", "medium", "-crf", "18"], "label_mode": None},
    "whatsapp": {"height": 720, "codec": ["-preset", "medium", "-profile:v", "main", "-b:v", "1500k", "-maxrate", "1500k", "-bufsize", "3000k"], "label_mode": "number"},
}
VIDEO_EXT = (".mp4", ".mkv", ".webm", ".mov")

# Colores de los dibujos (los del tema oscuro de la app, en BGR) y de la cancha y las fichas del pizarrón.
DRAW_BGR = {"accent": (255, 200, 184), "warn": (88, 164, 224), "danger": (138, 128, 240), "ok": (151, 207, 111), "ink": (237, 233, 233)}
BOARD_BGR = {"bg": (38, 24, 22), "pitch": (46, 30, 27), "line": (108, 93, 89), "own": (255, 149, 120), "opp": (99, 154, 243), "ball": (254, 245, 243), "token_text": (38, 24, 22)}
FONT_FILES = ("arialbd.ttf", "DejaVuSans-Bold.ttf", "LiberationSans-Bold.ttf")

# Pizarrón: segundos de espera en cada paso, lo que dura el último y tamaño de las fichas (m). Los de la app.
BOARD_HOLD_S = 1.2
BOARD_TAIL_S = 1.0
TOKEN_R_M, BALL_R_M, BOARD_RING_M = 1.9, 1.1, 3.0
BOARD_SIZE = (1920, 1080)


# ---------------------------------------------------------------------------------------------- ffmpeg

def ffmpeg_args(ffmpeg: str, profile: str, w: int, h: int, fps: float, out: Path) -> list[str]:
    """ffmpeg leyendo cuadros BGR por la entrada estándar y escribiendo el MP4 del perfil (sin audio, sin agrandar)."""
    p = PROFILES[profile]
    height = min(int(h), p["height"])
    return [
        ffmpeg, "-y", "-loglevel", "error",
        "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}", "-r", f"{fps:.6f}", "-i", "-",
        "-an", "-vf", f"scale=-2:{height}", "-c:v", "libx264", *p["codec"],
        "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(out),
    ]


def label_mode_for(edit: dict, profile: str) -> str:
    forced = PROFILES[profile]["label_mode"]
    mode = edit.get("label_mode") or "number"
    return forced if forced and mode == "name" else mode


# --------------------------------------------------------------------------------------------- dibujo

def _font(size: int):
    from PIL import ImageFont

    for name in FONT_FILES:
        for base in (Path("C:/Windows/Fonts"), Path("/usr/share/fonts/truetype/dejavu"), Path("/usr/share/fonts/truetype/liberation")):
            try:
                return ImageFont.truetype(str(base / name), size)
            except OSError:
                continue
    return ImageFont.load_default(size=size)


def _dashed(cv2, img, pts: np.ndarray, color, width: int, dash: float, gap: float, closed: bool):
    seq = list(pts) + ([pts[0]] if closed else [])
    on, left = True, dash
    for a, b in zip(seq[:-1], seq[1:]):
        a, b = np.asarray(a, float), np.asarray(b, float)
        seg = np.linalg.norm(b - a)
        pos = 0.0
        while seg > 0 and pos < seg:
            step = min(left, seg - pos)
            p0, p1 = a + (b - a) * (pos / seg), a + (b - a) * ((pos + step) / seg)
            if on:
                cv2.line(img, tuple(np.round(p0).astype(int)), tuple(np.round(p1).astype(int)), color, width, cv2.LINE_AA)
            pos += step
            left -= step
            if left <= 1e-9:
                on = not on
                left = dash if on else gap
    return img


def draw_items(img: np.ndarray, items: list[Projected], scale: float = 1.0) -> np.ndarray:
    """Dibuja sobre un cuadro BGR lo que da `project` (píxeles de la calibración; `scale` los lleva al cuadro)."""
    import cv2

    h = img.shape[0]
    k = h / 1080
    width = max(1, round(DRAW_PX["stroke"] * k))
    texts = []
    for d in items:
        color = DRAW_BGR.get(d.style.get("color"), DRAW_BGR["accent"])
        dashed = bool(d.style.get("dashed"))
        for path in d.paths:
            pts = np.asarray(path, float) * scale
            if d.closed:
                over = img.copy()
                cv2.fillPoly(over, [np.round(pts).astype(np.int32)], color, cv2.LINE_AA)
                alpha = 0.22 if d.kind == "zone" else 0.12
                img = cv2.addWeighted(over, alpha, img, 1 - alpha, 0)
            if dashed:
                img = _dashed(cv2, img, pts, color, width, 14 * k, 10 * k, d.closed)
            else:
                cv2.polylines(img, [np.round(pts).astype(np.int32)], d.closed, color, width, cv2.LINE_AA)
        if d.head:
            cv2.fillPoly(img, [np.round(np.asarray(d.head, float) * scale).astype(np.int32)], color, cv2.LINE_AA)
        if d.text:
            (x, y), value = d.text
            texts.append(((x * scale, y * scale), value, color, DRAW_PX["text" if d.kind == "text" else "label"] * k))
    if texts:
        from PIL import Image, ImageDraw

        pil = Image.fromarray(img[:, :, ::-1])
        dr = ImageDraw.Draw(pil)
        for (x, y), value, color, size in texts:
            dr.text((x, y), value, font=_font(max(8, round(size))), fill=tuple(reversed(color)), anchor="ms",
                    stroke_width=max(1, round(DRAW_PX["outline"] * k)), stroke_fill=(0, 0, 0))
        img = np.ascontiguousarray(np.asarray(pil)[:, :, ::-1])
    return img


# --------------------------------------------------------------------------------------- clip editado

class FrameReader:
    """Cuadros del video en orden casi siempre creciente: lee seguido y solo salta cuando hace falta."""

    def __init__(self, path: Path):
        import cv2

        self.cv2 = cv2
        self.cap = cv2.VideoCapture(str(path))
        if not self.cap.isOpened():
            raise SystemExit(f"No puedo abrir el video {path}")
        self.fps = self.cap.get(cv2.CAP_PROP_FPS)
        self.size = (int(self.cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(self.cap.get(cv2.CAP_PROP_FRAME_HEIGHT)))
        self.next = 0
        self.last: tuple[int, np.ndarray] | None = None

    def get(self, frame: int) -> np.ndarray:
        if self.last and self.last[0] == frame:
            return self.last[1]
        if frame < self.next or frame - self.next > 90:
            self.cap.set(self.cv2.CAP_PROP_POS_FRAMES, frame)
            self.next = frame
        img = None
        while self.next <= frame:
            ok, img = self.cap.read()
            if not ok:
                raise SystemExit(f"El video se acaba antes del cuadro {frame}")
            self.next += 1
        self.last = (frame, img)
        return img


def find_video(folder: Path, video_id: str) -> Path:
    hits = sorted(p for p in (folder / "video").glob(f"{video_id}.*") if p.suffix.lower() in VIDEO_EXT)
    if not hits:
        raise SystemExit(f"No está el video {video_id} en {folder / 'video'}")
    return hits[0]


def snapshot_from_folder(edit: dict, folder: Path) -> dict | None:
    """Sin copia en la edición: la arma con los archivos de tracking del partido (como hace la app al guardar)."""
    tdir = folder / "tracking"
    fixed_name = edit.get("fixed_file")
    fixed = json.loads((tdir / fixed_name).read_text(encoding="utf-8")) if fixed_name and (tdir / fixed_name).exists() else None
    parts: list[dict] = []
    fps_known: float | None = None
    for p in sorted(tdir.glob(f"tracks_{edit['video_id']}_*_*.json")):
        if p.name.endswith("_index.json"):
            continue
        a, b = (int(x) for x in p.stem.split("_")[-2:])
        # Once the frame rate is known, parts outside the clip are skipped by their name, without reading them.
        if fps_known and (a > edit["t_end"] * fps_known or b < edit["t_start"] * fps_known):
            continue
        t = json.loads(p.read_text(encoding="utf-8"))
        fps_known = t["fps"]
        if not (a > edit["t_end"] * fps_known or b < edit["t_start"] * fps_known):
            parts.append(t)
    if not parts:
        return None
    meta = parts[0]
    calib = [[f["frame"], f.get("H")] for t in parts for f in t["frames"]]
    venue = next((t["venue"] for t in parts if (t.get("venue") or {}).get("length_m")), None) or (fixed or {}).get("venue")
    if not venue and (folder / "match.yaml").exists():
        import yaml

        m = (yaml.safe_load((folder / "match.yaml").read_text(encoding="utf-8")) or {}).get("venue") or {}
        if m.get("pitch_length_m") and m.get("pitch_width_m"):
            venue = {"length_m": m["pitch_length_m"], "width_m": m["pitch_width_m"]}
    if not venue:
        return None
    fps, stride = meta["fps"], meta["stride"]
    f0, f1 = edit["t_start"] * fps - stride, edit["t_end"] * fps + stride
    roster_file = project_root() / "config" / "roster.json"
    roster = json.loads(roster_file.read_text(encoding="utf-8")) if roster_file.exists() else []
    numbers = {r.get("player_id"): r.get("number") for r in roster if isinstance(r, dict)}
    tracks: dict[str, list] = {}
    for fr in (fixed or {}).get("frames", []):
        if f0 <= fr["frame"] <= f1:
            for q in fr["positions"]:
                tracks.setdefault(str(q["id"]), []).append([fr["frame"], q["x"], q["y"], q.get("source", "auto")])
    people = [{"id": p["id"], "team": p.get("team"), "player_id": p.get("player_id"), "number": numbers.get(p.get("player_id"))}
              for p in (fixed or {}).get("people", []) if str(p["id"]) in tracks]
    return {"fps": fps, "stride": stride, "image_w": meta["image_w"], "image_h": meta["image_h"],
            "venue": {"length_m": venue["length_m"], "width_m": venue["width_m"]},
            "homographies": sorted([c for c in calib if f0 <= c[0] <= f1], key=lambda c: c[0]), "people": people, "tracks": tracks}


def _encode(frames, size: tuple[int, int], fps: float, profile: str, out: Path) -> Path:
    out.parent.mkdir(parents=True, exist_ok=True)
    part = out.with_name(out.stem + ".part.mp4")
    proc = subprocess.Popen(ffmpeg_args(find_ffmpeg(), profile, size[0], size[1], fps, part), stdin=subprocess.PIPE)
    try:
        for img in frames:
            proc.stdin.write(np.ascontiguousarray(img).tobytes())
    finally:
        proc.stdin.close()
        code = proc.wait()
    if code != 0:
        part.unlink(missing_ok=True)
        raise SystemExit(f"ffmpeg terminó con error ({code}) al escribir {out.name}")
    part.replace(out)
    return out


def render_edit(edit_path: Path, profile: str = "charla", force: bool = False) -> Path:
    edit_path = Path(edit_path)
    edit = json.loads(edit_path.read_text(encoding="utf-8"))
    folder = edit_path.resolve().parent.parent
    out = folder / "clips" / f"{edit['edit_id']}_{profile}.mp4"
    if out.exists() and not force:
        print(f"ya existe, salto: {out.name}")
        return out
    snap = edit.get("snapshot") or snapshot_from_folder(edit, folder)
    reader = FrameReader(find_video(folder, edit["video_id"]))
    fps, size = reader.fps, reader.size
    position_of = snapshot_positions(snap) if snap else (lambda *_: None)
    mode = label_mode_for(edit, profile)
    image = (snap["image_w"], snap["image_h"]) if snap else size
    scale = size[0] / image[0]
    plan = frame_plan(edit, fps)
    if not snap:
        print("aviso: sin calibración guardada ni en la carpeta; solo sale el texto en pantalla")

    def frames():
        for src, t_video, stop, elapsed in plan:
            shown = reveal_count(stop, elapsed) if stop else 0
            rs = drawings_at(edit, t_video, position_of, stop, shown)
            to = pitch_to_image(homography_at(snap["homographies"], src, h_gap(snap)), snap["venue"]) if snap else None
            items = [p for r in rs if (p := project(r, to, image, lambda i: label_for(i, mode, snap))) is not None]
            yield draw_items(reader.get(src).copy(), items, scale)

    _encode(frames(), size, fps, profile, out)
    print(f"listo: {out} ({len(plan)} cuadros, {len(plan) / fps:.1f} s)")
    return out


# ------------------------------------------------------------------------------------------- pizarrón

def interpolate(keyframes: list[dict], t: float) -> dict | None:
    """Como `interpolate` de la app: recta entre los dos pasos alrededor de t; fija en los extremos."""
    if not keyframes:
        return None
    kfs = sorted(keyframes, key=lambda k: k["t"])
    if t <= kfs[0]["t"]:
        return kfs[0]["pos"]
    if t >= kfs[-1]["t"]:
        return kfs[-1]["pos"]
    i = next(i for i, k in enumerate(kfs) if k["t"] > t)
    a, b = kfs[i - 1], kfs[i]
    f = (t - a["t"]) / (b["t"] - a["t"])
    return {tid: [p[0] + ((b["pos"].get(tid) or p)[0] - p[0]) * f, p[1] + ((b["pos"].get(tid) or p)[1] - p[1]) * f] for tid, p in a["pos"].items()}


def framing_box(framing: str | None) -> tuple[float, float, float, float]:
    if framing == "right":
        return (105 / 2 - 2, -2, 105 / 2 + 4, 68 + 4)
    if framing == "left":
        return (-2, -2, 105 / 2 + 4, 68 + 4)
    return (-2, -2, 105 + 4, 68 + 4)


def board_plan(board: dict, fps: float) -> list[float]:
    """Instantes del pizarrón de cada cuadro de salida: espera en cada paso y luego el movimiento hasta el siguiente."""
    kfs = sorted(board.get("keyframes") or [], key=lambda k: k["t"])
    ts: list[float] = []
    for i, k in enumerate(kfs):
        ts += [k["t"]] * round(BOARD_HOLD_S * fps)
        end = kfs[i + 1]["t"] if i + 1 < len(kfs) else k["t"] + BOARD_TAIL_S
        n = round((end - k["t"]) * fps)
        ts += [k["t"] + (end - k["t"]) * j / n for j in range(n)] if n else []
    return ts


def _pitch_canvas(to, s: float) -> np.ndarray:
    import cv2

    w, h = BOARD_SIZE
    img = np.full((h, w, 3), BOARD_BGR["bg"], np.uint8)
    lw = max(1, round(0.35 * s))
    P = lambda x, y: tuple(int(round(v)) for v in to((x, y)))  # noqa: E731
    cv2.rectangle(img, P(0, 0), P(105, 68), BOARD_BGR["pitch"], -1)
    line = lambda a, b: cv2.line(img, P(*a), P(*b), BOARD_BGR["line"], lw, cv2.LINE_AA)  # noqa: E731
    rect = lambda x, y, rw, rh: cv2.rectangle(img, P(x, y), P(x + rw, y + rh), BOARD_BGR["line"], lw, cv2.LINE_AA)  # noqa: E731
    rect(0, 0, 105, 68)
    line((52.5, 0), (52.5, 68))
    cv2.circle(img, P(52.5, 34), int(round(9.15 * s)), BOARD_BGR["line"], lw, cv2.LINE_AA)
    for x0, sign in ((0, 1), (105, -1)):
        rect(min(x0, x0 + sign * 16.5), 34 - 20.16, 16.5, 40.32)
        rect(min(x0, x0 + sign * 5.5), 34 - 9.16, 5.5, 18.32)
        rect(min(x0, x0 - sign * 1.5), 34 - 3.66, 1.5, 7.32)
        cv2.circle(img, P(x0 + sign * 11, 34), max(1, round(0.4 * s)), BOARD_BGR["line"], -1, cv2.LINE_AA)
        # Media luna: el arco del círculo de 9.15 m alrededor del penal que queda fuera del área.
        ang = np.degrees(np.arccos(5.5 / 9.15))
        start = -ang if sign == 1 else 180 - ang
        cv2.ellipse(img, P(x0 + sign * 11, 34), (int(round(9.15 * s)),) * 2, 0, start, start + 2 * ang, BOARD_BGR["line"], lw, cv2.LINE_AA)
    return img


def render_board(board_ref: str, profile: str = "charla", force: bool = False) -> Path:
    import cv2

    root = project_root()
    path = Path(board_ref) if board_ref.endswith(".json") else root / "data" / "boards" / f"board_{board_ref}.json"
    if not path.exists():
        raise SystemExit(f"No encuentro {path}. Expórtala desde la app: Pizarrón → «Exportar para video».")
    board = json.loads(path.read_text(encoding="utf-8"))
    out = root / "clips" / f"board_{board['board_id']}_{profile}.mp4"
    if out.exists() and not force:
        print(f"ya existe, salto: {out.name}")
        return out
    fps = 30.0
    w, h = BOARD_SIZE
    bx, by, bw, bh = framing_box(board.get("framing"))
    s = min((w - 80) / bw, (h - 80) / bh)
    ox, oy = (w - bw * s) / 2, (h - bh * s) / 2
    to = lambda p: (ox + (p[0] - bx) * s, oy + (p[1] - by) * s)  # noqa: E731
    base = _pitch_canvas(to, s)
    kfs = board.get("keyframes") or []
    tokens = board.get("tokens") or []
    anns = [a for a in board.get("annotations") or []]

    def frames():
        for t in board_plan(board, fps):
            pos = interpolate(kfs, t) or {}
            where = lambda tid, _t: (lambda p: (p[0], p[1]) if p else None)(pos.get(str(tid)))  # noqa: E731
            rs = [r for a in anns if (r := resolve(a, t, where)) is not None]
            items = [p for r in rs if (p := project(r, to, (w, h), ring_m=BOARD_RING_M)) is not None]
            under = [p for p in items if p.kind in ("zone", "line")]
            over = [p for p in items if p.kind not in ("zone", "line")]
            img = draw_items(base.copy(), under)
            for tk in tokens:
                p = pos.get(tk["id"])
                if not p:
                    continue
                c = tuple(int(round(v)) for v in to(p))
                ball = tk["team"] == "ball"
                cv2.circle(img, c, int(round((BALL_R_M if ball else TOKEN_R_M) * s)), BOARD_BGR["ball" if ball else tk["team"]], -1, cv2.LINE_AA)
                if not ball and tk.get("label"):
                    size = 2.2 if len(tk["label"]) <= 2 else 1.6
                    over.append(Projected(f"tok_{tk['id']}", "token", {"size": size}, [], False, None, ((c[0], c[1] + 0.8 * s), tk["label"])))
            yield _draw_board_over(img, over, s)

    plan_len = len(board_plan(board, fps))
    _encode(frames(), (w, h), fps, profile, out)
    print(f"listo: {out} ({plan_len} cuadros, {plan_len / fps:.1f} s)")
    return out


def _draw_board_over(img: np.ndarray, items: list[Projected], s: float) -> np.ndarray:
    """Dibujos sobre las fichas y los dorsales (texto oscuro sobre la ficha)."""
    from PIL import Image, ImageDraw

    drawings = [p for p in items if p.kind != "token"]
    img = draw_items(img, drawings)
    labels = [p for p in items if p.kind == "token"]
    if not labels:
        return img
    pil = Image.fromarray(img[:, :, ::-1])
    dr = ImageDraw.Draw(pil)
    for p in labels:
        (x, y), value = p.text
        dr.text((x, y), value, font=_font(max(8, round(p.style["size"] * s))), fill=tuple(reversed(BOARD_BGR["token_text"])), anchor="ms")
    return np.ascontiguousarray(np.asarray(pil)[:, :, ::-1])


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="Exporta a MP4 un clip editado o una jugada del pizarrón.")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--edit", help="matches/<id>/edits/edit_<id>.json")
    src.add_argument("--board", help="board_id (data/boards/board_<id>.json) o la ruta del archivo")
    ap.add_argument("--profile", choices=sorted(PROFILES), default="charla")
    ap.add_argument("--force", action="store_true", help="vuelve a escribir aunque ya exista")
    a = ap.parse_args(argv)
    if a.edit:
        render_edit(Path(a.edit), a.profile, a.force)
    else:
        render_board(a.board, a.profile, a.force)


if __name__ == "__main__":
    main()

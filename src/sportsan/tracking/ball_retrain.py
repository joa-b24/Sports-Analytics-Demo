"""Reentrena el clasificador de balón con la verdad de los clips (ball_compare) y la mide dejando un clip fuera cada vez.

    python -m sportsan.tracking.ball_retrain loco      # p honesta de cada clip, con un modelo que no lo vio -> feat2_<clip>.pkl
    python -m sportsan.tracking.ball_retrain final     # modelo con los 10 clips -> weights/ball_model_clips.pt

Positivo: candidato a menos de 15 px del balón marcado (suelo o aire). Negativo: cualquier otro candidato de un cuadro con
verdad (visible u «oculto»). Los cuadros sin verdad no entran. Una segunda ronda mina los negativos que la primera confundió.
"""
from __future__ import annotations

import argparse
import pickle
import time
from pathlib import Path

import numpy as np

from ..config import project_root
from . import ball as B
from . import ball_compare as C

NEG_RANDOM = 25000
NEG_HARD = 25000


def load_clip(clip: dict) -> dict:
    """Candidatos de producción del clip con su etiqueta (1/0, -1 = cuadro sin verdad) y la caché de H/cajas."""
    feat = pickle.loads(C.cache_path(clip).read_bytes())
    z = np.load(C.patches_path(clip))
    counts, frames, pts = z["counts"], z["frames"], z["pts"]
    truth, hidden = C.snap(clip, frames.tolist())
    by = {fr["frame"]: fr for fr in feat["frames"]}
    off = np.concatenate([[0], np.cumsum(counts)])
    labels = np.full(int(off[-1]), -1, np.int8)
    for i, f in enumerate(frames.tolist()):
        a, b = int(off[i]), int(off[i + 1])
        if f in truth:
            labels[a:b] = (np.hypot(pts[a:b, 0] - truth[f][0], pts[a:b, 1] - truth[f][1]) <= C.RADIUS_PX * feat["k"]).astype(np.int8)
        elif f in hidden:
            labels[a:b] = 0
    return {"clip": clip, "k": feat["k"], "fps": feat["fps"], "venue": feat["venue"], "stride": feat["stride"], "patches": z["patches"], "counts": counts,
            "frames": frames, "pts": pts, "off": off, "labels": labels, "by": by}


def training_set(ds: list[dict], net=None, seed: int = 0):
    """Positivos + negativos aleatorios (+ los más confundidos por `net`, si hay)."""
    rng = np.random.default_rng(seed)
    P = np.concatenate([d["patches"][d["labels"] == 1] for d in ds])
    negs = np.concatenate([d["patches"][d["labels"] == 0] for d in ds])
    pick = rng.choice(len(negs), size=min(NEG_RANDOM, len(negs)), replace=False)
    N = negs[pick]
    if net is not None:
        score = predict_all(net, negs)
        hard = np.argsort(-score)[:NEG_HARD]
        N = np.concatenate([N, negs[hard]])
    X = np.concatenate([P, N]).astype(np.float32) / 255.0
    y = np.concatenate([np.ones(len(P), np.float32), np.zeros(len(N), np.float32)])
    return X, y


def predict_all(net, patches: np.ndarray, batch: int = 4096) -> np.ndarray:
    import torch

    out = []
    with torch.no_grad():
        for s in range(0, len(patches), batch):
            x = torch.from_numpy(patches[s:s + batch].astype(np.float32) / 255.0)
            out.append(torch.sigmoid(net(x)).numpy().ravel())
    return np.concatenate(out) if out else np.zeros(0, np.float32)


def train_model(ds: list[dict], seed: int = 0):
    X, y = training_set(ds, None, seed)
    net = B.fit(X, y, epochs=10, seed=seed)
    X, y = training_set(ds, net, seed + 1)
    return B.fit(X, y, epochs=10, seed=seed + 1)


def feat_with_p(d: dict, net) -> dict:
    p = predict_all(net, d["patches"])
    frames = []
    for i, f in enumerate(d["frames"].tolist()):
        a, b = int(d["off"][i]), int(d["off"][i + 1])
        fr = d["by"][f]
        frames.append({"frame": f, "pts": d["pts"][a:b], "p": p[a:b], "H": fr["H"], "boxes": fr["boxes"]})
    return {"clip": d["clip"]["id"], "k": d["k"], "fps": d["fps"], "venue": d["venue"], "stride": d["stride"], "frames": frames}


def feat2_path(clip: dict) -> Path:
    return C.cache_path(clip).with_name(f"feat2_{clip['id']}.pkl")


def loco() -> None:
    clips = C.clips_of()
    ds = [load_clip(c) for c in clips]
    for i, d in enumerate(ds):
        t0 = time.time()
        net = train_model(ds[:i] + ds[i + 1:])
        feat2_path(d["clip"]).write_bytes(pickle.dumps(feat_with_p(d, net)))
        print(f"{d['clip']['id']}: modelo sin ese clip listo en {time.time() - t0:.0f} s", flush=True)


def final() -> Path:
    import torch

    ds = [load_clip(c) for c in C.clips_of()]
    net = train_model(ds)
    out = project_root() / "weights" / "ball_model_clips.pt"
    meta = {"matches": sorted({d["clip"]["match"] for d in ds}), "clips": [d["clip"]["id"] for d in ds], "trained": time.strftime("%Y-%m-%d %H:%M"),
            "patch": B.PATCH, "search": "pitch", "positives_from": "clips_verdad"}
    torch.save({"weights": net.state_dict(), "meta": meta}, out)
    print(f"Modelo en {out}")
    return out


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["loco", "final"])
    a = ap.parse_args(argv)
    loco() if a.cmd == "loco" else final()


if __name__ == "__main__":
    main()

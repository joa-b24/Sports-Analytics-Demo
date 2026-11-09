"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { IconButton } from "@/components/Modal";
import { Card, PageHeader, btn } from "@/components/Shell";
import { VideoPlayer, type PlayerHandle } from "@/components/VideoPlayer";
import { isTyping } from "@/lib/format";
import { listLocal, localVideo, readLocal, writeLocal } from "@/lib/local";
import { CaretLeft, CaretRight } from "@phosphor-icons/react";

// TEMPORARY (2026-10-30): ground truth of the ball in a few clips, to compare ball models against the same hand marks.
// Not in the menu. Reads matches/<folder>/tracking/revision/balon/clips.json (clip list) and writes the marks next to it
// (respuestas.json, kind "ball_truth"). Marks are in video pixels at t_video = frame / fps. Python reads them in
// sportsan.tracking.ball_compare. They are NOT training samples (ball_samples_*.json): they only measure.

type Clip = { id: string; video_id: string; fps: number; t0: number; t1: number; label: string; folder: string };
type Sample = { t_video: number; px: [number, number]; aerial: boolean; shadow_px: [number, number] | null };
type ClipTruth = { samples: Sample[]; hidden: number[] };
type Truth = { kind: "ball_truth"; clips: Record<string, ClipTruth> };

const emptyClip = (): ClipTruth => ({ samples: [], hidden: [] });
const r1 = (n: number) => Math.round(n * 10) / 10;
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const STEPS = [1, 3, 6];
const LENS_SRC = 48; // source pixels shown in the magnifier
const LENS_PX = 192;

export default function Page() {
  const [clips, setClips] = useState<Clip[]>([]);
  const [truth, setTruth] = useState<Record<string, Truth>>({});
  const [idx, setIdx] = useState(0);
  const [urls, setUrls] = useState<Record<string, string | null>>({});
  const [status, setStatus] = useState("Buscando los clips…");
  const timer = useRef<number | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const dirs = ((await listLocal("matches")) ?? []).filter((f) => f.dir).map((f) => f.name);
      const all: Clip[] = [];
      const tr: Record<string, Truth> = {};
      for (const d of dirs) {
        const text = await readLocal(`matches/${d}/tracking/revision/balon/clips.json`);
        if (!text) continue;
        for (const c of (JSON.parse(text).clips ?? []) as Omit<Clip, "folder">[]) all.push({ ...c, folder: d });
        const saved = await readLocal(`matches/${d}/tracking/revision/balon/respuestas.json`);
        tr[d] = saved ? JSON.parse(saved) : { kind: "ball_truth", clips: {} };
      }
      if (!live) return;
      setClips(all);
      setTruth(tr);
      setStatus(all.length ? "" : "No hay clips (matches/<partido>/tracking/revision/balon/clips.json).");
    })();
    return () => {
      live = false;
    };
  }, []);

  const clip = clips[idx] ?? null;
  const url = clip ? urls[clip.id] : undefined;
  useEffect(() => {
    if (!clip) return;
    let live = true;
    void localVideo(clip.folder, clip.video_id).then((u) => live && setUrls((all) => ({ ...all, [clip.id]: u })));
    return () => {
      live = false;
    };
  }, [clip]);

  const change = (c: Clip, t: ClipTruth) => {
    const next: Truth = { kind: "ball_truth", clips: { ...truth[c.folder]?.clips, [c.id]: t } };
    setTruth((all) => ({ ...all, [c.folder]: next }));
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      const ok = await writeLocal(`matches/${c.folder}/tracking/revision/balon/respuestas.json`, JSON.stringify(next));
      setStatus(ok ? "Guardado" : "No se pudo guardar en la carpeta (¿la app corre en esta computadora?)");
    }, 400);
  };

  const count = (c: Clip) => {
    const t = truth[c.folder]?.clips[c.id];
    return t ? t.samples.length + t.hidden.length : 0;
  };

  return (
    <div className="mx-auto max-w-[1500px] space-y-4">
      <PageHeader title="Verdad del balón" />
      <p className="max-w-[90ch] text-sm text-muted">
        Sección temporal. Marca el balón con un clic en cada cuadro (avanza solo). <kbd className="kbd">A</kbd> alterna «en el aire», <kbd className="kbd">S</kbd> pide además la
        sombra (clic en el césped bajo el balón), <kbd className="kbd">N</kbd> = no se ve, <kbd className="kbd">Supr</kbd> borra la marca del cuadro, ← → mueven un paso
        (Mayús: un cuadro), <kbd className="kbd">Espacio</kbd> reproduce lento. Se guardan solas. Sirven para medir modelos, no para entrenar.
      </p>
      {clip ? (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <IconButton label="Clip anterior" disabled={idx === 0} onClick={() => setIdx(idx - 1)}>
              <CaretLeft size={16} />
            </IconButton>
            <span className="tc text-sm text-ink">
              Clip {idx + 1} <span className="text-faint">de {clips.length}</span> · {clip.video_id} · {clip.label}
            </span>
            <IconButton label="Clip siguiente" disabled={idx >= clips.length - 1} onClick={() => setIdx(idx + 1)}>
              <CaretRight size={16} />
            </IconButton>
            <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Clips">
              {clips.map((x, i) => (
                <button
                  key={x.id}
                  type="button"
                  title={`${x.video_id} ${x.label} · ${count(x)} marcas`}
                  onClick={() => setIdx(i)}
                  className={`h-3 w-3 rounded-full ${i === idx ? "ring-2 ring-ink ring-offset-2 ring-offset-bg" : ""} ${count(x) ? "bg-accent" : "bg-line-strong hover:bg-muted"}`}
                />
              ))}
            </div>
            <span className="ml-auto text-sm text-muted">{status}</span>
          </div>
          <Card title={`${clip.video_id} · ${clip.label}`}>
            {url === undefined ? (
              <p className="text-sm text-faint">Buscando el video…</p>
            ) : url === null ? (
              <p className="text-sm text-faint">No está el video {clip.video_id} en la carpeta del partido.</p>
            ) : (
              <Marker key={clip.id} clip={clip} url={url} truth={truth[clip.folder]?.clips[clip.id] ?? emptyClip()} onChange={(t) => change(clip, t)} />
            )}
          </Card>
        </>
      ) : (
        <p className="text-sm text-faint">{status}</p>
      )}
    </div>
  );
}

function Marker({ clip, url, truth, onChange }: { clip: Clip; url: string; truth: ClipTruth; onChange: (t: ClipTruth) => void }) {
  const fps = clip.fps;
  const f0 = Math.ceil(clip.t0 * fps);
  const f1 = Math.floor(clip.t1 * fps);
  const ref = useRef<PlayerHandle>(null);
  const box = useRef<HTMLDivElement>(null);
  const lens = useRef<HTMLCanvasElement>(null);
  const [frame, setFrame] = useState(f0);
  const [step, setStep] = useState(3);
  const [aerial, setAerial] = useState(false);
  const [shadow, setShadow] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [size, setSize] = useState({ w: 1920, h: 1080 });
  const [hint, setHint] = useState<string | null>(null);
  const cursor = useRef<[number, number] | null>(null);

  const tOf = (f: number) => r4(f / fps);
  // Marks are keyed by frame: t_video = frame / fps.
  const sampleAt = (f: number) => truth.samples.find((s) => Math.round(s.t_video * fps) === f);
  const hiddenAt = (f: number) => truth.hidden.some((t) => Math.round(t * fps) === f);

  const go = (f: number) => {
    const g = Math.max(f0, Math.min(f1, f));
    setFrame(g);
    ref.current?.pause();
    // Half a frame in, so the browser shows frame g and not the one before.
    ref.current?.seek((g + 0.5) / fps);
  };

  // Once the player can seek: first frame of the clip, paused.
  useEffect(() => {
    const id = window.setInterval(() => {
      const p = ref.current;
      if (p && p.getDuration() > 0) {
        window.clearInterval(id);
        p.setRate(0.25);
        p.seek((f0 + 0.5) / fps);
        const v = box.current?.querySelector("video");
        if (v && v.videoWidth) setSize({ w: v.videoWidth, h: v.videoHeight });
      }
    }, 100);
    return () => window.clearInterval(id);
  }, [f0, fps]);

  const drawLens = () => {
    const v = box.current?.querySelector("video");
    const cv = lens.current;
    const c = cursor.current;
    if (!v || !cv || !c || !v.videoWidth) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const sx = Math.max(0, Math.min(v.videoWidth - LENS_SRC, c[0] - LENS_SRC / 2));
    const sy = Math.max(0, Math.min(v.videoHeight - LENS_SRC, c[1] - LENS_SRC / 2));
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(v, sx, sy, LENS_SRC, LENS_SRC, 0, 0, LENS_PX, LENS_PX);
    ctx.strokeStyle = "rgba(255,255,255,.6)";
    ctx.beginPath();
    ctx.moveTo(LENS_PX / 2, 0);
    ctx.lineTo(LENS_PX / 2, LENS_PX);
    ctx.moveTo(0, LENS_PX / 2);
    ctx.lineTo(LENS_PX, LENS_PX / 2);
    ctx.stroke();
  };
  useEffect(() => {
    const v = box.current?.querySelector("video");
    if (!v) return;
    v.addEventListener("seeked", drawLens);
    return () => v.removeEventListener("seeked", drawLens);
  });

  const toPx = (e: React.MouseEvent<SVGSVGElement>): [number, number] => {
    const r = e.currentTarget.getBoundingClientRect();
    return [r1(((e.clientX - r.left) / r.width) * size.w), r1(((e.clientY - r.top) / r.height) * size.h)];
  };

  const mark = (px: [number, number]) => {
    const t = tOf(frame);
    const cur = sampleAt(frame);
    if (shadow) {
      if (!cur) return setHint("Primero marca el balón de este cuadro; después la sombra.");
      onChange({ ...truth, samples: truth.samples.map((s) => (s === cur ? { ...s, shadow_px: px } : s)) });
      setShadow(false);
      return go(frame + step);
    }
    const rest = truth.samples.filter((s) => s !== cur);
    onChange({
      samples: [...rest, { t_video: t, px, aerial, shadow_px: cur?.shadow_px ?? null }].sort((a, b) => a.t_video - b.t_video),
      hidden: truth.hidden.filter((h) => Math.round(h * fps) !== frame),
    });
    setHint(null);
    go(frame + step);
  };
  const hide = () => {
    onChange({ samples: truth.samples.filter((s) => s !== sampleAt(frame)), hidden: hiddenAt(frame) ? truth.hidden : [...truth.hidden, tOf(frame)].sort((a, b) => a - b) });
    go(frame + step);
  };
  const clear = () => onChange({ samples: truth.samples.filter((s) => s !== sampleAt(frame)), hidden: truth.hidden.filter((h) => Math.round(h * fps) !== frame) });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "arrowright") go(frame + (e.shiftKey ? 1 : step));
      else if (k === "arrowleft") go(frame - (e.shiftKey ? 1 : step));
      else if (k === "a") setAerial((v) => !v);
      else if (k === "s") setShadow((v) => !v);
      else if (k === "n") hide();
      else if (k === "delete" || k === "backspace") clear();
      else if (k === " ") ref.current?.toggle();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // After playing, the frame is where the video stopped.
  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => ref.current && setFrame(Math.max(f0, Math.min(f1, Math.floor(ref.current.getTime() * fps)))), 60);
    return () => window.clearInterval(id);
  }, [playing, f0, f1, fps]);

  const here = sampleAt(frame);
  const trail = useMemo(() => truth.samples.filter((s) => s.t_video < tOf(frame) - 1e-6 && s.t_video >= tOf(frame) - 0.6), [truth, frame]); // eslint-disable-line react-hooks/exhaustive-deps
  const total = Math.floor((f1 - f0) / step) + 1;
  const done = truth.samples.length + truth.hidden.length;
  const rel = (frame - f0) / fps;

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_14rem]">
      <div className="space-y-2">
        <div ref={box} className="relative w-full overflow-hidden rounded-lg bg-black">
          <VideoPlayer ref={ref} fileUrl={url} onPlayState={setPlaying} />
          <svg
            viewBox={`0 0 ${size.w} ${size.h}`}
            preserveAspectRatio="xMidYMid meet"
            className="absolute inset-0 h-full w-full cursor-crosshair"
            onClick={(e) => mark(toPx(e))}
            onPointerMove={(e) => {
              cursor.current = toPx(e as unknown as React.MouseEvent<SVGSVGElement>);
              drawLens();
            }}
          >
            {trail.map((s) => (
              <circle key={s.t_video} cx={s.px[0]} cy={s.px[1]} r={4} fill={s.aerial ? "#fbbf24" : "#4ade80"} opacity={0.55} />
            ))}
            {here && (
              <>
                <circle cx={here.px[0]} cy={here.px[1]} r={12} fill="none" stroke={here.aerial ? "#fbbf24" : "#4ade80"} strokeWidth={2.5} />
                {here.shadow_px && <circle cx={here.shadow_px[0]} cy={here.shadow_px[1]} r={8} fill="none" stroke="#a78bfa" strokeWidth={2.5} strokeDasharray="4 3" />}
              </>
            )}
          </svg>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <button type="button" className={btn} onClick={() => go(frame - step)}>
            ← Atrás
          </button>
          <button type="button" className={btn} onClick={() => go(frame + step)}>
            Adelante →
          </button>
          <span className="tc text-ink">
            {rel.toFixed(2)} s <span className="text-faint">de {(clip.t1 - clip.t0).toFixed(0)}</span> · cuadro {frame}
          </span>
          <span className="text-muted">Paso:</span>
          {STEPS.map((s) => (
            <button key={s} type="button" className={`${btn} ${step === s ? "ring-1 ring-accent" : ""}`} onClick={() => setStep(s)}>
              {s} {s === 1 ? "cuadro" : "cuadros"}
            </button>
          ))}
          <button type="button" className={`${btn} ${aerial ? "ring-1 ring-amber-400" : ""}`} onClick={() => setAerial((v) => !v)}>
            En el aire (A): {aerial ? "sí" : "no"}
          </button>
          <button type="button" className={`${btn} ${shadow ? "ring-1 ring-violet-400" : ""}`} onClick={() => setShadow((v) => !v)}>
            Sombra (S)
          </button>
          <button type="button" className={btn} onClick={hide}>
            No se ve (N)
          </button>
          <button type="button" className={btn} onClick={clear}>
            Borrar (Supr)
          </button>
        </div>
        <p className="text-xs text-muted">
          {hint ?? (shadow ? "Clic en el césped, justo debajo del balón (su sombra)." : here ? `Marcado${here.aerial ? " en el aire" : ""}${here.shadow_px ? " con sombra" : ""}. Un clic nuevo lo reemplaza.` : hiddenAt(frame) ? "Marcado: no se ve." : "Sin marca en este cuadro.")}
        </p>
      </div>
      <div className="space-y-3">
        <canvas ref={lens} width={LENS_PX} height={LENS_PX} className="rounded-lg border border-line bg-black" />
        <p className="tc text-sm text-ink-2">
          {truth.samples.length} balones · {truth.hidden.length} sin verse
          <br />
          <span className="text-faint">
            {done} de unos {total} cuadros (paso de {step})
          </span>
        </p>
      </div>
    </div>
  );
}

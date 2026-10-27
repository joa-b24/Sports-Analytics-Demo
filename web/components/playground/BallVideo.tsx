"use client";

import { useEffect, useRef, useState } from "react";
import { CaretLeft, CaretRight, Pause, Play } from "@phosphor-icons/react";
import { VideoPlayer, type PlayerHandle } from "@/components/VideoPlayer";
import { fmtT } from "@/lib/format";
import { clickToPx, pointsNear, type AutoPoint, type BallSamplesFile } from "@/lib/playground";

export interface BallVideoProps {
  playerRef: React.RefObject<PlayerHandle | null>;
  fileUrl?: string;
  youtubeId?: string;
  image: { w: number; h: number };
  fps: number;
  time: number;
  playing: boolean;
  onTime: (t: number) => void;
  onPlaying: (p: boolean) => void;
  // Clicks on the image become pixels of the video (only while `marking`).
  marking: boolean;
  onClickPx: (px: [number, number], t: number) => void;
  samples: BallSamplesFile;
  auto: AutoPoint[];
  // Aerial mode and shadow mode, to tint the cursor hint.
  hint?: string;
}

const RATES = [0.25, 0.5, 1];

// The video of the Playground with the marks drawn over it (hand samples, tracker points) and, while marking, a layer
// that turns a click into pixels of the video. The bottom strip stays free for the native controls.
export function BallVideo({ playerRef, ...p }: BallVideoProps) {
  const box = useRef<HTMLDivElement>(null);
  const [rate, setRate] = useState(1);
  const { w, h } = p.image;
  const r = Math.max(6, w / 160);
  const near = (t: number) => Math.abs(t - p.time) <= 0.15;
  const here = p.samples.samples.filter((s) => near(s.t_video));
  const noBall = p.samples.negatives.some((n) => near(n.t_video));
  const autoNow = pointsNear(p.auto, p.fps, p.time, 0.4);

  useEffect(() => playerRef.current?.setRate(rate), [rate, playerRef]);

  const step = (s: number) => {
    const pl = playerRef.current;
    if (!pl) return;
    pl.pause();
    pl.seek(Math.max(0, pl.getTime() + s));
  };

  return (
    <div className="space-y-2">
      <div ref={box} className="relative">
        <VideoPlayer ref={playerRef} fileUrl={p.fileUrl} youtubeId={p.youtubeId} onTime={p.onTime} onPlayState={p.onPlaying} />
        <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid meet" className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden>
          {autoNow.map((q) => {
            const c = q.p >= 0.99 ? "var(--color-ok)" : q.p >= 0.95 ? "var(--color-accent-400)" : "var(--color-warn)";
            return (
              <g key={q.frame}>
                <circle cx={q.px} cy={q.py} r={r * 1.3} fill="none" stroke={c} strokeWidth={r / 3} strokeDasharray={`${r} ${r / 2}`} />
                <text x={q.px + r * 1.8} y={q.py - r * 1.2} fontSize={r * 2} fontWeight={700} fill={c} stroke="var(--color-bg)" strokeWidth={r / 4} paintOrder="stroke">
                  {q.p.toFixed(3)}
                </text>
              </g>
            );
          })}
          {here.map((s) => (
            <g key={s.t_video}>
              <circle cx={s.px[0]} cy={s.px[1]} r={r} fill="none" stroke={s.aerial ? "var(--color-warn)" : "var(--color-ok)"} strokeWidth={r / 3} />
              <circle cx={s.px[0]} cy={s.px[1]} r={r / 5} fill={s.aerial ? "var(--color-warn)" : "var(--color-ok)"} />
              {s.shadow_px && <circle cx={s.shadow_px[0]} cy={s.shadow_px[1]} r={r * 0.8} fill="none" stroke="var(--color-faint)" strokeWidth={r / 4} />}
            </g>
          ))}
        </svg>
        {p.marking && (
          <div
            className="absolute inset-x-0 top-0 bottom-14 cursor-crosshair"
            data-testid="ball-click-layer"
            onClick={(e) => {
              const rect = box.current?.getBoundingClientRect();
              if (!rect) return;
              const px = clickToPx({ w: rect.width, h: rect.height }, p.image, { x: e.clientX - rect.left, y: e.clientY - rect.top });
              if (px) p.onClickPx(px, playerRef.current?.getTime() ?? p.time);
            }}
          />
        )}
        {noBall && <span className="tag tag-warn absolute top-3 left-3">Balón no visible aquí</span>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn" onClick={() => step(-1)} aria-label="Retroceder 1 s">
          <CaretLeft size={13} />1 s
        </button>
        <button type="button" className="btn" onClick={() => step(-1 / p.fps)} aria-label="Retroceder un cuadro">
          <CaretLeft size={13} />
          cuadro
        </button>
        <button type="button" className="btn btn-primary" onClick={() => playerRef.current?.toggle()} aria-label={p.playing ? "Pausa" : "Reproducir"}>
          {p.playing ? <Pause size={14} /> : <Play size={14} />}
        </button>
        <button type="button" className="btn" onClick={() => step(1 / p.fps)} aria-label="Avanzar un cuadro">
          cuadro
          <CaretRight size={13} />
        </button>
        <button type="button" className="btn" onClick={() => step(1)} aria-label="Avanzar 1 s">
          1 s<CaretRight size={13} />
        </button>
        <div className="seg ml-auto" role="group" aria-label="Velocidad">
          {RATES.map((x) => (
            <button key={x} type="button" className="seg-opt" aria-pressed={rate === x} onClick={() => setRate(x)}>
              {x}×
            </button>
          ))}
        </div>
        <span className="num text-sm text-ink-2">{fmtT(p.time)}</span>
      </div>
      {p.hint && <p className="m-0 text-[11px] text-faint">{p.hint}</p>}
    </div>
  );
}

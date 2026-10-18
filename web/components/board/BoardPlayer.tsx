"use client";

import { Pause, Play } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { BoardView } from "@/components/board/BoardView";
import { SpeedControl } from "@/components/SpeedControl";
import { btnPrimary } from "@/components/Shell";
import { keyframePositions, resolveAll } from "@/lib/annotations";
import { boardDuration } from "@/lib/boards";
import { isTyping } from "@/lib/format";
import { interpolate } from "@/lib/stats";
import type { Board } from "@/lib/types";

// Real seconds the animation waits on each step (at 1x) when it stops at the steps.
const HOLD_S = 1.2;

// The board animated between its steps; drawings come in at their t_in.
export function BoardPlayer({ board }: { board: Board }) {
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [hold, setHold] = useState(true);
  const tRef = useRef(0);
  const duration = boardDuration(board);
  const ctx = useMemo(() => keyframePositions(board.keyframes), [board.keyframes]);

  const seek = (v: number) => {
    tRef.current = v;
    setT(v);
  };

  useEffect(() => {
    if (!playing) return;
    const stops = board.keyframes.map((k) => k.t);
    let last = performance.now();
    // Starting on a step waits there too, so its drawings can be seen before the pieces move.
    let holdUntil = hold && stops.some((s) => Math.abs(s - tRef.current) < 1e-6) ? last + (HOLD_S * 1000) / rate : 0;
    let raf = 0;
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      if (now >= holdUntil) {
        const prev = tRef.current;
        let next = prev + dt * rate;
        if (hold) {
          const stop = stops.find((s) => s > prev + 1e-6 && s <= next);
          if (stop !== undefined) {
            next = stop;
            holdUntil = now + (HOLD_S * 1000) / rate;
          }
        }
        if (next >= duration) {
          tRef.current = duration;
          setT(duration);
          setPlaying(false);
          return;
        }
        tRef.current = next;
        setT(next);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, rate, hold, duration, board.keyframes]);

  const toggle = () => {
    if (!playing && tRef.current >= duration - 1e-6) seek(0);
    setPlaying((p) => !p);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== " " || isTyping(e.target)) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const stepNow = board.keyframes.reduce((acc, k, i) => (k.t <= t + 1e-6 ? i : acc), 0);
  const note = board.keyframes[stepNow]?.note;

  return (
    <div className="space-y-3">
      <BoardView framing={board.framing} tokens={board.tokens} positions={interpolate(board.keyframes, t)} drawings={resolveAll(board.annotations, t, ctx)} />
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={btnPrimary} onClick={toggle} aria-label={playing ? "Pausar" : "Reproducir"}>
          {playing ? <Pause size={14} weight="fill" /> : <Play size={14} weight="fill" />}
          {playing ? "Pausa" : "Reproducir"}
        </button>
        <input
          type="range"
          aria-label="Momento de la jugada"
          className="min-w-40 flex-1"
          min={0}
          max={duration}
          step={0.05}
          value={t}
          onChange={(e) => {
            setPlaying(false);
            seek(Number(e.target.value));
          }}
        />
        <span className="tc text-xs text-muted">
          Paso {stepNow + 1} de {board.keyframes.length}
        </span>
        <SpeedControl rate={rate} onChange={setRate} min={0.25} max={3} step={0.25} />
        <label className="flex items-center gap-1.5 text-xs text-muted">
          <input type="checkbox" checked={hold} onChange={(e) => setHold(e.target.checked)} />
          Detenerse en cada paso
        </label>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {board.keyframes.map((k, i) => (
          <button
            key={`${k.t}_${i}`}
            type="button"
            aria-pressed={i === stepNow}
            className={`rounded-full border px-3 py-1 text-xs transition-colors ${i === stepNow ? "border-accent bg-accent/20 text-accent-100" : "border-line text-ink-2 hover:border-line-strong"}`}
            onClick={() => {
              setPlaying(false);
              seek(k.t);
            }}
          >
            Paso {i + 1}
          </button>
        ))}
      </div>
      {note && <p className="text-sm text-ink-2">{note}</p>}
      <p className="text-xs text-faint">Espacio reproduce o pausa. Entre pasos el movimiento es una interpolación en línea recta: es un esquema, no una medición.</p>
    </div>
  );
}

"use client";

import { Pause, Play } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { BoardView } from "@/components/board/BoardView";
import { SpeedControl } from "@/components/SpeedControl";
import { btnPrimary } from "@/components/Shell";
import { FitAspect, SidePanel, StudioFrame, type FrameLayout } from "@/components/studio/Studio";
import { keyframePositions, resolveAll } from "@/lib/annotations";
import { boardDuration, framingBox } from "@/lib/boards";
import { isTyping } from "@/lib/format";
import { interpolate } from "@/lib/stats";
import type { Board } from "@/lib/types";

// Real seconds the animation waits on each step (at 1x) when it stops at the steps.
const HOLD_S = 1.2;

// The board animated between its steps; drawings come in at their t_in.
type Panel = "steps" | "list";
const PANEL_TABS: [Panel, string][] = [
  ["steps", "Pasos"],
  ["list", "Jugadas"],
];

export function BoardPlayer({ board, header, listPanel, layout }: { board: Board; header: ReactNode; listPanel: ReactNode; layout: FrameLayout }) {
  const [panel, setPanel] = useState<Panel>("steps");
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

  const [, , vw, vh] = framingBox(board.framing);

  return (
    <StudioFrame
      {...layout}
      header={header}
      canvas={
        <div className="flex h-full flex-col">
          <p className="mb-1 min-h-5 truncate px-1 text-xs text-faint">
            {note ? <span className="text-ink-2">{note}</span> : "Entre pasos el movimiento es una interpolación en línea recta: es un esquema, no una medición."}
          </p>
          <div className="min-h-0 flex-1">
            <FitAspect aspect={vw / vh}>
              <BoardView framing={board.framing} fit tokens={board.tokens} positions={interpolate(board.keyframes, t)} drawings={resolveAll(board.annotations, t, ctx)} />
            </FitAspect>
          </div>
        </div>
      }
      controls={
        <>
          <button
            type="button"
            className={`${btnPrimary} h-9 w-9 !p-0`}
            onClick={toggle}
            aria-label={playing ? "Pausar (espacio)" : "Reproducir (espacio)"}
            title={playing ? "Pausar (espacio)" : "Reproducir (espacio)"}
          >
            {playing ? <Pause size={16} weight="fill" /> : <Play size={16} weight="fill" />}
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
          <span className="tc tag">
            Paso {stepNow + 1}/{board.keyframes.length}
          </span>
          <SpeedControl rate={rate} onChange={setRate} min={0.25} max={3} step={0.25} />
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <input type="checkbox" checked={hold} onChange={(e) => setHold(e.target.checked)} />
            Detenerse en cada paso
          </label>
        </>
      }
      side={
        <SidePanel tabs={PANEL_TABS} value={panel} onChange={setPanel}>
          {panel === "steps" ? (
            <ol className="space-y-1.5">
              {board.keyframes.map((k, i) => (
                <li key={`${k.t}_${i}`}>
                  <button
                    type="button"
                    aria-pressed={i === stepNow}
                    className={`flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs transition-colors ${
                      i === stepNow ? "bg-accent-900 text-ink ring-1 ring-accent/60" : "text-ink-2 hover:bg-raised"
                    }`}
                    onClick={() => {
                      setPlaying(false);
                      seek(k.t);
                    }}
                  >
                    <span className={`tc grid h-6 w-6 shrink-0 place-items-center rounded-md font-semibold ${i === stepNow ? "bg-ink text-bg" : "bg-raised"}`}>{i + 1}</span>
                    <span className="min-w-0 pt-1">{k.note || <span className="text-faint">Sin nota</span>}</span>
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            listPanel
          )}
        </SidePanel>
      }
    />
  );
}

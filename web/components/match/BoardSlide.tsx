"use client";

import { Pause, Play } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { BoardView } from "@/components/board/BoardView";
import { keyframePositions, resolveAll } from "@/lib/annotations";
import { boardDuration, boardFromPlay, boardsOf } from "@/lib/boards";
import type { Slide } from "@/lib/deck";
import { interpolate } from "@/lib/stats";
import type { Board, State } from "@/lib/types";

// Real seconds the animation waits on each step (at 1x).
const HOLD_S = 1.2;

// The board a «board» slide points to: a board of the pizarrón, or a play of the match turned into one.
export function boardOfSlide(state: Pick<State, "boards" | "plays">, s: Slide): Board | null {
  if (s.board) return boardsOf(state).find((b) => b.board_id === s.board) ?? null;
  const play = s.play ? (state.plays ?? []).find((p) => p.play_id === s.play) : undefined;
  return play ? boardFromPlay(play, `play_${play.play_id}`) : null;
}

// The animation inside a slide: play / pause, a slider and the note of each step. `live` starts it by itself (full screen).
export function BoardSlide({ board, live = false }: { board: Board | null; live?: boolean }) {
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(live);
  const tRef = useRef(0);
  const duration = board ? boardDuration(board) : 0;
  const ctx = useMemo(() => keyframePositions(board?.keyframes ?? []), [board]);
  useEffect(() => {
    if (!playing || !board) return;
    const stops = board.keyframes.map((k) => k.t);
    let last = performance.now();
    let holdUntil = last + HOLD_S * 1000;
    let raf = 0;
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      if (now >= holdUntil) {
        const prev = tRef.current;
        let next = prev + dt;
        const stop = stops.find((x) => x > prev + 1e-6 && x <= next);
        if (stop !== undefined) {
          next = stop;
          holdUntil = now + HOLD_S * 1000;
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
  }, [playing, board, duration]);
  if (!board)
    return <div className="absolute inset-0 grid place-items-center bg-bg p-8 text-center text-sm text-muted">La animación de esta diapositiva ya no existe (se borró del pizarrón o de Jugadas).</div>;
  const stepNow = board.keyframes.reduce((acc, k, i) => (k.t <= t + 1e-6 ? i : acc), 0);
  const note = board.keyframes[stepNow]?.note;
  const toggle = () => {
    if (!playing && tRef.current >= duration - 1e-6) {
      tRef.current = 0;
      setT(0);
    }
    setPlaying((p) => !p);
  };
  return (
    <div className="absolute inset-0 flex flex-col bg-surface">
      <div className="min-h-0 flex-1 p-2">
        <BoardView framing={board.framing} fit tokens={board.tokens} positions={interpolate(board.keyframes, t)} drawings={resolveAll(board.annotations, t, ctx)} />
      </div>
      <div className="flex items-center gap-3 bg-bg/80 px-3 py-1.5">
        <button type="button" className="btn btn-primary h-8 w-8 !p-0" aria-label={playing ? "Pausar" : "Reproducir"} onClick={toggle}>
          {playing ? <Pause size={14} weight="fill" /> : <Play size={14} weight="fill" />}
        </button>
        <input
          type="range"
          aria-label="Momento de la animación"
          className="min-w-24 flex-1"
          min={0}
          max={duration}
          step={0.05}
          value={t}
          onChange={(e) => {
            setPlaying(false);
            tRef.current = Number(e.target.value);
            setT(tRef.current);
          }}
        />
        <span className="tc text-xs text-faint">
          Paso {stepNow + 1}/{board.keyframes.length}
        </span>
        {note && <span className="max-w-[40%] min-w-0 truncate text-xs text-ink-2">{note}</span>}
      </div>
    </div>
  );
}

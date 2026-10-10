"use client";

import { useRef, useState, type RefObject } from "react";
import { COLORS, Pitch, toMeters } from "@/components/Pitch";
import { Card, btn, btnPrimary, input } from "@/components/Shell";
import type { PlayerHandle } from "@/components/VideoPlayer";
import { fmtT } from "@/lib/format";
import { TOKENS, defaultPositions, interpolate } from "@/lib/stats";
import { mutate, uid } from "@/lib/store";
import type { Keyframe, Match, Play } from "@/lib/types";

type Props = {
  match: Match;
  plays: Play[];
  time: number;
  playerRef: RefObject<PlayerHandle | null>;
  playClip: (t0: number, t1: number) => void;
};

// A keyframe counts as "open for editing" while the video sits on it.
const KF_TOLERANCE = 0.75;

export function PlaysTab({ match, plays, time, playerRef, playClip }: Props) {
  const [selId, setSelId] = useState<string | null>(plays[0]?.play_id ?? null);
  const [selKf, setSelKf] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const play = plays.find((p) => p.play_id === selId) ?? null;

  const patch = (id: string, p: Partial<Play>) =>
    mutate((s) => ({ ...s, plays: s.plays.map((x) => (x.play_id === id ? { ...x, ...p } : x)) }));

  const create = () => {
    const id = uid("p");
    const t = Math.round(time * 10) / 10;
    mutate((s) => ({
      ...s,
      plays: [...s.plays, { play_id: id, match_id: match.match_id, title: `Jugada ${fmtT(t)}`, t_start: t, t_end: t + 15, note: "", keyframes: [] }],
    }));
    setSelId(id);
    setSelKf(null);
  };

  const kfs: Keyframe[] = play ? [...play.keyframes].sort((a, b) => a.t - b.t) : [];
  const editing = selKf !== null && kfs[selKf] && Math.abs(time - kfs[selKf].t) < KF_TOLERANCE ? selKf : null;
  const shown = editing !== null ? kfs[editing].pos : interpolate(kfs, time);

  const addKeyframe = () => {
    if (!play) return;
    playerRef.current?.pause();
    const t = Math.round(time * 10) / 10;
    const near = kfs.findIndex((k) => Math.abs(k.t - t) < 0.2);
    if (near >= 0) {
      setSelKf(near);
      return;
    }
    const next = [...kfs, { t, pos: { ...(interpolate(kfs, t) ?? defaultPositions()) } }].sort((a, b) => a.t - b.t);
    patch(play.play_id, { keyframes: next });
    setSelKf(next.findIndex((k) => k.t === t));
  };

  const commitDrag = () => {
    if (!play || !drag || editing === null) return setDrag(null);
    const next = kfs.map((k, i) => (i === editing ? { ...k, pos: { ...k.pos, [drag.id]: [drag.x, drag.y] as [number, number] } } : k));
    patch(play.play_id, { keyframes: next });
    setDrag(null);
  };

  return (
    <div className="space-y-4">
      <Card title="Jugadas">
        <div className="flex flex-wrap gap-2">
          {plays.map((p) => (
            <button
              key={p.play_id}
              type="button"
              onClick={() => {
                setSelId(p.play_id);
                setSelKf(null);
              }}
              className={`rounded-md border px-3 py-1.5 text-left text-sm ${
                p.play_id === selId ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 bg-white text-slate-800"
              }`}
            >
              <div className="font-medium">{p.title}</div>
              <div className="font-mono text-[11px] opacity-70">
                {fmtT(p.t_start)} – {fmtT(p.t_end)}
              </div>
            </button>
          ))}
          <button type="button" className={btn} onClick={create}>
            + Nueva jugada en {fmtT(time)}
          </button>
        </div>
        {plays.length === 0 && (
          <p className="mt-2 text-sm text-slate-500">
            Una jugada es un tramo del video (inicio y fin). También puedes crearla desde un evento con «+ jugada».
          </p>
        )}
      </Card>

      {play && (
        <Card>
          <div className="flex flex-wrap items-center gap-2">
            <input
              className={`${input} min-w-0 flex-1 font-medium`}
              value={play.title}
              aria-label="Título de la jugada"
              onChange={(e) => patch(play.play_id, { title: e.target.value })}
            />
            <button type="button" className={btnPrimary} onClick={() => playClip(play.t_start, play.t_end)}>
              ▶ Reproducir clip
            </button>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-600">
            <span className="font-mono tabular-nums">
              Inicio {fmtT(play.t_start)} · Fin {fmtT(play.t_end)} · Ahora {fmtT(time)}
            </span>
            <button type="button" className="underline" onClick={() => patch(play.play_id, { t_start: Math.round(time * 10) / 10 })}>
              inicio = ahora
            </button>
            <button type="button" className="underline" onClick={() => patch(play.play_id, { t_end: Math.round(time * 10) / 10 })}>
              fin = ahora
            </button>
            <button
              type="button"
              className="ml-auto text-red-700 underline"
              onClick={() => {
                mutate((s) => ({ ...s, plays: s.plays.filter((x) => x.play_id !== play.play_id) }));
                setSelId(null);
              }}
            >
              borrar jugada
            </button>
          </div>

          <div className="mt-4 border-t border-slate-100 pt-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-slate-900">Animación de cancha</span>
              <button type="button" className={btn} onClick={addKeyframe}>
                + Keyframe en {fmtT(time)}
              </button>
              {kfs.map((k, i) => (
                <span key={k.t} className="inline-flex items-center">
                  <button
                    type="button"
                    onClick={() => {
                      playerRef.current?.pause();
                      playerRef.current?.seek(k.t);
                      setSelKf(i);
                    }}
                    className={`rounded-l-md border px-2 py-1 font-mono text-xs ${
                      editing === i ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 bg-white text-slate-700"
                    }`}
                  >
                    {fmtT(k.t)}
                  </button>
                  <button
                    type="button"
                    title="Borrar keyframe"
                    onClick={() => {
                      patch(play.play_id, { keyframes: kfs.filter((_, j) => j !== i) });
                      setSelKf(null);
                    }}
                    className="rounded-r-md border border-l-0 border-slate-300 bg-white px-1.5 py-1 text-xs text-slate-500"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            <p className="mb-2 text-xs text-slate-600">
              {kfs.length === 0
                ? "Pausa el video en un momento clave y añade un keyframe: coloca a las jugadoras arrastrándolas. Con dos o más, la app interpola el movimiento y lo sincroniza con el clip."
                : editing !== null
                  ? "Editando este keyframe: arrastra jugadoras y balón."
                  : "Vista interpolada (solo lectura). Pulsa un keyframe para editarlo."}
            </p>
            <Pitch
              svgRef={svgRef}
              className={editing !== null ? "touch-none" : ""}
              onPointerMove={(e) => {
                if (drag && svgRef.current) {
                  const p = toMeters(svgRef.current, e);
                  setDrag({ id: drag.id, x: p.x, y: p.y });
                }
              }}
              onPointerUp={commitDrag}
              onPointerLeave={commitDrag}
            >
              {shown &&
                TOKENS.map((tk) => {
                  const base = shown[tk.id];
                  if (!base) return null;
                  const [x, y] = drag?.id === tk.id ? [drag.x, drag.y] : base;
                  const isBall = tk.team === "ball";
                  return (
                    <g
                      key={tk.id}
                      transform={`translate(${x} ${y})`}
                      className={editing !== null ? "cursor-grab" : ""}
                      onPointerDown={(e) => {
                        if (editing === null) return;
                        e.preventDefault();
                        setDrag({ id: tk.id, x, y });
                      }}
                    >
                      <circle
                        r={isBall ? 1.1 : 1.9}
                        fill={isBall ? COLORS.ball : tk.team === "own" ? COLORS.own : COLORS.opp}
                        stroke="#ffffff"
                        strokeWidth={0.4}
                      />
                      {!isBall && (
                        <text y={0.85} textAnchor="middle" fontSize={2.2} fontWeight={600} fill="#ffffff" pointerEvents="none">
                          {tk.label}
                        </text>
                      )}
                    </g>
                  );
                })}
            </Pitch>
            <div className="mt-1 flex flex-wrap gap-4 text-xs text-slate-600">
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: COLORS.own }} />
                {match.focus_team}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: COLORS.opp }} />
                {match.other_team}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: COLORS.ball }} />
                Balón
              </span>
              <span className="text-slate-500">Posiciones colocadas a mano: son un esquema, no una medición.</span>
            </div>
          </div>

          <textarea
            className={`${input} mt-3 w-full`}
            rows={2}
            placeholder="Nota de la jugada (qué observar)"
            value={play.note}
            onChange={(e) => patch(play.play_id, { note: e.target.value })}
          />
        </Card>
      )}
    </div>
  );
}

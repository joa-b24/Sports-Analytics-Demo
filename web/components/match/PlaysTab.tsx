"use client";

import {
  BracketsSquare,
  Play as PlayIcon,
  Plus,
  Trash,
} from "@phosphor-icons/react";
import { IconButton } from "@/components/Modal";
import { useRef, useState, type RefObject } from "react";
import { COLORS, Pitch, toMeters } from "@/components/Pitch";
import { Card, btn, btnPrimary, input } from "@/components/Shell";
import type { PlayerHandle } from "@/components/VideoPlayer";
import { useFixedParts } from "@/lib/fixed";
import { fmtT } from "@/lib/format";
import { partFor, positionsAt } from "@/lib/positions";
import { TOKENS, defaultPositions, interpolate } from "@/lib/stats";
import { mutate, uid } from "@/lib/store";
import type { Keyframe, Match, Play } from "@/lib/types";

type Props = {
  match: Match;
  videoId: string;
  plays: Play[];
  time: number;
  playerRef: RefObject<PlayerHandle | null>;
  playClip: (t0: number, t1: number) => void;
};

// A keyframe counts as "open for editing" while the video sits on it.
const KF_TOLERANCE = 0.75;

export function PlaysTab({
  match,
  videoId,
  plays,
  time,
  playerRef,
  playClip,
}: Props) {
  const [selId, setSelId] = useState<string | null>(plays[0]?.play_id ?? null);
  const [selKf, setSelKf] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(
    null,
  );
  const svgRef = useRef<SVGSVGElement>(null);
  const play = plays.find((p) => p.play_id === selId) ?? null;
  // Measured positions (corrected parts saved from the correction table) when the play falls in one.
  const fixed = useFixedParts(match.folder, [videoId]);
  const [source, setSource] = useState<"measured" | "hand">("measured");
  const part =
    play && fixed
      ? partFor(fixed.parts, videoId, play.t_start, play.t_end)
      : null;
  const measuredOn = part !== null && source === "measured";
  const measured = measuredOn && part ? positionsAt(part, time) : null;

  const patch = (id: string, p: Partial<Play>) =>
    mutate((s) => ({
      ...s,
      plays: s.plays.map((x) => (x.play_id === id ? { ...x, ...p } : x)),
    }));

  const create = () => {
    const id = uid("p");
    const t = Math.round(time * 10) / 10;
    mutate((s) => ({
      ...s,
      plays: [
        ...s.plays,
        {
          play_id: id,
          match_id: match.match_id,
          video_id: videoId,
          title: `Jugada ${fmtT(t)}`,
          t_start: t,
          t_end: t + 15,
          note: "",
          keyframes: [],
        },
      ],
    }));
    setSelId(id);
    setSelKf(null);
  };

  const kfs: Keyframe[] = play
    ? [...play.keyframes].sort((a, b) => a.t - b.t)
    : [];
  const editing =
    selKf !== null && kfs[selKf] && Math.abs(time - kfs[selKf].t) < KF_TOLERANCE
      ? selKf
      : null;
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
    const next = [
      ...kfs,
      { t, pos: { ...(interpolate(kfs, t) ?? defaultPositions()) } },
    ].sort((a, b) => a.t - b.t);
    patch(play.play_id, { keyframes: next });
    setSelKf(next.findIndex((k) => k.t === t));
  };

  const commitDrag = () => {
    if (!play || !drag || editing === null) return setDrag(null);
    const next = kfs.map((k, i) =>
      i === editing
        ? {
            ...k,
            pos: { ...k.pos, [drag.id]: [drag.x, drag.y] as [number, number] },
          }
        : k,
    );
    patch(play.play_id, { keyframes: next });
    setDrag(null);
  };

  return (
    <div className="space-y-5">
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
              aria-pressed={p.play_id === selId}
              className={`rounded-2xl border px-4 py-2 text-left text-sm transition-[background-color,border-color,transform] duration-200 hover:-translate-y-0.5 ${
                p.play_id === selId
                  ? "border-accent bg-accent/20 text-accent-100"
                  : "border-line bg-transparent text-ink-2 hover:border-line-strong"
              }`}
            >
              <div className="font-medium">{p.title}</div>
              <div className="tc text-[11px] opacity-70">
                {fmtT(p.t_start)} – {fmtT(p.t_end)}
              </div>
            </button>
          ))}
          <button type="button" className={btn} onClick={create}>
            <Plus size={14} />
            Nueva jugada en <span className="tc">{fmtT(time)}</span>
          </button>
        </div>
        {plays.length === 0 && (
          <p className="mt-2 text-sm text-faint">
            Una jugada es un tramo del video (inicio y fin). También puedes
            crearla desde un evento con «+ jugada».
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
            <button
              type="button"
              className={btnPrimary}
              onClick={() => playClip(play.t_start, play.t_end)}
            >
              <PlayIcon size={14} weight="fill" />
              Reproducir clip
            </button>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
            <span className="tc">
              Inicio {fmtT(play.t_start)} · Fin {fmtT(play.t_end)} · Ahora{" "}
              {fmtT(time)}
            </span>
            <IconButton
              label="El inicio es el momento actual del video"
              onClick={() =>
                patch(play.play_id, { t_start: Math.round(time * 10) / 10 })
              }
            >
              <BracketsSquare size={14} className="-scale-x-100" />
            </IconButton>
            <IconButton
              label="El fin es el momento actual del video"
              onClick={() =>
                patch(play.play_id, { t_end: Math.round(time * 10) / 10 })
              }
            >
              <BracketsSquare size={14} />
            </IconButton>
            <span className="ml-auto">
              <IconButton
                label="Borrar la jugada"
                tone="danger"
                onClick={() => {
                  mutate((s) => ({
                    ...s,
                    plays: s.plays.filter((x) => x.play_id !== play.play_id),
                  }));
                  setSelId(null);
                }}
              >
                <Trash size={14} />
              </IconButton>
            </span>
          </div>

          <div className="hr-fade mt-5" />
          <div className="pt-4">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="font-display text-base text-ink">
                Animación de cancha
              </span>
              {part && (
                <div className="seg">
                  {(
                    [
                      ["measured", "Posiciones medidas"],
                      ["hand", "A mano"],
                    ] as const
                  ).map(([k, label]) => (
                    <button
                      key={k}
                      type="button"
                      aria-pressed={source === k}
                      className="seg-opt"
                      onClick={() => setSource(k)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
              {!measuredOn && (
                <>
                  <button type="button" className={btn} onClick={addKeyframe}>
                    <Plus size={14} />
                    Keyframe en <span className="tc">{fmtT(time)}</span>
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
                        className={`tc rounded-l-full border py-1 pr-2 pl-3 text-xs transition-colors ${
                          editing === i
                            ? "border-accent bg-accent/20 text-accent-100"
                            : "border-line bg-transparent text-ink-2"
                        }`}
                      >
                        {fmtT(k.t)}
                      </button>
                      <button
                        type="button"
                        title="Borrar keyframe"
                        onClick={() => {
                          patch(play.play_id, {
                            keyframes: kfs.filter((_, j) => j !== i),
                          });
                          setSelKf(null);
                        }}
                        className="rounded-r-full border border-l-0 border-line py-1 pr-2.5 pl-1.5 text-xs text-faint transition-colors hover:text-danger"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </>
              )}
            </div>
            <p className="mb-2 text-xs text-muted">
              {measuredOn
                ? measured
                  ? "Posiciones medidas por el tracking corregido, sincronizadas con el video. Solo salen las jugadoras que se ven en cuadro."
                  : "El video está fuera de la parte corregida: pon el clip para ver las posiciones."
                : kfs.length === 0
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
              {measured && (
                <>
                  {measured.players.map((d) => (
                    <g
                      key={d.id}
                      transform={`translate(${d.x} ${d.y})`}
                      opacity={d.team === "ref" || d.team === "unk" ? 0.5 : 1}
                    >
                      <circle
                        r={1.6}
                        fill={
                          d.team === "own"
                            ? COLORS.own
                            : d.team === "opp"
                              ? COLORS.opp
                              : "var(--color-faint)"
                        }
                        stroke="var(--color-bg)"
                        strokeWidth={0.4}
                      />
                      {d.label && (
                        <text
                          y={-2.2}
                          textAnchor="middle"
                          fontSize={2}
                          fill="var(--color-ink)"
                          pointerEvents="none"
                        >
                          {d.label}
                        </text>
                      )}
                    </g>
                  ))}
                  {measured.ball && (
                    <circle
                      cx={measured.ball[0]}
                      cy={measured.ball[1]}
                      r={1}
                      fill={COLORS.ball}
                      stroke="var(--color-bg)"
                      strokeWidth={0.3}
                    />
                  )}
                </>
              )}
              {!measuredOn &&
                shown &&
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
                        fill={
                          isBall
                            ? COLORS.ball
                            : tk.team === "own"
                              ? COLORS.own
                              : COLORS.opp
                        }
                        stroke="var(--color-bg)"
                        strokeWidth={0.4}
                      />
                      {!isBall && (
                        <text
                          y={0.85}
                          textAnchor="middle"
                          fontSize={2.2}
                          fontWeight={600}
                          fill="var(--color-bg)"
                          pointerEvents="none"
                        >
                          {tk.label}
                        </text>
                      )}
                    </g>
                  );
                })}
            </Pitch>
            <div className="mt-1 flex flex-wrap gap-4 text-xs text-muted">
              <span className="inline-flex items-center gap-1.5">
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ background: COLORS.own }}
                />
                {match.focus_team}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ background: COLORS.opp }}
                />
                {match.other_team}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ background: COLORS.ball }}
                />
                Balón
              </span>
              <span className="text-faint">
                {measuredOn
                  ? `Medidas, con ${match.focus_team} atacando hacia la derecha${part?.dir === "inferred" ? " (dirección deducida)" : ""}.`
                  : part
                    ? "Posiciones colocadas a mano: son un esquema, no una medición."
                    : "Posiciones colocadas a mano: son un esquema. Esta jugada no cae en una parte corregida; si la corriges y guardas en Tracking, saldrá medida."}
              </span>
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

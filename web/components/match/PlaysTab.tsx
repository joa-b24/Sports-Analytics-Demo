"use client";

import {
  PencilSimpleLine,
  Play as PlayIcon,
  Plus,
  Repeat,
  Strategy,
  Trash,
} from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { IconButton } from "@/components/Modal";
import { useEffect, useRef, useState, type RefObject } from "react";
import { ClipEditor } from "@/components/clip/ClipEditor";
import { TimeRange } from "@/components/TimeRange";
import { ViewShade } from "@/components/ViewShade";
import { COLORS, Pitch, toMeters } from "@/components/Pitch";
import { btn, btnPrimary, input } from "@/components/Shell";
import { FitAspect, PanelTitle } from "@/components/studio/Studio";
import { createPortal } from "react-dom";
import { Pager } from "@/components/Paged";
import type { PlayerHandle } from "@/components/VideoPlayer";
import { boardFromPlay, type MeasuredAt } from "@/lib/boards";
import { newEdit } from "@/lib/clips";
import { useFixedParts } from "@/lib/fixed";
import { fmtT } from "@/lib/format";
import { partFor, positionsAt } from "@/lib/positions";
import { videoOf } from "@/lib/videos";
import { TOKENS, defaultPositions, interpolate } from "@/lib/stats";
import { mutate, setPref, uid, usePref, useStore } from "@/lib/store";
import { LOOP_MARGIN_PREF, LOOP_PREF, parseMargin } from "@/lib/clipLoop";
import { NO_FILTER, filterPlays, matchPlays, typesPresent, type MatchPlay, type PlayFilter } from "@/lib/matchPlays";
import { EVENT_LABELS, type Keyframe, type Match, type MatchEvent, type MatchVideo, type Play } from "@/lib/types";

type Props = {
  match: Match;
  videoId: string;
  // The plays of the current video (the timeline bar) and of the whole match (the list), with what the list needs.
  plays: Play[];
  allPlays: Play[];
  videos: MatchVideo[];
  events: MatchEvent[];
  // Opens a play of any video: loads its video and goes to its start.
  onGoTo: (videoId: string, t: number, playId: string) => void;
  initialPlayId?: string | null;
  time: number;
  duration?: number;
  playerRef: RefObject<PlayerHandle | null>;
  // loopMargin: null plays once; a number repeats the stretch with that margin (s).
  playClip: (t0: number, t1: number, loopMargin?: number | null) => void;
  // Under the video: the bin of plays (when the page gives the slot).
  belowSlot?: HTMLDivElement | null;
};

// A keyframe counts as "open for editing" while the video sits on it.
const KF_TOLERANCE = 0.75;

export function PlaysTab({
  match,
  videoId,
  plays,
  allPlays,
  videos,
  events,
  onGoTo,
  initialPlayId,
  time,
  duration,
  playerRef,
  playClip,
  belowSlot,
}: Props) {
  const [selId, setSelId] = useState<string | null>(initialPlayId ?? plays[0]?.play_id ?? null);
  const [filter, setFilter] = useState<PlayFilter>(NO_FILTER);
  const [selKf, setSelKf] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(
    null,
  );
  const svgRef = useRef<SVGSVGElement>(null);
  // The chosen play, once its video is the one on screen (a play of another video shows while that video loads).
  const play = plays.find((p) => p.play_id === selId) ?? null;
  const loading = !play && allPlays.some((p) => p.play_id === selId);
  // Measured positions (corrected parts saved from the correction table) when the play falls in one.
  const fixed = useFixedParts(match.folder, [videoId]);
  const [source, setSource] = useState<"measured" | "hand">("measured");
  const part =
    play && fixed
      ? partFor(fixed.parts, videoId, play.t_start, play.t_end)
      : null;
  const measuredOn = part !== null && source === "measured";
  const measured = measuredOn && part ? positionsAt(part, time, { withExtrapolated: true }) : null;
  // What the measured animation shows: everybody, only players with a name, or only the ball.
  const show = usePref("plays:show", "all") as "all" | "named" | "ball";
  const { roster, edits } = useStore();
  const loopOn = usePref(LOOP_PREF, "off") === "on";
  const loopMargin = parseMargin(usePref(LOOP_MARGIN_PREF, "0"));
  const list = matchPlays(match, videos, allPlays, events, new Set((edits ?? []).flatMap((e) => (e.play_id ? [e.play_id] : []))));
  const router = useRouter();
  const [clipOpen, setClipOpen] = useState<string | null>(null);
  const editOf = (p: Play) => (edits ?? []).find((e) => e.play_id === p.play_id) ?? null;
  const openEditor = () => {
    if (!play) return;
    playerRef.current?.pause();
    const found = editOf(play);
    if (found) {
      // The clip follows the play: its start and end are the play's.
      if (found.t_start !== play.t_start || found.t_end !== play.t_end)
        mutate((s) => ({ ...s, edits: (s.edits ?? []).map((e) => (e.edit_id === found.edit_id ? { ...e, t_start: play.t_start, t_end: play.t_end } : e)) }));
      setClipOpen(found.edit_id);
      return;
    }
    const e = newEdit(uid("c"), play);
    mutate((s) => ({ ...s, edits: [...(s.edits ?? []), e] }));
    setClipOpen(e.edit_id);
  };
  const editingEdit = clipOpen ? ((edits ?? []).find((e) => e.edit_id === clipOpen) ?? null) : null;

  // Copies the play onto the board: the measured positions when they are the ones shown, otherwise the keyframes.
  // Tokens show the shirt number from the squad, never a name.
  const toBoard = () => {
    if (!play) return;
    let measuredAt: MeasuredAt | undefined;
    if (measuredOn && part) {
      const people = new Map(part.file.people.map((p) => [p.id, p.player_id]));
      const numberOf = (id: number) => {
        const n = (roster ?? []).find((r) => r.player_id === people.get(id))?.number;
        return n === null || n === undefined ? "" : String(n);
      };
      measuredAt = (t) => {
        const m = positionsAt(part, t);
        return m && { players: m.players.map((d) => ({ id: d.id, team: d.team, x: d.x, y: d.y, label: numberOf(d.id) })), ball: m.ball };
      };
    }
    const id = uid("b");
    const board = boardFromPlay(play, id, measuredAt);
    mutate((s) => ({ ...s, boards: [...(s.boards ?? []), board] }));
    router.push(`/pizarron?id=${id}`);
  };

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

  const legend = (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
      {(
        [
          [COLORS.own, match.focus_team],
          [COLORS.opp, match.other_team],
          [COLORS.ball, "Balón"],
        ] as const
      ).map(([c, label]) => (
        <span key={label} className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ background: c }} />
          {label}
        </span>
      ))}
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {editingEdit && <ClipEditor match={match} edit={editingEdit} onClose={() => setClipOpen(null)} />}

      {(() => {
        const bin = (
          <PlaysBin
            plays={plays}
            list={list}
            filter={filter}
            onFilter={setFilter}
            videoId={videoId}
            multi={videos.length > 1}
            selId={selId}
            time={time}
            duration={duration}
            onPick={(p) => {
              setSelId(p.play_id);
              setSelKf(null);
              onGoTo(videoOf(p), p.t_start, p.play_id);
            }}
            onSeek={(t) => playerRef.current?.seek(t)}
            onCreate={create}
            edited={(p) => !!editOf(p)}
          />
        );
        return belowSlot ? createPortal(bin, belowSlot) : bin;
      })()}

      {play ? (
        <section className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden rounded-xl bg-surface p-3" aria-label="Jugada elegida">
          <div className="flex items-center gap-2">
            <button
              type="button"
              className={`${btnPrimary} h-9 w-9 shrink-0 !p-0`}
              onClick={() => playClip(play.t_start, play.t_end, loopOn ? loopMargin : null)}
              aria-label="Reproducir el clip"
              title="Reproducir el clip"
            >
              <PlayIcon size={16} weight="fill" />
            </button>
            <button
              type="button"
              className={`${btn} shrink-0 !px-2`}
              aria-pressed={loopOn}
              onClick={() => setPref(LOOP_PREF, loopOn ? "off" : "on")}
              title="Repite el tramo de la jugada al reproducirla"
            >
              <Repeat size={14} weight={loopOn ? "bold" : "regular"} className={loopOn ? "text-accent-300" : ""} />
              Bucle {loopOn ? "sí" : "no"}
            </button>
            {loopOn && (
              <select className="shrink-0 rounded-md bg-raised px-1.5 py-1.5 text-xs text-ink-2" aria-label="Margen del bucle" value={loopMargin} onChange={(e) => setPref(LOOP_MARGIN_PREF, e.target.value)}>
                {[0, 1, 2, 3].map((m) => (
                  <option key={m} value={m}>
                    {m === 0 ? "sin margen" : `± ${m} s`}
                  </option>
                ))}
              </select>
            )}
            <input
              className={`${input} min-w-0 flex-1 font-medium`}
              value={play.title}
              aria-label="Título de la jugada"
              onChange={(e) => patch(play.play_id, { title: e.target.value })}
            />
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
              <Trash size={15} />
            </IconButton>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={btn}
              onClick={openEditor}
              title="Dibujos sobre el video del tramo (resaltar, flechas, líneas, zonas, texto) con pausas, y modo presentación para la charla"
            >
              <PencilSimpleLine size={14} />
              {editOf(play) ? "Editar clip" : "Dibujar sobre el clip"}
            </button>
            <button
              type="button"
              className={btn}
              onClick={toBoard}
              disabled={!measuredOn && kfs.length === 0}
              title={
                measuredOn
                  ? "Copia las posiciones medidas al pizarrón (un paso cada 2 s) para dibujar encima y sacar láminas"
                  : kfs.length > 0
                    ? "Copia los keyframes al pizarrón para dibujar encima y sacar láminas"
                    : "Añade keyframes o corrige su parte en Tracking para poder pasarla al pizarrón"
              }
            >
              <Strategy size={14} />
              Pasar al pizarrón
            </button>
            <label className="ml-auto flex items-center gap-1.5 text-xs text-muted" title="El informe la lista en la sección de balón parado">
              <input type="checkbox" checked={!!play.abp} onChange={(e) => patch(play.play_id, { abp: e.target.checked || undefined })} />
              Balón parado
            </label>
          </div>

          <TimeRange start={play.t_start} end={play.t_end} now={time} onChange={(p) => patch(play.play_id, p)} />

          <div className="flex min-h-0 flex-1 flex-col">
            <PanelTitle
              right={
                part && (
                  <div className="seg">
                    {(
                      [
                        ["measured", "Medidas"],
                        ["hand", "A mano"],
                      ] as const
                    ).map(([key, label]) => (
                      <button key={key} type="button" aria-pressed={source === key} className="seg-opt !px-2 !py-0.5 text-xs" onClick={() => setSource(key)}>
                        {label}
                      </button>
                    ))}
                  </div>
                )
              }
            >
              Animación de cancha
            </PanelTitle>
            {measuredOn ? (
              <div className="seg mb-2">
                {(
                  [
                    ["all", "Todas"],
                    ["named", "Con nombre"],
                    ["ball", "Solo balón"],
                  ] as const
                ).map(([key, label]) => (
                  <button key={key} type="button" aria-pressed={show === key} className="seg-opt !px-2 !py-0.5 text-xs" onClick={() => setPref("plays:show", key)}>
                    {label}
                  </button>
                ))}
              </div>
            ) : (
              <div className="mb-2 flex flex-wrap items-center gap-1.5">
                <button type="button" className={`${btn} !px-2.5 !py-1 text-xs`} onClick={addKeyframe}>
                  <Plus size={13} />
                  Keyframe en <span className="tc">{fmtT(time)}</span>
                </button>
                {kfs.map((kf, i) => (
                  <span key={kf.t} className="inline-flex items-center">
                    <button
                      type="button"
                      onClick={() => {
                        playerRef.current?.pause();
                        playerRef.current?.seek(kf.t);
                        setSelKf(i);
                      }}
                      className={`tc rounded-l-md py-1 pr-1.5 pl-2 text-xs transition-colors ${editing === i ? "bg-accent-900 text-accent-300" : "bg-raised text-ink-2 hover:bg-line"}`}
                    >
                      {fmtT(kf.t)}
                    </button>
                    <button
                      type="button"
                      title="Borrar keyframe"
                      aria-label={`Borrar el keyframe de ${fmtT(kf.t)}`}
                      onClick={() => {
                        patch(play.play_id, { keyframes: kfs.filter((_, j) => j !== i) });
                        setSelKf(null);
                      }}
                      className={`rounded-r-md py-1 pr-2 pl-1 text-xs text-faint transition-colors hover:text-danger ${editing === i ? "bg-accent-900" : "bg-raised"}`}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="min-h-[9rem] flex-1 overflow-hidden rounded-lg">
              <FitAspect aspect={109 / 76}>
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
                {measured && <ViewShade poly={measured.view} />}
                {measured && (
                  <>
                    {measured.players
                      .filter((d) => show === "all" || (show === "named" && d.label))
                      .map((d) => (
                        <g key={d.id} transform={`translate(${d.x} ${d.y})`} opacity={d.extrapolated ? 0.3 : d.team === "ref" || d.team === "unk" ? 0.5 : 1}>
                          <circle r={1.6} fill={d.team === "own" ? COLORS.own : d.team === "opp" ? COLORS.opp : "var(--color-faint)"} stroke={d.extrapolated ? "var(--color-faint)" : "var(--color-bg)"} strokeWidth={0.4} strokeDasharray={d.extrapolated ? "0.8 0.6" : undefined} />
                          {d.label && (
                            <text y={-2.2} textAnchor="middle" fontSize={2} fill="var(--color-ink)" pointerEvents="none">
                              {d.label}
                            </text>
                          )}
                        </g>
                      ))}
                    {measured.ball && <circle cx={measured.ball[0]} cy={measured.ball[1]} r={1} fill={COLORS.ball} stroke="var(--color-bg)" strokeWidth={0.3} />}
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
                        <circle r={isBall ? 1.1 : 1.9} fill={isBall ? COLORS.ball : tk.team === "own" ? COLORS.own : COLORS.opp} stroke="var(--color-bg)" strokeWidth={0.4} />
                        {!isBall && (
                          <text y={0.85} textAnchor="middle" fontSize={2.2} fontWeight={600} fill="var(--color-bg)" pointerEvents="none">
                            {tk.label}
                          </text>
                        )}
                      </g>
                    );
                  })}
              </Pitch>
              </FitAspect>
            </div>
            <div className="mt-1.5 shrink-0 space-y-1">
              {legend}
              <p className="m-0 text-[11px] text-pretty text-faint">
                {measuredOn
                  ? measured
                    ? `${part?.file.auto ? "Medidas por el tracking sin corregir (sin nombres)" : "Medidas por el tracking corregido"}, con ${match.focus_team} atacando hacia la derecha${part?.dir === "inferred" ? " (dirección deducida)" : ""}. Solo salen las jugadoras que se ven en cuadro${measured.players.some((d) => d.extrapolated) ? "; las tenues con borde punteado se mantienen quietas donde se las vio por última (o primera) vez: no es una medición ni cuenta en ninguna cifra" : ""}.`
                    : "El video está fuera de la parte corregida: pon el clip para ver las posiciones."
                  : kfs.length === 0
                    ? "Pausa el video en un momento clave y añade un keyframe: coloca a las jugadoras arrastrándolas. Con dos o más, la app interpola el movimiento."
                    : editing !== null
                      ? "Editando este keyframe: arrastra jugadoras y balón. Posiciones a mano: son un esquema, no una medición."
                      : part
                        ? "Vista interpolada de posiciones a mano (esquema, no medición). Pulsa un keyframe para editarlo."
                        : "Vista interpolada de posiciones a mano (esquema, no medición). Esta jugada no cae en una parte corregida; si la corriges y guardas en Tracking, saldrá medida."}
              </p>
            </div>
          </div>

          <textarea
            className={`${input} w-full shrink-0 text-sm`}
            rows={2}
            aria-label="Nota de la jugada"
            placeholder="Nota de la jugada (qué observar)"
            value={play.note}
            onChange={(e) => patch(play.play_id, { note: e.target.value })}
          />
        </section>
      ) : (
        <section className="grid min-h-40 flex-1 place-items-center rounded-xl bg-surface p-6 text-center text-sm text-muted">
          {loading ? "Cargando el video de la jugada…" : allPlays.length === 0 ? "Crea una jugada para verla aquí." : "Elige una jugada de la lista."}
        </section>
      )}
    </div>
  );
}

// The plays of the whole match as a clip bin under the video: a bar with the plays of the video on screen (and the
// playhead), filters by video, kind and team, and one row of cards that fills the width, in pages. A card of another
// video loads that video when picked.
const CARD_W = 190;
function PlaysBin({
  plays,
  list,
  filter,
  onFilter,
  videoId,
  multi,
  selId,
  time,
  duration,
  onPick,
  onSeek,
  onCreate,
  edited,
}: {
  plays: Play[];
  list: MatchPlay[];
  filter: PlayFilter;
  onFilter: (f: PlayFilter) => void;
  videoId: string;
  multi: boolean;
  selId: string | null;
  time: number;
  duration?: number;
  onPick: (p: Play) => void;
  onSeek: (t: number) => void;
  onCreate: () => void;
  edited: (p: Play) => boolean;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [per, setPer] = useState(5);
  const [page, setPage] = useState(0);
  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setPer(Math.max(1, Math.floor((e.contentRect.width + 8) / (CARD_W + 8)))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [list.length]);
  const sorted = filterPlays(list, filter);
  const selIdx = sorted.findIndex((m) => m.play.play_id === selId);
  const [seen, setSeen] = useState<[number, number]>([-1, 0]);
  if (seen[0] !== selIdx || seen[1] !== per) {
    setSeen([selIdx, per]);
    if (selIdx >= 0) setPage(Math.floor(selIdx / per));
  }
  const pages = Math.max(1, Math.ceil(sorted.length / per));
  const pg = Math.min(page, pages - 1);
  const here = [...plays].sort((a, b) => a.t_start - b.t_start);
  const end = Math.max(duration ?? 0, ...plays.map((p) => p.t_end), time, 1);
  const x = (t: number) => `${(Math.min(end, Math.max(0, t)) / end) * 100}%`;
  const types = typesPresent(list);
  const sel = "rounded-md bg-raised px-1.5 py-1 text-xs text-ink-2";
  const filtered = filter.video || filter.kind || filter.team;
  return (
    <section className="mt-3 rounded-xl bg-surface p-3" aria-label="Jugadas">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="cond text-[12px] font-bold tracking-wide text-muted uppercase">
          Jugadas del partido · {filtered ? `${sorted.length} de ${list.length}` : list.length}
        </span>
        {list.length > 0 && (
          <>
            {multi && (
              <select className={sel} aria-label="Filtrar por video" value={filter.video} onChange={(e) => onFilter({ ...filter, video: e.target.value })}>
                <option value="">Todos los videos</option>
                {[...new Map(list.map((m) => [m.video_id, m.video_label])).entries()].map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            )}
            <select className={sel} aria-label="Filtrar por tipo" value={filter.kind} onChange={(e) => onFilter({ ...filter, kind: e.target.value })}>
              <option value="">Todos los tipos</option>
              <option value="abp">Balón parado</option>
              <option value="edited">Con dibujos</option>
              {types.map((t) => (
                <option key={t} value={t}>
                  {EVENT_LABELS[t]}
                </option>
              ))}
            </select>
            <select className={sel} aria-label="Filtrar por equipo" value={filter.team} onChange={(e) => onFilter({ ...filter, team: e.target.value })}>
              <option value="">Ambos equipos</option>
              <option value="own">Nuestro equipo</option>
              <option value="opp">Rival</option>
              <option value="none">Sin evento marcado</option>
            </select>
            {filtered && (
              <button type="button" className="link text-xs" onClick={() => onFilter(NO_FILTER)}>
                Quitar filtros
              </button>
            )}
          </>
        )}
        <button type="button" className={`${btn} ml-auto !px-2.5 !py-1 text-xs`} onClick={onCreate} title="Nueva jugada desde el momento actual del video (15 s)">
          <Plus size={13} />
          Nueva en <span className="tc">{fmtT(time)}</span>
        </button>
      </div>
      {/* The video on screen: where each of its plays is. */}
      <div
        className="relative mb-2 h-5 cursor-pointer rounded-md bg-raised"
        role="slider"
        aria-label="Momento del video"
        aria-valuemin={0}
        aria-valuemax={end}
        aria-valuenow={Math.round(time)}
        tabIndex={-1}
        onPointerDown={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          onSeek(((e.clientX - r.left) / r.width) * end);
        }}
      >
        {here.map((p) => (
          <button
            key={p.play_id}
            type="button"
            title={`${p.title} · ${fmtT(p.t_start)}–${fmtT(p.t_end)}`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onPick(p)}
            className={`absolute top-0.5 bottom-0.5 min-w-1.5 rounded-sm ${p.play_id === selId ? "bg-accent" : p.abp ? "bg-warn/70" : "bg-accent-400/60 hover:bg-accent-400"}`}
            style={{ left: x(p.t_start), width: `calc(${x(p.t_end)} - ${x(p.t_start)})` }}
          />
        ))}
        <span className="pointer-events-none absolute top-0 h-full w-0.5 bg-ink" style={{ left: x(time) }} />
      </div>
      {list.length === 0 ? (
        <p className="m-0 text-xs text-faint">Una jugada es un tramo del video (inicio y fin). También se crea desde un evento con «+ jugada».</p>
      ) : sorted.length === 0 ? (
        <p className="m-0 text-xs text-faint">Ninguna jugada cumple los filtros.</p>
      ) : (
        <div ref={rowRef} className="flex gap-2">
          {sorted.slice(pg * per, pg * per + per).map((m) => {
            const p = m.play;
            const on = p.play_id === selId;
            return (
              <button
                key={p.play_id}
                type="button"
                onClick={() => onPick(p)}
                aria-pressed={on}
                className={`flex min-w-0 flex-col gap-1 rounded-lg border px-2.5 py-2 text-left transition-colors ${on ? "border-accent bg-accent-900" : "border-line-soft bg-raised hover:border-line-strong"}`}
                style={{ width: CARD_W }}
              >
                <span className="flex w-full items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{p.title}</span>
                  {p.abp && <span className="tag !px-1.5 !py-0 text-[10px]">ABP</span>}
                  {edited(p) && <PencilSimpleLine size={13} className="shrink-0 text-faint" aria-label="Con dibujos" />}
                </span>
                <span className="tc truncate text-[11px] text-faint">
                  {multi && <span className={m.video_id === videoId ? "text-muted" : "text-warn"}>{m.video_label} · </span>}
                  {fmtT(m.t_start)}–{fmtT(m.t_end)} · {Math.round(m.t_end - m.t_start)} s
                </span>
                {(m.type || m.team) && (
                  <span className="truncate text-[11px] text-faint">
                    {m.type ? EVENT_LABELS[m.type] : ""}
                    {m.team === "own" ? " · propio" : m.team === "opp" ? " · rival" : ""}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
      <Pager page={pg} pages={pages} setPage={setPage} />
    </section>
  );
}

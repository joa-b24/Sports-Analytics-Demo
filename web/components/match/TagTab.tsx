"use client";

import { detailsFor, outcomePatch } from "@/lib/tagging";
import { FilmSlate, Keyboard, Warning, X } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Modal } from "@/components/Modal";
import { COLORS } from "@/components/Pitch";
import { Card, btn } from "@/components/Shell";
import type { PlayerHandle } from "@/components/VideoPlayer";
import { useFixedParts } from "@/lib/fixed";
import { fmtT, isTyping } from "@/lib/format";
import { partFor, positionsAt } from "@/lib/positions";
import type { Segment } from "@/lib/segments";
import { mutate, setPref, uid, usePref, useStore } from "@/lib/store";
import { ACTIVE_S, NO_FILTER, activeAt, duplicatesOf, eventsFor, knownPlayers, missingEnd, missingReview, type EventFilter, type Pass } from "@/lib/tagging";
import { DETAIL_KEYS, DETAIL_TITLES, EVENT_KEYS, EVENT_LABELS, EVENT_OUTCOMES, EVENT_TYPES, OUTCOME_KEYS, type EventType, type Match, type MatchEvent } from "@/lib/types";
import { useScreenBoxes } from "@/lib/videoPeople";
import { EventsCompact, EventsTable } from "./EventsTable";
import { teamColor } from "./eventOptions";
import type { PlayerChoice } from "./PlayerPicker";
import { ReviewPanel, type BallView } from "./ReviewPanel";
import { VideoTimeline } from "./VideoTimeline";

type Props = {
  match: Match;
  // Video of the match being tagged; its events are the ones received.
  videoId: string;
  // The half of this video (from the match data): every event tagged here gets it.
  defaultPeriod: 1 | 2;
  events: MatchEvent[];
  segments: Segment[];
  time: number;
  // Length of the video (s), when the player knows it.
  duration?: number;
  playerRef: RefObject<PlayerHandle | null>;
  // Plays a stretch of the video and stops at its end.
  playClip: (t0: number, t1: number) => void;
  // Where the page lets this tab draw: over the video and under it.
  overlaySlot: HTMLElement | null;
  belowSlot: HTMLElement | null;
};

const PASSES: { id: Pass; label: string; help: string }[] = [
  { id: 1, label: "1 · Identificar", help: "Con el video corriendo: qué pasó y de qué equipo. Una tecla por evento." },
  { id: 2, label: "2 · Revisar", help: "Uno por uno: posición, jugadora, resultado, detalle y nota." },
  { id: 3, label: "3 · Ejecución", help: "Tiros, centros, córners, tiros libres y penales: a dónde fueron." },
];
const LAGS = [0, 2, 3, 5];
// + / − move the moment of the last event (pass 1) by this much (s).
const NUDGE_S = 0.1;
// How many people near the ball are suggested, and how far (m).
const NEAR_N = 4;
const NEAR_MAX_M = 15;
// The ball's recent path drawn on the review pitch (s), sampled every TRAIL_STEP_S.
const TRAIL_S = 2;
const TRAIL_STEP_S = 0.2;

export function TagTab({ match, videoId, defaultPeriod, events, segments, time, duration, playerRef, playClip, overlaySlot, belowSlot }: Props) {
  // Pass 4 (passes by hand) was removed: a browser that was on it opens pass 1. Passes are read from the tracking.
  const pass = Math.min(3, Math.max(1, Number(usePref("tagPass", "1")) || 1)) as Pass;
  const setPass = (p: Pass) => setPref("tagPass", String(p));
  const [team, setTeam] = useState<"own" | "opp">("own");
  // Seconds subtracted from the current time: you press the key after the action happened.
  const lag = Number(usePref("tagLag", "3")) || 0;
  // The event just tagged: its result and detail can still be completed with one more key.
  const [lastId, setLastId] = useState<string | null>(null);
  // Tagged in this session, newest last: Ctrl + Z takes them back one by one.
  const [added, setAdded] = useState<string[]>([]);
  // Just tagged (id and when): shown over the video for a moment even if its time is behind the playhead.
  const [recent, setRecent] = useState<{ id: string; at: number }[]>([]);
  // Possible duplicates the person chose to keep.
  const [kept, setKept] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<EventFilter>(NO_FILTER);
  const [current, setCurrent] = useState<string | null>(null);
  const [showKeys, setShowKeys] = useState(false);
  const [bigTable, setBigTable] = useState(false);
  // Clicking a player on the video picks her for the event under review.
  const [picking, setPicking] = useState(false);
  const [pickMsg, setPickMsg] = useState<string | null>(null);

  const update = (id: string, patch: Partial<MatchEvent>) => mutate((s) => ({ ...s, events: s.events.map((e) => (e.event_id === id ? { ...e, ...patch } : e)) }));
  const remove = (id: string) => mutate((s) => ({ ...s, events: s.events.filter((e) => e.event_id !== id) }));
  const now = () => Math.max(0, (playerRef.current?.getTime() ?? time) - lag);

  const add = (type: EventType) => {
    const ev: MatchEvent = {
      event_id: uid("e"),
      match_id: match.match_id,
      video_id: videoId,
      t_video: Math.round(now() * 10) / 10,
      period: defaultPeriod,
      type,
      team,
      player_id: null,
      x: null,
      y: null,
      outcome: null,
      detail: null,
      note: null,
    };
    mutate((s) => ({ ...s, events: [...s.events, ev] }));
    setLastId(ev.event_id);
    setAdded((a) => [...a, ev.event_id]);
    setRecent((r) => [...r, { id: ev.event_id, at: Date.now() }]);
  };
  const undo = () => {
    const id = added[added.length - 1];
    if (!id) return;
    remove(id);
    setAdded((a) => a.slice(0, -1));
  };
  const makePlay = (t: number, title: string) =>
    mutate((s) => ({
      ...s,
      plays: [...s.plays, { play_id: uid("p"), match_id: match.match_id, video_id: videoId, title, t_start: Math.max(0, t - 8), t_end: t + 4, note: "", keyframes: [] }],
    }));
  const [playMsg, setPlayMsg] = useState<string | null>(null);
  const markPlay = () => {
    const t = now();
    makePlay(t, `Jugada · ${fmtT(t)}`);
    setPlayMsg(`Jugada guardada en ${fmtT(t)}: se edita en Jugadas.`);
  };

  // The tag of a just-tagged event disappears after a moment.
  useEffect(() => {
    if (recent.length === 0) return;
    const id = setTimeout(() => setRecent((r) => r.filter((x) => Date.now() - x.at < ACTIVE_S * 1000)), 400);
    return () => clearTimeout(id);
  }, [recent]);

  const last = events.find((e) => e.event_id === lastId) ?? null;
  const lastOutcomes = last ? Object.entries(EVENT_OUTCOMES[last.type] ?? {}) : [];
  const lastDetails = last ? detailsFor(last) : [];
  // 1 2 3 set the result of the last event and 7 8 9 its detail; pressing the same one again clears it.
  const completeByKey = (key: string): boolean => {
    if (!last) return false;
    const o = OUTCOME_KEYS.indexOf(key);
    const d = DETAIL_KEYS.indexOf(key);
    if (o >= 0 && lastOutcomes[o]) {
      update(last.event_id, outcomePatch(last, last.outcome === lastOutcomes[o][0] ? null : lastOutcomes[o][0]));
      return true;
    }
    if (d >= 0 && lastDetails[d]) {
      update(last.event_id, { detail: last.detail === lastDetails[d][0] ? null : lastDetails[d][0] });
      return true;
    }
    return false;
  };
  const shiftLast = (ds: number) => last && update(last.event_id, { t_video: Math.round(Math.max(0, last.t_video + ds) * 100) / 100 });
  const handlers = useRef({ add, completeByKey, undo, markPlay, pass, shiftLast });
  useEffect(() => {
    handlers.current = { add, completeByKey, undo, markPlay, pass, shiftLast };
  });

  // Keyboard of the first pass. The review passes have their own (ReviewPanel).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const h = handlers.current;
      if (h.pass !== 1) return;
      const el = e.target as HTMLElement;
      if (isTyping(el)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        h.undo();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      // + / −: the moment of the last event.
      if (k === "+" || k === "=" || k === "-") {
        e.preventDefault();
        h.shiftLast(k === "-" ? -NUDGE_S : NUDGE_S);
      } else if (k === "a") setTeam("own");
      else if (k === "s") setTeam("opp");
      else if (k === "j") h.markPlay();
      else if (!h.completeByKey(k)) {
        const type = EVENT_TYPES.find((t) => EVENT_KEYS[t] === k);
        if (type) h.add(type);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Suggestions for the player field: the squad first (only for our matches, with numbers), then names already used.
  const { roster } = useStore();
  const players: PlayerChoice[] = useMemo(() => {
    const squad = match.kind === "own" ? (roster ?? []) : [];
    const known = knownPlayers(events).filter((p) => !squad.some((s) => s.player_id === p));
    return [...squad.map((p) => ({ player_id: p.player_id, number: p.number })), ...known.map((p) => ({ player_id: p }))];
  }, [match.kind, roster, events]);
  const shown = eventsFor(pass, events, filter);
  const active = activeAt(events, time);
  const activeIds = new Set(active.map((e) => e.event_id));
  // Over the video: the events the video is going through, plus the ones just tagged.
  const overlay = [...new Map([...active, ...recent.map((r) => events.find((e) => e.event_id === r.id))].filter((e): e is MatchEvent => !!e).map((e) => [e.event_id, e])).values()];
  const open = (e: MatchEvent) => {
    if (pass === 1) return playerRef.current?.seek(Math.max(0, e.t_video - 1), true);
    if (!eventsFor(pass, events, filter).some((x) => x.event_id === e.event_id)) setFilter(NO_FILTER);
    setCurrent(e.event_id);
  };
  const toReview = events.filter((e) => missingReview(e).length > 0).length;
  const withEnd = events.filter((e) => missingEnd(e) !== null);
  const toEnd = withEnd.filter((e) => missingEnd(e)).length;
  const filtered = JSON.stringify(filter) !== JSON.stringify(NO_FILTER);

  // ---------------------------------------------------------------- tracking (when the match has it)
  // Positions and ball of this video, oriented with the analysed team attacking right (as the events).
  const fixed = useFixedParts(match.folder, [videoId]);
  const reviewing = pass !== 1 ? (shown.find((e) => e.event_id === current) ?? shown[0] ?? null) : null;
  // Who is near the ball at the moment of the event under review: named players, those of its team first.
  const near: PlayerChoice[] = useMemo(() => {
    if (!reviewing || !fixed) return [];
    const part = partFor(fixed.parts, videoId, reviewing.t_video, reviewing.t_video);
    const at = part ? positionsAt(part, reviewing.t_video) : null;
    if (!part || !at?.ball) return [];
    const [bx, by] = at.ball;
    const names = new Map(part.file.people.map((p) => [p.id, p.player_id]));
    return at.players
      .flatMap((d) => {
        const name = names.get(d.id);
        if (!name || (d.team !== "own" && d.team !== "opp")) return [];
        return [{ player_id: name, color: d.team === "own" ? COLORS.own : COLORS.opp, near_m: Math.hypot(d.x - bx, d.y - by), mine: d.team === reviewing.team }];
      })
      .filter((c) => c.near_m <= NEAR_MAX_M)
      .sort((a, b) => Number(b.mine) - Number(a.mine) || a.near_m - b.near_m)
      .slice(0, NEAR_N);
  }, [reviewing, fixed, videoId]);
  // The ball at the playhead and its path over the last seconds.
  const ball: BallView | null = (() => {
    if (pass === 1 || !fixed) return null;
    const part = partFor(fixed.parts, videoId, time, time);
    if (!part) return null;
    const trail: [number, number][] = [];
    for (let t = Math.max(0, time - TRAIL_S); t <= time + 1e-6; t += TRAIL_STEP_S) {
      const b = positionsAt(part, t)?.ball;
      if (b) trail.push(b);
    }
    return { now: positionsAt(part, time)?.ball ?? null, trail };
  })();
  const fps = fixed?.parts.find((p) => p.file.video_id === videoId)?.file.fps ?? 29.97;
  const screen = useScreenBoxes(match.folder, videoId, Math.round(time * fps), pass === 2);
  const canPick = pass === 2 && !!reviewing && !!screen && screen.boxes.length > 0;
  const pickOn = picking && canPick;
  const pickBox = (b: NonNullable<typeof screen>["boxes"][number]) => {
    if (!reviewing) return;
    if (!b.player_id) return setPickMsg("Esa persona no tiene nombre en la mesa de corrección: escríbelo a mano.");
    update(reviewing.event_id, { player_id: b.player_id, ...(b.team === "own" || b.team === "opp" ? { team: b.team } : {}) });
    setPicking(false);
    setPickMsg(null);
  };
  useEffect(() => {
    if (!pickOn) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPicking(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pickOn]);

  const overlayEl = (
    <>
      {pickOn && screen && (
        <svg viewBox={`0 0 ${screen.size[0]} ${screen.size[1]}`} className="pointer-events-auto absolute inset-0 h-full w-full cursor-crosshair" onClick={() => setPicking(false)}>
          {screen.boxes.map((b) => {
            const c = b.team === "own" ? COLORS.own : b.team === "opp" ? COLORS.opp : "#94a3b8";
            const [x1, y1, x2, y2] = b.box;
            return (
              <g
                key={b.identity}
                className="cursor-pointer"
                onClick={(ev) => {
                  ev.stopPropagation();
                  pickBox(b);
                }}
              >
                <rect x={x1} y={y1} width={x2 - x1} height={y2 - y1} fill={c} fillOpacity={0.12} stroke={c} strokeWidth={screen.size[0] / 600} rx={screen.size[0] / 400} />
                {b.player_id && (
                  <text x={(x1 + x2) / 2} y={y1 - screen.size[0] / 300} textAnchor="middle" fontSize={screen.size[0] / 90} fontWeight={600} fill="#fff" stroke="#000" strokeWidth={screen.size[0] / 900} paintOrder="stroke">
                    {b.player_id}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}
      <div className="pointer-events-none absolute top-3 left-3 z-10 flex max-w-[70%] flex-col items-start gap-1.5">
        {pickOn && <div className="enter rounded-full bg-own px-3 py-1 text-xs font-medium text-[var(--on-own)] shadow-lg">Clic en la jugadora · Esc cancela</div>}
        {pickMsg && <div className="enter rounded-full bg-warn-900/90 px-3 py-1 text-xs text-warn shadow-lg">{pickMsg}</div>}
        {overlay.map((e) => {
          const dup = duplicatesOf(events, e).length > 0 && !kept.has(e.event_id);
          return (
            <div key={e.event_id} className={`enter pointer-events-auto flex items-center gap-2 rounded-full py-1 pr-2 pl-3 text-xs shadow-lg backdrop-blur ${dup ? "bg-warn-900/90 text-warn" : "bg-bg/85 text-ink"}`}>
              <span className="h-2 w-2 rounded-full" style={{ background: teamColor(e) }} />
              <span className="font-medium">{EVENT_LABELS[e.type]}</span>
              <span className="tc text-[10px] opacity-70">{fmtT(e.t_video)}</span>
              {dup && (
                <>
                  <Warning size={13} />
                  <span>¿duplicado?</span>
                  <button type="button" className="rounded-full bg-bg/60 px-2 py-0.5 hover:text-danger" onClick={() => remove(e.event_id)}>
                    quitar
                  </button>
                  <button type="button" className="rounded-full bg-bg/60 px-2 py-0.5 hover:text-ink" onClick={() => setKept((k) => new Set(k).add(e.event_id))}>
                    conservar
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>
    </>
  );

  const belowEl = (
    <VideoTimeline
      events={events}
      segments={segments}
      time={time}
      duration={duration}
      selected={pass === 1 ? null : current}
      onSeek={(t) => playerRef.current?.seek(Math.max(0, t))}
      onPick={open}
    />
  );

  const teamBtn = (t: "own" | "opp", label: string, key: string) => (
    <button
      type="button"
      onClick={() => setTeam(t)}
      aria-pressed={team === t}
      className={`flex flex-1 items-center justify-center gap-2 rounded-full border px-4 py-2.5 text-sm font-medium transition-[background-color,border-color,box-shadow] duration-200 ${
        team === t ? "border-accent bg-accent/20 text-accent-100" : "border-line bg-transparent text-ink-2 hover:border-line-strong"
      }`}
    >
      <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: t === "own" ? COLORS.own : COLORS.opp }} />
      <span className="truncate">{label}</span>
      <kbd className="kbd">{key}</kbd>
    </button>
  );

  const keysCard = (
    <div className="enter rounded-2xl bg-raised p-3 shadow-[0_0_0_1px_var(--color-line-strong)]">
      <div className="mb-2 flex items-center justify-between text-xs text-ink-2">
        Atajos · también se puede hacer clic
        <button type="button" aria-label="Cerrar" className="text-faint hover:text-ink" onClick={() => setShowKeys(false)}>
          <X size={14} />
        </button>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {EVENT_TYPES.map((t) => (
          <button key={t} type="button" onClick={() => add(t)} className="btn btn-key text-left">
            <span className="truncate">{EVENT_LABELS[t]}</span>
            <kbd className="kbd uppercase">{EVENT_KEYS[t]}</kbd>
          </button>
        ))}
      </div>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px] text-muted">
        {[
          ["Espacio", "reproducir / pausar"],
          ["← →", "5 s atrás / adelante (con Mayús, 1 s)"],
          ["A / S", "equipo analizado / contrario"],
          ["1 2 3", "resultado del último evento"],
          ["7 8 9", "detalle del último evento"],
          ["+ / −", "mover el último evento una décima"],
          ["J", "guardar este momento como jugada"],
          ["Ctrl + Z", "quitar el último evento marcado"],
        ].map(([k, v]) => (
          <div key={k} className="contents">
            <dt>
              <kbd className="kbd">{k}</kbd>
            </dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 xl:overflow-y-auto">
      <div className="shrink-0">
        <div className="seg w-full" role="group" aria-label="Pasada del etiquetado">
          {PASSES.map((p) => (
            <button key={p.id} type="button" aria-pressed={pass === p.id} onClick={() => setPass(p.id)} className="seg-opt flex-1 text-center" title={p.help}>
              {p.label}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-pretty text-muted">
          {PASSES[pass - 1].help} {pass === 2 && <span className="text-faint">{toReview} por completar.</span>}
          {pass === 3 && (
            <span className="text-faint">
              {toEnd} de {withEnd.length} sin destino.
            </span>
          )}
        </p>
      </div>

      {pass === 1 && (
        <Card className="shrink-0" title="Nuevo evento" note={<span className="tc">{fmtT(time)}</span>}>
          <div className="flex gap-2">
            {teamBtn("own", match.focus_team, "A")}
            {teamBtn("opp", match.other_team, "S")}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" className={btn} aria-expanded={showKeys} onClick={() => setShowKeys((v) => !v)}>
              <Keyboard size={15} />
              Atajos
            </button>
            <button type="button" className={btn} onClick={markPlay} title="Guarda este momento como jugada para animarla después">
              <FilmSlate size={15} />
              Jugada <kbd className="kbd">J</kbd>
            </button>
            <div className="seg ml-auto" role="group" aria-label="Segundos que se restan" title="Se restan al tiempo actual: la tecla se pulsa después de la acción">
              {LAGS.map((v) => (
                <button key={v} type="button" aria-pressed={lag === v} className="seg-opt tc !px-2.5" onClick={() => setPref("tagLag", String(v))}>
                  −{v} s
                </button>
              ))}
            </div>
          </div>
          {showKeys && <div className="mt-3">{keysCard}</div>}
          {playMsg && <p className="mt-2 text-xs text-ok">{playMsg}</p>}
          {last && (lastOutcomes.length > 0 || lastDetails.length > 0) && (
            <div key={last.event_id} className="enter mt-3 space-y-2 rounded-2xl bg-accent-900/40 p-3 shadow-[inset_0_0_0_1px_rgba(74,114,255,.35)]">
              <div className="text-xs text-accent-200">
                Completar: {EVENT_LABELS[last.type]} · <span className="tc">{fmtT(last.t_video)}</span> <span className="text-faint">(opcional)</span>
              </div>
              {(
                [
                  ["Resultado", lastOutcomes, OUTCOME_KEYS, "outcome"],
                  [DETAIL_TITLES[last.type] ?? "Detalle", lastDetails, DETAIL_KEYS, "detail"],
                ] as const
              ).map(([title, options, keys, field]) =>
                options.length === 0 ? null : (
                  <div key={field} className="flex flex-wrap items-center gap-1.5">
                    <span className="w-20 text-[11px] text-faint">{title}</span>
                    {options.map(([value, label], n) => {
                      const on = (last[field] ?? null) === value;
                      return (
                        <button
                          key={value}
                          type="button"
                          aria-pressed={on}
                          onClick={() => update(last.event_id, { [field]: on ? null : value })}
                          className={`inline-flex items-center gap-1.5 rounded-full border py-1 pr-1.5 pl-3 text-xs transition-colors ${
                            on ? "border-accent bg-accent/25 text-accent-100" : "border-line text-ink-2 hover:border-line-strong"
                          }`}
                        >
                          {label}
                          <kbd className="kbd">{keys[n]}</kbd>
                        </button>
                      );
                    })}
                  </div>
                ),
              )}
            </div>
          )}
        </Card>
      )}

      {(pass === 2 || pass === 3) && (
        <div className="shrink-0">
          <ReviewPanel
            pass={pass}
            match={match}
            list={shown}
            all={events}
            current={reviewing?.event_id ?? null}
            setCurrent={setCurrent}
            update={update}
            playClip={playClip}
            time={time}
            players={players}
            near={near}
            ball={ball}
            picking={pickOn}
            onPickVideo={
              canPick
                ? () => {
                    playerRef.current?.pause();
                    setPickMsg(null);
                    setPicking((v) => !v);
                  }
                : null
            }
          />
        </div>
      )}

      <EventsCompact
        events={shown}
        total={events.length}
        filtered={filtered}
        onClearFilter={() => setFilter(NO_FILTER)}
        current={pass === 1 ? null : (reviewing?.event_id ?? null)}
        activeIds={activeIds}
        onOpen={open}
        onExpand={() => setBigTable(true)}
        time={time}
      />

      {bigTable && (
        <Modal title="Eventos" onClose={() => setBigTable(false)} size="full">
          <EventsTable
            match={match}
            pass={pass}
            events={events}
            shown={shown}
            filter={filter}
            setFilter={setFilter}
            update={update}
            remove={remove}
            onOpen={(e) => {
              open(e);
              setBigTable(false);
            }}
            onMakePlay={(e) => makePlay(e.t_video, `${EVENT_LABELS[e.type]} · ${fmtT(e.t_video)}`)}
            activeIds={activeIds}
            players={players}
          />
        </Modal>
      )}

      {overlaySlot && createPortal(overlayEl, overlaySlot)}
      {belowSlot ? createPortal(belowEl, belowSlot) : belowEl}
    </div>
  );
}

"use client";

import { FilmSlate, Keyboard, Warning, X } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { COLORS } from "@/components/Pitch";
import { Card, btn, input } from "@/components/Shell";
import type { PlayerHandle } from "@/components/VideoPlayer";
import { fmtT } from "@/lib/format";
import type { Segment } from "@/lib/segments";
import { mutate, setPref, uid, usePref, useStore } from "@/lib/store";
import { ACTIVE_S, NO_FILTER, activeAt, duplicatesOf, eventsFor, knownPlayers, missingEnd, missingReview, type EventFilter, type Pass } from "@/lib/tagging";
import {
  DETAIL_KEYS,
  DETAIL_TITLES,
  EVENT_DETAILS,
  EVENT_KEYS,
  EVENT_LABELS,
  EVENT_OUTCOMES,
  EVENT_TYPES,
  OUTCOME_KEYS,
  type EventType,
  type Match,
  type MatchEvent,
} from "@/lib/types";
import { EventsTable } from "./EventsTable";
import { ReviewPanel } from "./ReviewPanel";
import { VideoTimeline } from "./VideoTimeline";

type Props = {
  match: Match;
  // Video of the match being tagged; its events are the ones received.
  videoId: string;
  defaultPeriod: 1 | 2;
  events: MatchEvent[];
  segments: Segment[];
  time: number;
  // Length of the video (s), when the player knows it.
  duration?: number;
  playerRef: RefObject<PlayerHandle | null>;
  // Plays a stretch of the video and stops at its end.
  playClip: (t0: number, t1: number) => void;
  // Where the page lets this tab draw: over the video, under it, and full width below both columns.
  overlaySlot: HTMLElement | null;
  belowSlot: HTMLElement | null;
  tableSlot: HTMLElement | null;
};

const PASSES: { id: Pass; label: string; help: string }[] = [
  { id: 1, label: "1 · Identificar", help: "Con el video corriendo: qué pasó y de qué equipo. Una tecla por evento." },
  { id: 2, label: "2 · Revisar", help: "Uno por uno: posición, jugadora, resultado, detalle y nota." },
  { id: 3, label: "3 · Ejecución", help: "Tiros, centros, córners, tiros libres y penales: a dónde fueron." },
];
const teamColor = (e: MatchEvent) => (e.team === "own" ? COLORS.own : e.team === "opp" ? COLORS.opp : "var(--color-faint)");

export function TagTab({ match, videoId, defaultPeriod, events, segments, time, duration, playerRef, playClip, overlaySlot, belowSlot, tableSlot }: Props) {
  const pass = (Number(usePref("tagPass", "1")) || 1) as Pass;
  const setPass = (p: Pass) => setPref("tagPass", String(p));
  const [team, setTeam] = useState<"own" | "opp">("own");
  const [period, setPeriod] = useState<1 | 2>(defaultPeriod);
  // Seconds subtracted from the current time: you press the key after the action happened.
  const [lag, setLag] = useState(3);
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

  const update = (id: string, patch: Partial<MatchEvent>) =>
    mutate((s) => ({ ...s, events: s.events.map((e) => (e.event_id === id ? { ...e, ...patch } : e)) }));
  const remove = (id: string) => mutate((s) => ({ ...s, events: s.events.filter((e) => e.event_id !== id) }));
  const now = () => Math.max(0, (playerRef.current?.getTime() ?? time) - lag);

  const add = (type: EventType) => {
    const ev: MatchEvent = {
      event_id: uid("e"),
      match_id: match.match_id,
      video_id: videoId,
      t_video: Math.round(now() * 10) / 10,
      period,
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
      plays: [
        ...s.plays,
        { play_id: uid("p"), match_id: match.match_id, video_id: videoId, title, t_start: Math.max(0, t - 8), t_end: t + 4, note: "", keyframes: [] },
      ],
    }));
  const [playMsg, setPlayMsg] = useState<string | null>(null);
  const markPlay = () => {
    const t = now();
    makePlay(t, `Jugada · ${fmtT(t)}`);
    setPlayMsg(`Jugada guardada en ${fmtT(t)} (8 s antes y 4 s después). Se edita en la pestaña Jugadas.`);
  };

  // The tag of a just-tagged event disappears after a moment.
  useEffect(() => {
    if (recent.length === 0) return;
    const id = setTimeout(() => setRecent((r) => r.filter((x) => Date.now() - x.at < ACTIVE_S * 1000)), 400);
    return () => clearTimeout(id);
  }, [recent]);

  const last = events.find((e) => e.event_id === lastId) ?? null;
  const lastOutcomes = last ? Object.entries(EVENT_OUTCOMES[last.type] ?? {}) : [];
  const lastDetails = last ? Object.entries(EVENT_DETAILS[last.type] ?? {}) : [];
  // 1 2 3 set the result of the last event and 7 8 9 its detail; pressing the same one again clears it.
  const completeByKey = (key: string): boolean => {
    if (!last) return false;
    const o = OUTCOME_KEYS.indexOf(key);
    const d = DETAIL_KEYS.indexOf(key);
    if (o >= 0 && lastOutcomes[o]) {
      update(last.event_id, { outcome: last.outcome === lastOutcomes[o][0] ? null : lastOutcomes[o][0] });
      return true;
    }
    if (d >= 0 && lastDetails[d]) {
      update(last.event_id, { detail: last.detail === lastDetails[d][0] ? null : lastDetails[d][0] });
      return true;
    }
    return false;
  };
  const handlers = useRef({ add, completeByKey, undo, markPlay, pass });
  useEffect(() => {
    handlers.current = { add, completeByKey, undo, markPlay, pass };
  });

  // Keyboard of the first pass. The review passes have their own (ReviewPanel).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const h = handlers.current;
      if (h.pass !== 1) return;
      const el = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        h.undo();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "a") setTeam("own");
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

  // Suggestions for the player field: the squad first (only for our matches), then names already used here.
  const { roster } = useStore();
  const squad = match.kind === "own" ? (roster ?? []) : [];
  const players = [...new Set([...squad.map((p) => p.player_id), ...knownPlayers(events)])];
  const numberOf = new Map(squad.map((p) => [p.player_id, p.number]));
  const shown = eventsFor(pass, events, filter);
  const active = activeAt(events, time);
  const activeIds = new Set(active.map((e) => e.event_id));
  // Over the video: the events the video is going through, plus the ones just tagged.
  const overlay = [...new Map([...active, ...recent.map((r) => events.find((e) => e.event_id === r.id))].filter((e): e is MatchEvent => !!e).map((e) => [e.event_id, e])).values()];
  const open = (e: MatchEvent) => {
    if (pass === 1) return playerRef.current?.seek(Math.max(0, e.t_video - 3), true);
    if (!eventsFor(pass, events, filter).some((x) => x.event_id === e.event_id)) setFilter(NO_FILTER);
    setCurrent(e.event_id);
  };
  const toReview = events.filter((e) => missingReview(e).length > 0).length;
  const withEnd = events.filter((e) => missingEnd(e) !== null);
  const toEnd = withEnd.filter((e) => missingEnd(e)).length;
  // Events near the playhead, for the small table under the video.
  const nearby = events.filter((e) => Math.abs(e.t_video - time) <= 8).slice(0, 8);

  const overlayEl = (
    <div className="pointer-events-none absolute top-3 left-3 z-10 flex max-w-[70%] flex-col items-start gap-1.5">
      {overlay.map((e) => {
        const dup = duplicatesOf(events, e).length > 0 && !kept.has(e.event_id);
        return (
          <div
            key={e.event_id}
            className={`enter pointer-events-auto flex items-center gap-2 rounded-full py-1 pr-2 pl-3 text-xs shadow-lg backdrop-blur ${
              dup ? "bg-warn-900/90 text-warn" : "bg-bg/85 text-ink"
            }`}
          >
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
  );

  const belowEl = (
    <div className="space-y-3">
      <VideoTimeline
        events={events}
        segments={segments}
        time={time}
        duration={duration}
        selected={pass === 1 ? null : current}
        onSeek={(t) => playerRef.current?.seek(Math.max(0, t))}
        onPick={open}
      />
      <div className="rounded-2xl bg-surface/60 p-3">
        <div className="mb-2 flex items-baseline justify-between text-xs">
          <span className="text-ink-2">Eventos activos</span>
          <span className="text-faint">8 s alrededor del momento actual · resaltado: el video está pasando por él</span>
        </div>
        {nearby.length === 0 ? (
          <p className="text-xs text-faint">Ningún evento cerca de este momento.</p>
        ) : (
          <ul className="space-y-0.5 text-xs">
            {nearby.map((e) => (
              <li key={e.event_id}>
                <button
                  type="button"
                  onClick={() => open(e)}
                  className={`flex w-full items-center gap-3 rounded-lg px-2 py-1 text-left transition-colors hover:bg-raised ${
                    activeIds.has(e.event_id) ? "bg-accent-900/60 text-ink" : e.event_id === current ? "bg-raised text-ink" : "text-muted"
                  }`}
                >
                  <span className="tc w-12">{fmtT(e.t_video)}</span>
                  <span className="h-2 w-2 rounded-full" style={{ background: teamColor(e) }} />
                  <span className="w-32 truncate">{EVENT_LABELS[e.type]}</span>
                  <span className="w-24 truncate">{e.player_id ?? "–"}</span>
                  <span className="truncate text-warn">{[...missingReview(e), ...(missingEnd(e) ? ["destino"] : [])].join(", ")}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
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
          ["A / S", "equipo analizado / contrario"],
          ["1 2 3", "resultado del último evento"],
          ["7 8 9", "detalle del último evento"],
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
    <div className="space-y-5">
      <div className="seg w-full" role="group" aria-label="Pasada del etiquetado">
        {PASSES.map((p) => (
          <button key={p.id} type="button" aria-pressed={pass === p.id} onClick={() => setPass(p.id)} className="seg-opt flex-1 text-center">
            {p.label}
          </button>
        ))}
      </div>
      <p className="-mt-3 text-xs text-pretty text-muted">
        {PASSES[pass - 1].help}{" "}
        {pass === 2 && <span className="text-faint">{toReview} por completar.</span>}
        {pass === 3 && <span className="text-faint">{toEnd} de {withEnd.length} sin destino.</span>}
      </p>

      {pass === 1 && (
        <Card title="Nuevo evento" note={<span className="tc">Ahora {fmtT(time)}</span>}>
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
          <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-muted">
            <label className="flex items-center gap-1.5">
              Periodo
              <select className={input} value={period} onChange={(e) => setPeriod(Number(e.target.value) as 1 | 2)}>
                <option value={1}>1</option>
                <option value={2}>2</option>
              </select>
            </label>
            <label className="flex items-center gap-1.5" title="Segundos que se restan al tiempo actual: la tecla se pulsa después de la acción">
              Restar
              <select className={input} value={lag} onChange={(e) => setLag(Number(e.target.value))}>
                {[0, 2, 3, 5].map((v) => (
                  <option key={v} value={v}>
                    {v} s
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="mt-3 text-[11px] text-pretty text-faint">
            Cada evento marcado aparece sobre el video unos segundos. Si hay otro igual del mismo equipo a menos de 3 s sale en amarillo
            como posible duplicado. Posición, jugadora y nota se ponen en la pasada 2.
          </p>
        </Card>
      )}

      {pass !== 1 && (
        <ReviewPanel
          pass={pass}
          match={match}
          list={shown}
          all={events}
          current={current}
          setCurrent={setCurrent}
          update={update}
          playClip={playClip}
        />
      )}

      <datalist id="known-players">
        {players.map((p) => (
          <option key={p} value={p} label={numberOf.get(p) != null ? `#${numberOf.get(p)}` : undefined} />
        ))}
      </datalist>

      {overlaySlot && createPortal(overlayEl, overlaySlot)}
      {belowSlot ? createPortal(belowEl, belowSlot) : belowEl}
      {(() => {
        const table = (
          <EventsTable
            match={match}
            pass={pass}
            events={events}
            shown={shown}
            filter={filter}
            setFilter={setFilter}
            update={update}
            remove={remove}
            onOpen={open}
            onMakePlay={(e) => makePlay(e.t_video, `${EVENT_LABELS[e.type]} · ${fmtT(e.t_video)}`)}
            activeIds={activeIds}
          />
        );
        return tableSlot ? createPortal(table, tableSlot) : table;
      })()}
    </div>
  );
}

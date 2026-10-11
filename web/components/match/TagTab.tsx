"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { COLORS, Pitch, toMeters } from "@/components/Pitch";
import { EventTimeline } from "@/components/charts";
import { LockedRow } from "@/components/Locked";
import { Card, input } from "@/components/Shell";
import type { PlayerHandle } from "@/components/VideoPlayer";
import { fmtT } from "@/lib/format";
import type { Segment } from "@/lib/segments";
import { mutate, uid } from "@/lib/store";
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

type Props = {
  match: Match;
  // Video of the match being tagged; its events are the ones received.
  videoId: string;
  defaultPeriod: 1 | 2;
  events: MatchEvent[];
  segments: Segment[];
  time: number;
  playerRef: RefObject<PlayerHandle | null>;
  // Element under the video where the events table is drawn; inline while it does not exist.
  tableSlot: HTMLElement | null;
};

export function TagTab({ match, videoId, defaultPeriod, events, segments, time, playerRef, tableSlot }: Props) {
  const [team, setTeam] = useState<"own" | "opp">("own");
  const [period, setPeriod] = useState<1 | 2>(defaultPeriod);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [playerId, setPlayerId] = useState("");
  const [note, setNote] = useState("");
  // Seconds subtracted from the current time: you press the key after the action happened.
  const [lag, setLag] = useState(3);
  // The event just tagged: its result and detail can still be completed with one more key.
  const [lastId, setLastId] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const update = (id: string, patch: Partial<MatchEvent>) =>
    mutate((s) => ({ ...s, events: s.events.map((e) => (e.event_id === id ? { ...e, ...patch } : e)) }));

  const add = (type: EventType) => {
    const t = Math.max(0, (playerRef.current?.getTime() ?? 0) - lag);
    const ev: MatchEvent = {
      event_id: uid("e"),
      match_id: match.match_id,
      video_id: videoId,
      t_video: Math.round(t * 10) / 10,
      period,
      type,
      team,
      player_id: playerId.trim() || null,
      x: pos ? Math.round(pos.x * 10) / 10 : null,
      y: pos ? Math.round(pos.y * 10) / 10 : null,
      outcome: null,
      detail: null,
      note: note.trim() || null,
    };
    mutate((s) => ({ ...s, events: [...s.events, ev] }));
    setLastId(ev.event_id);
    setPos(null);
    setNote("");
    setPlayerId("");
  };
  const last = events.find((e) => e.event_id === lastId) ?? null;
  const lastOutcomes = last ? Object.entries(EVENT_OUTCOMES[last.type] ?? {}) : [];
  const lastDetails = last ? Object.entries(EVENT_DETAILS[last.type] ?? {}) : [];
  // Keys z x v set the result of the last event and b n m its detail; pressing the same one again clears it.
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
  const addRef = useRef(add);
  const completeRef = useRef(completeByKey);
  useEffect(() => {
    addRef.current = add;
    completeRef.current = completeByKey;
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "a") setTeam("own");
      else if (e.key === "s") setTeam("opp");
      else if (!completeRef.current(e.key)) {
        const type = EVENT_TYPES.find((t) => EVENT_KEYS[t] === e.key);
        if (type) addRef.current(type);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);


  const remove = (id: string) => mutate((s) => ({ ...s, events: s.events.filter((e) => e.event_id !== id) }));
  const makePlay = (e: MatchEvent) =>
    mutate((s) => ({
      ...s,
      plays: [
        ...s.plays,
        {
          play_id: uid("p"),
          match_id: match.match_id,
          video_id: videoId,
          title: `${EVENT_LABELS[e.type]} · ${fmtT(e.t_video)}`,
          t_start: Math.max(0, e.t_video - 8),
          t_end: e.t_video + 4,
          note: "",
          keyframes: [],
        },
      ],
    }));

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

  const eventsTable = (
    <Card title="Eventos etiquetados" note={`${events.length} en total`} delay={120}>
    {events.length === 0 ? (
      <p className="text-sm text-faint">Aún no hay eventos. Reproduce el video y etiqueta con los botones o las teclas.</p>
    ) : (
      <div className="overflow-x-auto">
        <table className="table-nocturne w-full text-left text-sm">
          <thead>
            <tr>
              <th className="py-1 pr-2 font-medium">Tiempo</th>
              <th className="py-1 pr-2 font-medium">Tipo</th>
              <th className="py-1 pr-2 font-medium">Equipo</th>
              <th className="py-1 pr-2 font-medium">Resultado · detalle</th>
              <th className="py-1 pr-2 font-medium">Jug.</th>
              <th className="py-1 pr-2 font-medium">Pos.</th>
              <th className="py-1 pr-2 font-medium">Nota</th>
              <th className="py-1 font-medium" />
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.event_id} className="border-t border-line-soft">
                <td className="py-1 pr-2">
                  <button
                    type="button"
                    className="tc link"
                    onClick={() => playerRef.current?.seek(Math.max(0, e.t_video - 3), true)}
                  >
                    {fmtT(e.t_video)}
                  </button>
                </td>
                <td className="py-1 pr-2">
                  <select
                    className="chip-select"
                    aria-label="Tipo de evento"
                    value={e.type}
                    onChange={(ev) => update(e.event_id, { type: ev.target.value as EventType, outcome: null, detail: null })}
                  >
                    {EVENT_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {EVENT_LABELS[t]}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="py-1 pr-2 whitespace-nowrap">
                  <button
                    type="button"
                    title="Cambiar de equipo"
                    onClick={() => update(e.event_id, { team: e.team === "own" ? "opp" : "own" })}
                    className="inline-flex items-center gap-1.5"
                  >
                    <span className="h-2 w-2 rounded-full" style={{ background: e.team === "own" ? COLORS.own : COLORS.opp }} />
                    {e.team === "own" ? match.focus_team : match.other_team}
                  </button>
                </td>
                <td className="py-1 pr-2 text-xs whitespace-nowrap">
                  {(["outcome", "detail"] as const).map((field) => {
                    const options = (field === "outcome" ? EVENT_OUTCOMES : EVENT_DETAILS)[e.type];
                    return options ? (
                      <select
                        key={field}
                        className="chip-select mr-1"
                        data-empty={(e[field] ?? "") === "" ? "" : undefined}
                        aria-label={field === "outcome" ? "Resultado" : (DETAIL_TITLES[e.type] ?? "Detalle")}
                        value={e[field] ?? ""}
                        onChange={(ev) => update(e.event_id, { [field]: ev.target.value || null })}
                      >
                        <option value="">—</option>
                        {Object.entries(options).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    ) : null;
                  })}
                </td>
                <td className="py-1 pr-2">{e.player_id ?? "–"}</td>
                <td className="py-1 pr-2 text-xs text-faint">{e.x === null ? "–" : `${e.x.toFixed(0)}, ${(e.y as number).toFixed(0)}`}</td>
                <td className="max-w-40 truncate py-1 pr-2 text-xs text-muted">{e.note ?? ""}</td>
                <td className="py-1 text-right text-xs whitespace-nowrap">
                  <button type="button" className="link mr-3" onClick={() => makePlay(e)}>
                    + jugada
                  </button>
                  <button type="button" className="text-danger underline underline-offset-2" onClick={() => remove(e.event_id)}>
                    borrar
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
  </Card>
  );

  return (
    <div className="space-y-5">
      <Card title="Nuevo evento" note={<span className="tc">Ahora {fmtT(time)}</span>}>
        <ol className="mb-4 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
          {["Elige el equipo", "Clic en la cancha donde ocurrió (opcional)", "Pulsa el tipo de evento o su tecla"].map((t, n) => (
            <li key={t} className="flex items-center gap-1.5">
              <span className="num text-lg text-accent-400">{n + 1}</span>
              {t}
            </li>
          ))}
        </ol>
        <div className="flex gap-2">
          {teamBtn("own", match.focus_team, "A")}
          {teamBtn("opp", match.other_team, "S")}
        </div>
        <div className="mt-3 grid gap-3">
          <div>
            <Pitch
              svgRef={svgRef}
              className="cursor-crosshair"
              onPointerDown={(e) => svgRef.current && setPos(toMeters(svgRef.current, e))}
            >
              {events.map((e) =>
                e.x === null || e.y === null ? null : (
                  <circle key={e.event_id} cx={e.x} cy={e.y} r={0.9} fill={e.team === "own" ? COLORS.own : COLORS.opp} opacity={0.5} />
                ),
              )}
              {pos && <circle cx={pos.x} cy={pos.y} r={2.2} fill="none" stroke="var(--color-accent-200)" strokeWidth={0.5} />}
              {pos && <circle cx={pos.x} cy={pos.y} r={0.7} fill="var(--color-accent-100)" />}
            </Pitch>
            <div className={`mt-1 text-[11px] text-faint ${pos ? "tc" : ""}`}>
              {pos ? `Posición: x ${pos.x.toFixed(1)} m, y ${pos.y.toFixed(1)} m` : "Sin posición (se guardará vacía)."}
              {pos && (
                <button type="button" className="link ml-2" onClick={() => setPos(null)}>
                  quitar
                </button>
              )}
            </div>
          </div>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-1.5">
              {EVENT_TYPES.map((t) => (
                <button key={t} type="button" onClick={() => add(t)} className="btn btn-key text-left">
                  <span className="truncate">{EVENT_LABELS[t]}</span>
                  <kbd className="kbd">{EVENT_KEYS[t]}</kbd>
                </button>
              ))}
            </div>
            {last && (lastOutcomes.length > 0 || lastDetails.length > 0) && (
              <div key={last.event_id} className="enter space-y-2 rounded-2xl bg-accent-900/40 p-3 shadow-[inset_0_0_0_1px_rgba(74,114,255,.35)]">
                <div className="text-xs text-accent-200">
                  Completar: {EVENT_LABELS[last.type]} · <span className="tc">{fmtT(last.t_video)}</span>{" "}
                  <span className="text-faint">(opcional)</span>
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
            <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
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
            <div className="flex flex-wrap gap-2">
              <input className={`${input} w-28`} placeholder="Jugadora (#)" value={playerId} onChange={(e) => setPlayerId(e.target.value)} />
              <input className={`${input} min-w-0 flex-1`} placeholder="Nota (opcional)" value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
          </div>
        </div>
      </Card>

      {events.length > 0 && (
        <Card title="Línea de tiempo de eventos" note="clic en una marca para ir a ese momento" delay={60}>
          <EventTimeline
            events={events}
            segments={segments}
            aLabel={match.focus_team}
            bLabel={match.other_team}
            onSeek={(t) => playerRef.current?.seek(Math.max(0, t - 3), true)}
          />
        </Card>
      )}

      <LockedRow
        reason="tracking"
        title="Dirección del tiro, velocidad y datos inferidos"
        why="El resultado y el detalle de cada evento ya se anotan a mano. Lo que falta de la propuesta es lo automático: a qué zona de la portería fue el tiro, su velocidad estimada y los datos inferidos (jugadora, presión). Eso sale de posiciones medidas, y el tracking por jugada todavía está en construcción (pasos A3 a A6 de la hoja de ruta)."
      />

      {tableSlot ? createPortal(eventsTable, tableSlot) : eventsTable}
    </div>
  );
}

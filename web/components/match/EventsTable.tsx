"use client";

import { ArrowsOutSimple, CaretLeft, CaretRight, FilmSlate, Trash, WarningCircle, X } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { IconButton } from "@/components/Modal";
import { Select } from "@/components/Select";
import { Card, input } from "@/components/Shell";
import { fmtT } from "@/lib/format";
import { parseHms } from "@/lib/segments";
import { NO_FILTER, duplicatesOf, retype, missingEnd, missingReview, type EventFilter, type Pass } from "@/lib/tagging";
import { DETAIL_TITLES, EVENT_LABELS, EVENT_TYPES, type EventType, type Match, type MatchEvent } from "@/lib/types";
import { TYPE_OPTIONS, detailOptions, outcomeOptions, teamColor, teamOptions } from "./eventOptions";
import { CardToggle } from "./CardToggle";
import { outcomePatch } from "@/lib/tagging";
import { PlayerPicker, type PlayerChoice } from "./PlayerPicker";

const isFiltered = (f: EventFilter) => JSON.stringify(f) !== JSON.stringify(NO_FILTER);
const missingOf = (e: MatchEvent) => [...missingReview(e), ...(missingEnd(e) ? ["destino"] : [])];

// The filters of the events, shared by the table and the review passes: types (one drop-down instead of a chip per
// type), team, player and only what is still missing.
export function EventFilters({
  match,
  pass,
  events,
  filter,
  setFilter,
  players,
}: {
  match: Match;
  pass: Pass;
  events: MatchEvent[];
  filter: EventFilter;
  setFilter: (f: EventFilter) => void;
  players: PlayerChoice[];
}) {
  const typesHere = EVENT_TYPES.filter((t) => events.some((e) => e.type === t));
  const count = (t: EventType) => events.filter((e) => e.type === t).length;
  const missingCount = events.filter((e) => (pass === 3 ? missingEnd(e) === true : missingReview(e).length > 0)).length;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <Select
        multi
        variant="field"
        label="Filtrar por tipo"
        value={filter.types}
        onChange={(types) => setFilter({ ...filter, types })}
        options={TYPE_OPTIONS.filter((o) => typesHere.includes(o.value)).map((o) => ({ value: o.value, label: `${o.label} · ${count(o.value)}` }))}
        display={filter.types.length === 0 ? "Todos los tipos" : filter.types.length === 1 ? EVENT_LABELS[filter.types[0]] : `${filter.types.length} tipos`}
      />
      <div className="seg" role="group" aria-label="Equipo">
        {(
          [
            ["all", "Ambos", null],
            ["own", match.focus_team, "bg-own"],
            ["opp", match.other_team, "bg-opp"],
          ] as const
        ).map(([v, name, dot]) => (
          <button key={v} type="button" aria-pressed={filter.team === v} className="seg-opt inline-flex max-w-[9rem] items-center gap-1.5" onClick={() => setFilter({ ...filter, team: v })}>
            {dot && <i className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />}
            <span className="truncate">{name}</span>
          </button>
        ))}
      </div>
      <div className="w-40">
        <PlayerPicker search value={filter.player} onChange={(player) => setFilter({ ...filter, player })} choices={players} placeholder="Buscar jugadora" label="Filtrar por jugadora" />
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={filter.onlyMissing}
        onClick={() => setFilter({ ...filter, onlyMissing: !filter.onlyMissing })}
        className={`inline-flex h-9 items-center gap-2 rounded-lg px-3 transition-colors ${filter.onlyMissing ? "bg-warn-900/70 text-warn" : "bg-bg/60 text-muted hover:text-ink-2"}`}
        title={pass === 3 ? "Solo los que aún no tienen destino" : "Solo los que aún no tienen posición o resultado"}
      >
        <span className={`relative h-3.5 w-6 rounded-full transition-colors ${filter.onlyMissing ? "bg-warn" : "bg-line-strong"}`}>
          <span className={`absolute top-0.5 h-2.5 w-2.5 rounded-full bg-bg transition-[left] ${filter.onlyMissing ? "left-3" : "left-0.5"}`} />
        </span>
        {pass === 3 ? "Sin destino" : "Incompletos"}
        <span className="tc text-faint">{missingCount}</span>
      </button>
      {isFiltered(filter) && (
        <button type="button" className="inline-flex items-center gap-1 text-faint hover:text-ink" onClick={() => setFilter(NO_FILTER)}>
          <X size={12} />
          Quitar filtros
        </button>
      )}
    </div>
  );
}

// Every event of a video, large, with its filters and editing in the row (opened from the compact list).
export function EventsTable({
  match,
  pass,
  events,
  shown,
  filter,
  setFilter,
  update,
  remove,
  onOpen,
  onMakePlay,
  activeIds,
  players,
}: {
  match: Match;
  pass: Pass;
  events: MatchEvent[];
  // `events` after the filters.
  shown: MatchEvent[];
  filter: EventFilter;
  setFilter: (f: EventFilter) => void;
  update: (id: string, patch: Partial<MatchEvent>) => void;
  remove: (id: string) => void;
  // Goes to the event: in pass 1 plays it, in passes 2 and 3 opens it in the review panel.
  onOpen: (e: MatchEvent) => void;
  onMakePlay: (e: MatchEvent) => void;
  // Events the video is going through now: highlighted.
  activeIds: Set<string>;
  players: PlayerChoice[];
}) {
  return (
    <div className="space-y-4">
      <EventFilters match={match} pass={pass} events={events} filter={filter} setFilter={setFilter} players={players} />
      {shown.length === 0 ? (
        <p className="text-sm text-faint">{events.length === 0 ? "Aún no hay eventos." : "Ningún evento con estos filtros."}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="table-nocturne w-full text-left text-sm">
            <thead className="sticky top-0 z-10 bg-raised">
              <tr>
                <th className="py-1 pr-2 font-medium">Tiempo</th>
                <th className="py-1 pr-2 font-medium">Tipo</th>
                <th className="py-1 pr-2 font-medium">Equipo</th>
                <th className="py-1 pr-2 font-medium">Resultado</th>
                <th className="py-1 pr-2 font-medium">Detalle</th>
                <th className="py-1 pr-2 font-medium">Jugadora</th>
                <th className="py-1 pr-2 font-medium">Nota</th>
                <th className="py-1 pr-2 font-medium">Falta</th>
                <th className="py-1 font-medium" />
              </tr>
            </thead>
            <tbody>
              {shown.map((e) => {
                const missing = missingOf(e);
                const dup = duplicatesOf(events, e).length > 0;
                const outs = outcomeOptions(e.type);
                const dets = detailOptions(e);
                return (
                  <tr key={e.event_id} className={`border-t border-line-soft transition-colors ${activeIds.has(e.event_id) ? "bg-accent-900/50" : ""}`}>
                    <td className="py-1 pr-2">
                      <button type="button" className="tc link" title={pass === 1 ? "Ver este momento" : "Abrir en la revisión"} onClick={() => onOpen(e)}>
                        {fmtT(e.t_video)}
                      </button>
                    </td>
                    <td className="py-1 pr-2 whitespace-nowrap">
                      <Select label="Tipo de evento" value={e.type} options={TYPE_OPTIONS} onChange={(t) => t && update(e.event_id, retype(e, t))} />
                      {dup && (
                        <span className="tag tag-warn ml-1" title="Hay otro igual del mismo equipo a menos de 3 s">
                          ¿doble?
                        </span>
                      )}
                    </td>
                    <td className="py-1 pr-2 whitespace-nowrap">
                      <Select label="Equipo" value={e.team === "own" || e.team === "opp" ? e.team : null} options={teamOptions(match)} onChange={(t) => t && update(e.event_id, { team: t })} />
                    </td>
                    <td className="py-1 pr-2 whitespace-nowrap">
                      {outs.length > 0 && <Select clearable label="Resultado" value={e.outcome ?? null} options={outs} onChange={(v) => update(e.event_id, outcomePatch(e, v))} />}
                    </td>
                    <td className="py-1 pr-2 whitespace-nowrap">
                      {e.type === "foul" ? (
                        <CardToggle value={e.detail} onChange={(v) => update(e.event_id, { detail: v })} />
                      ) : e.type === "substitution" ? (
                        <span className="flex items-center gap-1 text-[11px] text-faint">
                          entra
                          <PlayerPicker variant="cell" value={e.player_in ?? ""} onChange={(v) => update(e.event_id, { player_in: v || null })} choices={players} />
                        </span>
                      ) : (
                        dets.length > 0 && <Select clearable label={DETAIL_TITLES[e.type] ?? "Detalle"} value={e.detail ?? null} options={dets} onChange={(v) => update(e.event_id, { detail: v })} />
                      )}
                    </td>
                    <td className="py-1 pr-2">
                      <PlayerPicker variant="cell" value={e.player_id ?? ""} onChange={(v) => update(e.event_id, { player_id: v || null })} choices={players} />
                    </td>
                    <td className="py-1 pr-2">
                      <input
                        className="w-full min-w-32 rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-xs text-muted hover:border-line focus:border-accent focus:outline-none"
                        aria-label="Nota"
                        placeholder="–"
                        value={e.note ?? ""}
                        onChange={(ev) => update(e.event_id, { note: ev.target.value || null })}
                      />
                    </td>
                    <td className="py-1 pr-2 text-[11px] whitespace-nowrap text-warn">{missing.join(", ")}</td>
                    <td className="py-1 text-right text-xs whitespace-nowrap">
                      <IconButton label="Crear una jugada desde este evento" onClick={() => onMakePlay(e)}>
                        <FilmSlate size={14} />
                      </IconButton>
                      <IconButton label="Borrar el evento" tone="danger" onClick={() => remove(e.event_id)}>
                        <Trash size={14} />
                      </IconButton>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const ROW_H = 30;

// The events of the video as a short list that fills the room it has, split in pages; «desde» goes to the page of a
// moment. The full table opens large.
export function EventsCompact({
  events,
  total,
  filtered,
  onClearFilter,
  current,
  activeIds,
  onOpen,
  onExpand,
  time,
}: {
  // Already filtered, in time order.
  events: MatchEvent[];
  total: number;
  filtered: boolean;
  onClearFilter: () => void;
  current: string | null;
  activeIds: Set<string>;
  onOpen: (e: MatchEvent) => void;
  onExpand: () => void;
  time: number;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [per, setPer] = useState(8);
  const [page, setPage] = useState(0);
  const [from, setFrom] = useState("");
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setPer(Math.max(3, Math.floor(e.contentRect.height / ROW_H))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const pages = Math.max(1, Math.ceil(events.length / per));
  const p = Math.min(page, pages - 1);
  const rows = events.slice(p * per, p * per + per);
  const goFrom = (t: number) => {
    const i = events.findIndex((e) => e.t_video >= t);
    setPage(Math.floor((i < 0 ? events.length - 1 : i) / per));
  };
  return (
    <Card className="flex min-h-[11rem] flex-1 flex-col" delay={120}>
      <div className="mb-3 flex shrink-0 items-center gap-2">
        <h2 className="text-[15px] text-ink">Eventos</h2>
        <span className="tc text-xs text-faint">{filtered ? `${events.length} de ${total}` : total}</span>
        {filtered && (
          <button type="button" className="tag inline-flex items-center gap-1 hover:text-ink" onClick={onClearFilter} title="Hay filtros puestos: quitarlos">
            filtrado <X size={10} />
          </button>
        )}
        <form
          className="ml-auto"
          onSubmit={(e) => {
            e.preventDefault();
            const t = parseHms(from);
            if (t !== null) goFrom(t);
          }}
        >
          <input
            className={`${input} tc h-7 w-[4.5rem] !px-2 text-xs`}
            placeholder="desde"
            aria-label="Ir a los eventos desde un tiempo (mm:ss, Enter)"
            title="Desde un tiempo (mm:ss, Enter). Vacío y Enter: desde el momento actual"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !from.trim()) {
                e.preventDefault();
                goFrom(time);
              }
            }}
          />
        </form>
        <IconButton label="Ver la tabla completa" onClick={onExpand}>
          <ArrowsOutSimple size={15} />
        </IconButton>
      </div>
      <div ref={boxRef} className="min-h-0 flex-1 overflow-hidden">
        {events.length === 0 ? (
          <p className="text-sm text-faint">{total === 0 ? "Aún no hay eventos." : "Ninguno con estos filtros."}</p>
        ) : (
          <ul>
            {rows.map((e) => {
              const missing = missingOf(e);
              return (
                <li key={e.event_id} style={{ height: ROW_H }}>
                  <button
                    type="button"
                    onClick={() => onOpen(e)}
                    className={`flex h-full w-full items-center gap-2.5 rounded-lg px-2 text-left text-xs transition-colors hover:bg-raised ${
                      e.event_id === current ? "bg-raised text-ink shadow-[inset_2px_0_0_var(--color-accent)]" : activeIds.has(e.event_id) ? "bg-accent-900/50 text-ink" : "text-ink-2"
                    }`}
                  >
                    <span className="tc w-11 shrink-0 text-faint">{fmtT(e.t_video)}</span>
                    <i className="h-2 w-2 shrink-0 rounded-full" style={{ background: teamColor(e) }} />
                    <span className="min-w-0 flex-1 truncate">{EVENT_LABELS[e.type]}</span>
                    <span className="max-w-[35%] truncate text-faint">{e.player_id ?? ""}</span>
                    <span className="grid w-4 shrink-0 place-items-center text-warn" title={missing.length ? `Falta: ${missing.join(", ")}` : undefined}>
                      {missing.length > 0 && <WarningCircle size={13} />}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {pages > 1 && (
        <div className="mt-2 flex shrink-0 items-center justify-center gap-2 text-xs text-faint">
          <IconButton label="Página anterior" disabled={p === 0} onClick={() => setPage(p - 1)}>
            <CaretLeft size={13} />
          </IconButton>
          <span className="tc">
            {p + 1} / {pages}
          </span>
          <IconButton label="Página siguiente" disabled={p >= pages - 1} onClick={() => setPage(p + 1)}>
            <CaretRight size={13} />
          </IconButton>
        </div>
      )}
    </Card>
  );
}

"use client";

import { FilmSlate, Funnel, Trash } from "@phosphor-icons/react";
import { IconButton } from "@/components/Modal";
import { COLORS } from "@/components/Pitch";
import { Card, input } from "@/components/Shell";
import { fmtT } from "@/lib/format";
import { NO_FILTER, duplicatesOf, retype, missingEnd, missingReview, type EventFilter, type Pass } from "@/lib/tagging";
import { DETAIL_TITLES, EVENT_DETAILS, EVENT_LABELS, EVENT_OUTCOMES, EVENT_TYPES, type EventType, type Match, type MatchEvent, type Team } from "@/lib/types";

// Full list of the events of a video, with filters (shared with the review passes) and editing in the row.
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
}) {
  const typesHere = EVENT_TYPES.filter((t) => events.some((e) => e.type === t));
  const toggleType = (t: EventType) =>
    setFilter({ ...filter, types: filter.types.includes(t) ? filter.types.filter((x) => x !== t) : [...filter.types, t] });
  const filtered = filter !== NO_FILTER && JSON.stringify(filter) !== JSON.stringify(NO_FILTER);
  const missingCount = events.filter((e) => (pass === 3 ? missingEnd(e) === true : missingReview(e).length > 0)).length;

  return (
    <Card title="Eventos etiquetados" note={filtered ? `${shown.length} de ${events.length}` : `${events.length} en total`} delay={120}>
      {events.length === 0 ? (
        <p className="text-sm text-faint">Aún no hay eventos. Reproduce el video y etiqueta con las teclas.</p>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
            <Funnel size={14} className="text-faint" />
            {typesHere.map((t) => (
              <button
                key={t}
                type="button"
                aria-pressed={filter.types.includes(t)}
                onClick={() => toggleType(t)}
                className={`rounded-full border px-2.5 py-0.5 transition-colors ${
                  filter.types.includes(t) ? "border-accent bg-accent/20 text-accent-100" : "border-line text-muted hover:border-line-strong"
                }`}
              >
                {EVENT_LABELS[t]}
              </button>
            ))}
            <select className="chip-select" aria-label="Equipo" value={filter.team} onChange={(e) => setFilter({ ...filter, team: e.target.value as Team | "all" })}>
              <option value="all">Los dos equipos</option>
              <option value="own">{match.focus_team}</option>
              <option value="opp">{match.other_team}</option>
            </select>
            <input
              className={`${input} w-32 !py-1 text-xs`}
              list="known-players"
              placeholder="Jugadora"
              aria-label="Filtrar por jugadora"
              value={filter.player}
              onChange={(e) => setFilter({ ...filter, player: e.target.value })}
            />
            <label className="flex items-center gap-1.5 text-muted">
              <input type="checkbox" className="accent-accent" checked={filter.onlyMissing} onChange={(e) => setFilter({ ...filter, onlyMissing: e.target.checked })} />
              {pass === 3 ? "sin destino" : "incompletos"} ({missingCount})
            </label>
            {filtered && (
              <button type="button" className="link" onClick={() => setFilter(NO_FILTER)}>
                quitar filtros
              </button>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="table-nocturne w-full text-left text-sm">
              <thead>
                <tr>
                  <th className="py-1 pr-2 font-medium">Tiempo</th>
                  <th className="py-1 pr-2 font-medium">Tipo</th>
                  <th className="py-1 pr-2 font-medium">Equipo</th>
                  <th className="py-1 pr-2 font-medium">Resultado · detalle</th>
                  <th className="py-1 pr-2 font-medium">Jugadora</th>
                  <th className="py-1 pr-2 font-medium">Nota</th>
                  <th className="py-1 pr-2 font-medium">Falta</th>
                  <th className="py-1 font-medium" />
                </tr>
              </thead>
              <tbody>
                {shown.map((e) => {
                  const missing = [...missingReview(e), ...(missingEnd(e) ? ["destino"] : [])];
                  const dup = duplicatesOf(events, e).length > 0;
                  return (
                    <tr key={e.event_id} className={`border-t border-line-soft transition-colors ${activeIds.has(e.event_id) ? "bg-accent-900/50" : ""}`}>
                      <td className="py-1 pr-2">
                        <button type="button" className="tc link" title={pass === 1 ? "Ver este momento" : "Abrir en la revisión"} onClick={() => onOpen(e)}>
                          {fmtT(e.t_video)}
                        </button>
                      </td>
                      <td className="py-1 pr-2 whitespace-nowrap">
                        <select
                          className="chip-select"
                          aria-label="Tipo de evento"
                          value={e.type}
                          onChange={(ev) => update(e.event_id, retype(e, ev.target.value as EventType))}
                        >
                          {EVENT_TYPES.map((t) => (
                            <option key={t} value={t}>
                              {EVENT_LABELS[t]}
                            </option>
                          ))}
                        </select>
                        {dup && (
                          <span className="tag tag-warn ml-1" title="Hay otro igual del mismo equipo a menos de 3 s">
                            ¿doble?
                          </span>
                        )}
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
                      <td className="py-1 pr-2">
                        <input
                          className="w-28 rounded-lg border border-transparent bg-transparent px-1.5 py-0.5 text-sm hover:border-line focus:border-accent focus:outline-none"
                          list="known-players"
                          aria-label="Jugadora"
                          placeholder="–"
                          value={e.player_id ?? ""}
                          onChange={(ev) => update(e.event_id, { player_id: ev.target.value || null })}
                        />
                      </td>
                      <td className="py-1 pr-2">
                        <input
                          className="w-full min-w-32 rounded-lg border border-transparent bg-transparent px-1.5 py-0.5 text-xs text-muted hover:border-line focus:border-accent focus:outline-none"
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
        </>
      )}
    </Card>
  );
}

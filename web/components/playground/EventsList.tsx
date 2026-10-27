"use client";

import { ListChecks, Plus, Ruler } from "@phosphor-icons/react";
import { Card } from "@/components/Shell";
import { Pager, usePaged } from "@/components/Paged";
import type { DetectedEvent } from "@/lib/eventDetect";
import { CONF_LABEL, NO_EVENT_FILTER, TEAM_LABEL, isEventFiltered, type EventFilter, type EventReviewFile } from "@/lib/eventReview";
import { fmtT } from "@/lib/format";

const ROW_H = 34;
const COLS = "grid-cols-[3.8rem_4.6rem_1fr_3.6rem_1.2rem]";
const TEAM_CLS: Record<string, string> = { own: "tag tag-accent", opp: "tag", unk: "tag tag-outline" };
const CONF_CLS: Record<string, string> = { high: "text-ok", medium: "text-warn", low: "text-danger" };

// The detections of one type: filters, pages (no inner scroll) and one click to play the moment.
export function EventsList({
  title, events, total, filter, onFilter, selected, onSelect, review, sampleOnly, onSampleOnly, hasSample, onSample, onNext, onMissed, onWindows,
}: {
  title: string;
  events: DetectedEvent[];
  total: number;
  filter: EventFilter;
  onFilter: (f: EventFilter) => void;
  selected: string | null;
  onSelect: (e: DetectedEvent) => void;
  review: EventReviewFile;
  sampleOnly: boolean;
  onSampleOnly: (v: boolean) => void;
  hasSample: boolean;
  onSample: () => void;
  onNext: () => void;
  onMissed: () => void;
  onWindows: () => void;
}) {
  const idx = selected ? events.findIndex((e) => e.id === selected) : -1;
  const { boxRef, rows, page, pages, setPage } = usePaged(events, ROW_H, idx >= 0 ? idx : null);
  const filtered = isEventFiltered(filter) || sampleOnly;
  const verdictOf = (e: DetectedEvent) => review.reviews.find((r) => r.id === e.id && r.rule_version === e.rule_version)?.verdict ?? null;
  return (
    <Card title={title} note={`${events.length} de ${total}`} className="flex h-full flex-col !p-3">
      <div className="mb-2 flex flex-wrap items-end gap-x-2 gap-y-1 text-[11px] text-muted">
        <label>
          Equipo
          <select className="input mt-0.5 block !py-1 text-xs" value={filter.team} onChange={(e) => onFilter({ ...filter, team: e.target.value as EventFilter["team"] })}>
            <option value="all">Todos</option>
            {Object.entries(TEAM_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label>
          Estado
          <select className="input mt-0.5 block !py-1 text-xs" value={filter.state} onChange={(e) => onFilter({ ...filter, state: e.target.value as EventFilter["state"] })}>
            <option value="all">Todas</option>
            <option value="pending">Sin revisar</option>
            <option value="correct">Correctas</option>
            <option value="incorrect">Incorrectas</option>
          </select>
        </label>
        <label>
          Confianza
          <select className="input mt-0.5 block !py-1 text-xs" value={filter.confidence} onChange={(e) => onFilter({ ...filter, confidence: e.target.value as EventFilter["confidence"] })}>
            <option value="all">Todas</option>
            {Object.entries(CONF_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        {hasSample && (
          <label className="flex items-center gap-1.5 pb-2">
            <input type="checkbox" checked={sampleOnly} onChange={(e) => onSampleOnly(e.target.checked)} />
            Solo la muestra
          </label>
        )}
        {filtered && (
          <button type="button" className="btn btn-ghost !px-2 !py-1 text-[11px]" onClick={() => { onFilter(NO_EVENT_FILTER); onSampleOnly(false); }}>
            Quitar filtros
          </button>
        )}
      </div>
      <div className={`grid ${COLS} gap-x-2 border-b border-line-soft pb-1 text-[11px] text-faint`} role="row">
        <span>Inicio</span>
        <span>Equipo</span>
        <span>Jugadora</span>
        <span className="text-right">Posición</span>
        <span />
      </div>
      <div ref={boxRef} className="min-h-0 flex-1 overflow-hidden">
        {events.length === 0 ? (
          <p className="pt-3 text-sm text-faint">Ninguna detección de este tipo con estos filtros.</p>
        ) : (
          rows.map((e) => {
            const v = verdictOf(e);
            return (
              <button
                key={e.id}
                type="button"
                onClick={() => onSelect(e)}
                aria-pressed={selected === e.id}
                title={`Reproducir este momento. Confianza ${CONF_LABEL[e.confidence].toLowerCase()}${e.flags.length ? `; banderas: ${e.flags.join(", ")}` : ""}`}
                className={`grid w-full ${COLS} items-center gap-x-2 border-b border-line-soft px-0 text-left text-xs hover:bg-raised ${selected === e.id ? "bg-raised" : ""}`}
                style={{ height: ROW_H }}
              >
                <span className="tc text-ink">
                  <span className={`mr-1 ${CONF_CLS[e.confidence]}`} aria-hidden>
                    ●
                  </span>
                  {fmtT(e.t_video)}
                </span>
                <span>
                  <span className={TEAM_CLS[e.team]}>{e.team === "own" ? "Nuestro" : e.team === "opp" ? "Rival" : "—"}</span>
                </span>
                <span className="truncate text-muted">{e.player ?? "—"}</span>
                <span className="tc text-right text-muted">
                  {Math.round(e.x)} · {Math.round(e.y)}
                </span>
                <span className={v ? (v === "correct" ? "text-ok" : "text-danger") : "text-faint"} title={v ? (v === "correct" ? "Revisada: correcta" : "Revisada: incorrecta") : "Sin revisar"}>
                  {v ? (v === "correct" ? "✓" : "✗") : "·"}
                </span>
              </button>
            );
          })
        )}
      </div>
      <Pager page={page} pages={pages} setPage={setPage} />
      <div className="mt-2 flex shrink-0 flex-wrap items-center gap-1.5">
        <button type="button" className="btn !px-2 !py-1 text-[11px]" onClick={onSample} title="Reparte la revisión entre los tipos: lo que falta para llegar al mínimo de cada uno">
          <ListChecks size={13} />
          Muestra de revisión
        </button>
        {hasSample && (
          <button type="button" className="btn !px-2 !py-1 text-[11px]" onClick={onNext}>
            Siguiente sin revisar
          </button>
        )}
        <button type="button" className="btn !px-2 !py-1 text-[11px]" onClick={onMissed} title="Un evento que viste en el video y la regla no detectó">
          <Plus size={13} />
          Añadir evento no detectado
        </button>
        <button type="button" className="btn !px-2 !py-1 text-[11px]" onClick={onWindows} title="Un rango de tiempo donde ya revisaste todo: ahí se calcula el recall">
          <Ruler size={13} />
          Ventana revisada completa
        </button>
      </div>
    </Card>
  );
}

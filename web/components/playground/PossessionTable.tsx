"use client";

import { useState } from "react";
import { Card } from "@/components/Shell";
import { Pager, usePaged } from "@/components/Paged";
import { fmtT } from "@/lib/format";
import {
  KIND_LABEL, NOTE_LABEL, NO_FILTER, SRC_LABEL, TEAM_LABEL, fmtTd, isFiltered, parseMinDur, rowDuration, rowId, type RowFilter, type Review,
} from "@/lib/playgroundPossession";
import type { BallSrc, PossessionKind, PossessionRow, PossessionTeam } from "@/lib/possession";

const ROW_H = 36;
const TEAM_CLS: Record<PossessionTeam, string> = { own: "tag tag-accent", opp: "tag", none: "tag tag-outline" };
const COMPACT_COLS = "grid-cols-[4.2rem_3.4rem_6.5rem_1fr_1.2rem]";
const FULL_COLS = "grid-cols-[4.5rem_3.5rem_7rem_5.5rem_1fr_1fr_5rem_1.4fr]";

const options = <K extends string>(labels: Record<K, string>) => (Object.keys(labels) as K[]).map((k) => (
  <option key={k} value={k}>
    {labels[k]}
  </option>
));

// The intervals of possession_<video>: filters, pages (no inner scroll) and one click to play the moment. Compact by
// default (Inicio, Duración, Equipo, Tipo); `full` adds first/last player, ball source and flags (the wide dialog).
export function PossessionTable({
  rows, total, filter, onFilter, selected, onSelect, reviews, sampleOnly, onSampleOnly, hasSample, full = false, onFull,
}: {
  rows: PossessionRow[];
  total: number;
  filter: RowFilter;
  onFilter: (f: RowFilter) => void;
  selected: string | null;
  onSelect: (r: PossessionRow) => void;
  reviews: Map<string, Review>;
  sampleOnly: boolean;
  onSampleOnly: (v: boolean) => void;
  hasSample: boolean;
  full?: boolean;
  onFull?: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const idx = selected ? rows.findIndex((r) => rowId(r) === selected) : -1;
  const { boxRef, rows: page, page: p, pages, setPage } = usePaged(rows, ROW_H, idx >= 0 ? idx : null);
  const filtered = isFiltered(filter) || sampleOnly;
  const cols = full ? FULL_COLS : COMPACT_COLS;
  return (
    <Card title="Intervalos" note={`${rows.length} de ${total}`} className={full ? "" : "flex h-full flex-col !p-3"}>
      <div className="mb-2 flex flex-wrap items-end gap-x-2 gap-y-1 text-[11px] text-muted">
        <label>
          Equipo
          <select className="input mt-0.5 block !py-1 text-xs" value={filter.team} onChange={(e) => onFilter({ ...filter, team: e.target.value as RowFilter["team"] })}>
            <option value="all">Todos</option>
            {options(TEAM_LABEL)}
          </select>
        </label>
        <label>
          Tipo
          <select className="input mt-0.5 block !py-1 text-xs" value={filter.kind} onChange={(e) => onFilter({ ...filter, kind: e.target.value as RowFilter["kind"] })}>
            <option value="all">Todos</option>
            {options(KIND_LABEL as Record<PossessionKind, string>)}
          </select>
        </label>
        {(full || more) && (
        <label>
          Balón
          <select className="input mt-0.5 block !py-1 text-xs" value={filter.source} onChange={(e) => onFilter({ ...filter, source: e.target.value as RowFilter["source"] })}>
            <option value="all">Todos</option>
            {options(SRC_LABEL as Record<BallSrc | "mixed", string>)}
          </select>
        </label>
        )}
        {(full || more) && (
        <label>
          Interpolado
          <select className="input mt-0.5 block !py-1 text-xs" value={filter.interp} onChange={(e) => onFilter({ ...filter, interp: e.target.value as RowFilter["interp"] })}>
            <option value="all">Todos</option>
            <option value="yes">Con balón interpolado</option>
            <option value="no">Sin interpolar</option>
          </select>
        </label>
        )}
        <label title="Solo intervalos más largos que esto">
          Mayor a (s)
          <input
            type="number"
            inputMode="decimal"
            min={0}
            step={0.5}
            className="input tc mt-0.5 block w-20 !py-1 text-xs"
            aria-label="Duración mínima en segundos"
            value={draft ?? (filter.minDur === null ? "" : String(filter.minDur))}
            onFocus={() => setDraft(filter.minDur === null ? "" : String(filter.minDur))}
            onBlur={() => setDraft(null)}
            onChange={(e) => {
              setDraft(e.target.value);
              onFilter({ ...filter, minDur: parseMinDur(e.target.value) });
            }}
          />
        </label>
        {hasSample && (
          <label className="flex items-center gap-1.5 pb-2">
            <input type="checkbox" checked={sampleOnly} onChange={(e) => onSampleOnly(e.target.checked)} />
            Solo la muestra
          </label>
        )}
        {!full && (
          <button type="button" className="btn btn-ghost !px-2 !py-1 text-[11px]" aria-expanded={more} onClick={() => setMore((m) => !m)}>
            {more ? "Menos filtros" : "Más filtros"}
          </button>
        )}
        {filtered && (
          <button type="button" className="btn btn-ghost !px-2 !py-1 text-[11px]" onClick={() => { onFilter(NO_FILTER); onSampleOnly(false); setDraft(null); }}>
            Quitar filtros
          </button>
        )}
      </div>
      <div className={`grid ${cols} gap-x-2 border-b border-line-soft pb-1 text-[11px] text-faint`} role="row">
        <span>Inicio</span>
        <span className="text-right">Dur.</span>
        <span>Equipo</span>
        <span>Tipo</span>
        {full ? (
          <>
            <span>Primera</span>
            <span>Última</span>
            <span>Balón</span>
            <span>Banderas</span>
          </>
        ) : (
          <span />
        )}
      </div>
      <div ref={boxRef} className={`overflow-hidden ${full ? "" : "min-h-0 flex-1"}`} style={full ? { height: ROW_H * 12 } : undefined}>
        {rows.length === 0 ? (
          <p className="pt-3 text-sm text-faint">Ningún intervalo con estos filtros.</p>
        ) : (
          page.map((r) => {
            const id = rowId(r);
            const rv = reviews.get(id);
            return (
              <button
                key={id}
                type="button"
                onClick={() => onSelect(r)}
                aria-pressed={selected === id}
                title={`Reproducir este momento (${fmtTd(r.t_start)} – ${fmtTd(r.t_end)})`}
                className={`grid w-full ${cols} items-center gap-x-2 border-b border-line-soft px-0 text-left text-xs hover:bg-raised ${selected === id ? "bg-raised" : ""}`}
                style={{ height: ROW_H }}
              >
                <span className="tc text-ink">{fmtT(r.t_start)}</span>
                <span className="tc text-right text-muted">{rowDuration(r).toFixed(1)} s</span>
                <span>
                  <span className={TEAM_CLS[r.team]}>{TEAM_LABEL[r.team]}</span>
                </span>
                <span className="truncate text-muted">{KIND_LABEL[r.kind]}</span>
                {full ? (
                  <>
                    <span className="truncate text-muted">{r.first_player ?? "—"}</span>
                    <span className="truncate text-muted">{r.last_player ?? "—"}</span>
                    <span className="text-muted">{SRC_LABEL[r.flags.ball_source]}</span>
                    <span className="flex min-w-0 items-center gap-1 overflow-hidden">
                      {r.flags.ball_interp && <span className="tag tag-warn">interpolado</span>}
                      {r.flags.player_interp && <span className="tag tag-warn">jug. interp.</span>}
                      {rv && <span className={rv.verdict === "correct" ? "tag tag-accent" : "tag tag-warn"}>{rv.verdict === "correct" ? "correcto" : "incorrecto"}</span>}
                      <span className="truncate text-faint">{r.flags.notes.map((n) => NOTE_LABEL[n] ?? n).join(", ")}</span>
                    </span>
                  </>
                ) : (
                  <span className={rv ? (rv.verdict === "correct" ? "text-ok" : "text-danger") : "text-faint"} title={rv ? (rv.verdict === "correct" ? "Revisado: correcto" : "Revisado: incorrecto") : "Sin revisar"}>
                    {rv ? (rv.verdict === "correct" ? "✓" : "✗") : "·"}
                  </span>
                )}
              </button>
            );
          })
        )}
      </div>
      <Pager page={p} pages={pages} setPage={setPage} />
      {!full && onFull && (
        <button type="button" className="btn btn-ghost mt-2 shrink-0 self-start text-xs" onClick={onFull}>
          Ver tabla completa
        </button>
      )}
    </Card>
  );
}

"use client";

import { ArrowClockwise, CaretLeft, CaretRight } from "@phosphor-icons/react";
import { useEffect, useRef } from "react";
import { COLORS, Pitch, toMeters } from "@/components/Pitch";
import { Card, btn, input } from "@/components/Shell";
import { fmtT } from "@/lib/format";
import { endKind, missingEnd, missingReview, retype } from "@/lib/tagging";
import {
  DETAIL_KEYS,
  DETAIL_TITLES,
  EVENT_DETAILS,
  EVENT_LABELS,
  EVENT_OUTCOMES,
  EVENT_TYPES,
  OUTCOME_KEYS,
  type EventType,
  type Match,
  type MatchEvent,
} from "@/lib/types";
import { GoalFrame } from "./GoalFrame";

const teamColor = (e: MatchEvent) => (e.team === "own" ? COLORS.own : e.team === "opp" ? COLORS.opp : "var(--color-faint)");
const r1 = (v: number) => Math.round(v * 10) / 10;

// Passes 2 and 3: one event at a time. The video plays from 3 s before the event and stops just after it.
// Enter goes to the next one, Shift + Enter to the previous one, R plays it again.
export function ReviewPanel({
  pass,
  match,
  list,
  all,
  current,
  setCurrent,
  update,
  playClip,
}: {
  pass: 2 | 3;
  match: Match;
  // Events of this pass after the filters, in time order.
  list: MatchEvent[];
  // Every event of the video, to draw the others faintly.
  all: MatchEvent[];
  current: string | null;
  setCurrent: (id: string | null) => void;
  update: (id: string, patch: Partial<MatchEvent>) => void;
  playClip: (t0: number, t1: number) => void;
}) {
  const i = Math.max(0, list.findIndex((e) => e.event_id === current));
  const e = list[i] ?? null;
  const svgRef = useRef<SVGSVGElement>(null);

  // Each time another event is opened, its moment is played once.
  const replay = () => e && playClip(Math.max(0, e.t_video - 3), e.t_video + 1.5);
  const replayRef = useRef(replay);
  const go = (step: number) => {
    const next = list[Math.min(list.length - 1, Math.max(0, i + step))];
    if (next) setCurrent(next.event_id);
  };
  const goRef = useRef(go);
  const completeRef = useRef<(k: string) => boolean>(() => false);
  useEffect(() => {
    replayRef.current = replay;
    goRef.current = go;
  });
  const eventId = e?.event_id;
  useEffect(() => {
    if (eventId) replayRef.current();
  }, [eventId]);

  // Result and detail keep the keys of the first pass: 1 2 3 and 7 8 9.
  const outcomes = e ? Object.entries(EVENT_OUTCOMES[e.type] ?? {}) : [];
  const details = e ? Object.entries(EVENT_DETAILS[e.type] ?? {}) : [];
  useEffect(() => {
    completeRef.current = (k: string) => {
      if (!e || pass !== 2) return false;
      const o = OUTCOME_KEYS.indexOf(k);
      const d = DETAIL_KEYS.indexOf(k);
      if (o >= 0 && outcomes[o]) return update(e.event_id, { outcome: e.outcome === outcomes[o][0] ? null : outcomes[o][0] }), true;
      if (d >= 0 && details[d]) return update(e.event_id, { detail: e.detail === details[d][0] ? null : details[d][0] }), true;
      return false;
    };
  });
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const el = ev.target as HTMLElement;
      const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
      if (ev.key === "Enter") {
        ev.preventDefault();
        (el as HTMLInputElement).blur?.();
        goRef.current(ev.shiftKey ? -1 : 1);
        return;
      }
      if (typing || ev.ctrlKey || ev.metaKey || ev.altKey) return;
      if (ev.key.toLowerCase() === "r") replayRef.current();
      else completeRef.current(ev.key);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (list.length === 0) {
    return (
      <Card title={pass === 2 ? "Revisión" : "Ejecución"}>
        <p className="text-sm text-muted">
          {pass === 2
            ? "No hay eventos con estos filtros."
            : "No hay tiros, centros, córners, tiros libres ni penales con estos filtros. Esta pasada solo trabaja con esos tipos."}
        </p>
      </Card>
    );
  }
  if (!e) return null;

  const missing = pass === 2 ? missingReview(e) : missingEnd(e) ? ["destino"] : [];
  const kind = endKind(e.type);
  const nav = (
    <div className="flex items-center gap-2">
      <button type="button" className={`${btn} h-8 w-8 !p-0`} aria-label="Anterior (Shift + Enter)" title="Anterior (Shift + Enter)" disabled={i === 0} onClick={() => go(-1)}>
        <CaretLeft size={14} />
      </button>
      <span className="tc text-xs text-muted">
        {i + 1} de {list.length}
      </span>
      <button type="button" className={`${btn} h-8 w-8 !p-0`} aria-label="Siguiente (Enter)" title="Siguiente (Enter)" disabled={i === list.length - 1} onClick={() => go(1)}>
        <CaretRight size={14} />
      </button>
      <button type="button" className={`${btn} ml-auto`} title="Volver a ver (R)" onClick={replay}>
        <ArrowClockwise size={14} />
        Ver otra vez <kbd className="kbd">R</kbd>
      </button>
    </div>
  );

  return (
    <Card title={pass === 2 ? "Revisión" : "Ejecución"} note={<span className="tc">{fmtT(e.t_video)}</span>}>
      {nav}
      <div className="mt-4 flex flex-wrap items-center gap-2">
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
        <button
          type="button"
          className="inline-flex items-center gap-1.5 text-sm text-ink-2"
          title="Cambiar de equipo"
          onClick={() => update(e.event_id, { team: e.team === "own" ? "opp" : "own" })}
        >
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: teamColor(e) }} />
          {e.team === "own" ? match.focus_team : match.other_team}
        </button>
        <span className="ml-auto flex items-center gap-1 text-[11px] text-faint">
          tiempo
          <button type="button" className="link" onClick={() => update(e.event_id, { t_video: r1(Math.max(0, e.t_video - 0.5)) })}>
            −0.5 s
          </button>
          <button type="button" className="link" onClick={() => update(e.event_id, { t_video: r1(e.t_video + 0.5) })}>
            +0.5 s
          </button>
        </span>
      </div>

      {pass === 2 && (
        <>
          <div className="mt-3">
            <Pitch
              svgRef={svgRef}
              className="cursor-crosshair"
              onPointerDown={(ev) => {
                if (!svgRef.current) return;
                const p = toMeters(svgRef.current, ev);
                update(e.event_id, { x: r1(p.x), y: r1(p.y) });
              }}
            >
              {all.map((o) =>
                o.x === null || o.y === null || o.event_id === e.event_id ? null : (
                  <circle key={o.event_id} cx={o.x} cy={o.y} r={0.8} fill={teamColor(o)} opacity={0.25} />
                ),
              )}
              {e.x !== null && e.y !== null && (
                <>
                  <circle cx={e.x} cy={e.y} r={2.2} fill="none" stroke="#ffffff" strokeWidth={0.45} />
                  <circle cx={e.x} cy={e.y} r={1} fill={teamColor(e)} />
                </>
              )}
            </Pitch>
            <p className="mt-1 text-[11px] text-faint">
              Clic en la cancha donde ocurrió. El equipo analizado ataca siempre hacia la derecha.
              {e.x !== null && (
                <button type="button" className="link ml-2" onClick={() => update(e.event_id, { x: null, y: null })}>
                  quitar posición
                </button>
              )}
            </p>
          </div>
          {(outcomes.length > 0 || details.length > 0) && (
            <div className="mt-3 space-y-2">
              {(
                [
                  ["Resultado", outcomes, OUTCOME_KEYS, "outcome"],
                  [DETAIL_TITLES[e.type] ?? "Detalle", details, DETAIL_KEYS, "detail"],
                ] as const
              ).map(([title, options, keys, field]) =>
                options.length === 0 ? null : (
                  <div key={field} className="flex flex-wrap items-center gap-1.5">
                    <span className="w-20 text-[11px] text-faint">{title}</span>
                    {options.map(([value, label], n) => {
                      const on = (e[field] ?? null) === value;
                      return (
                        <button
                          key={value}
                          type="button"
                          aria-pressed={on}
                          onClick={() => update(e.event_id, { [field]: on ? null : value })}
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
          <div className="mt-3 grid grid-cols-[8rem_1fr] gap-2">
            <input
              className={input}
              list="known-players"
              placeholder="Jugadora"
              aria-label="Jugadora"
              value={e.player_id ?? ""}
              onChange={(ev) => update(e.event_id, { player_id: ev.target.value || null })}
            />
            <input className={input} placeholder="Nota" aria-label="Nota" value={e.note ?? ""} onChange={(ev) => update(e.event_id, { note: ev.target.value || null })} />
          </div>
        </>
      )}

      {pass === 3 && kind === "goal" && (
        <div className="mt-3">
          <GoalFrame
            onPick={(y, z) => update(e.event_id, { goal_y: y, goal_z: z })}
            marks={all
              .filter((o) => o.goal_y != null && o.goal_z != null)
              .map((o) => ({
                id: o.event_id,
                y: o.goal_y as number,
                z: o.goal_z as number,
                color: teamColor(o),
                current: o.event_id === e.event_id,
                title: `${EVENT_LABELS[o.type]} · ${fmtT(o.t_video)}`,
              }))}
          />
          <p className="mt-1 text-[11px] text-faint">
            Clic donde cruzó la línea de gol, vista desde quien remata. Fuera del marco si fue desviado o por encima.
            {e.goal_y != null && (
              <button type="button" className="link ml-2" onClick={() => update(e.event_id, { goal_y: null, goal_z: null })}>
                quitar
              </button>
            )}
          </p>
        </div>
      )}
      {pass === 3 && kind === "landing" && (
        <div className="mt-3">
          <Pitch
            svgRef={svgRef}
            className="cursor-crosshair"
            onPointerDown={(ev) => {
              if (!svgRef.current) return;
              const p = toMeters(svgRef.current, ev);
              update(e.event_id, { x_end: r1(p.x), y_end: r1(p.y) });
            }}
          >
            {e.x !== null && e.y !== null && <circle cx={e.x} cy={e.y} r={1} fill={teamColor(e)} />}
            {e.x_end != null && e.y_end != null && (
              <>
                {e.x !== null && e.y !== null && (
                  <line x1={e.x} y1={e.y} x2={e.x_end} y2={e.y_end} stroke="#ffffff" strokeWidth={0.4} strokeDasharray="1 0.8" />
                )}
                <circle cx={e.x_end} cy={e.y_end} r={1.4} fill="none" stroke="#ffffff" strokeWidth={0.45} />
              </>
            )}
          </Pitch>
          <p className="mt-1 text-[11px] text-faint">
            Clic donde cayó el balón.{e.x === null && " Este evento no tiene posición de origen: se pone en la revisión (pasada 2)."}
            {e.x_end != null && (
              <button type="button" className="link ml-2" onClick={() => update(e.event_id, { x_end: null, y_end: null })}>
                quitar
              </button>
            )}
          </p>
        </div>
      )}

      <p className={`mt-3 text-xs ${missing.length ? "text-warn" : "text-ok"}`}>
        {missing.length ? `Falta: ${missing.join(", ")}.` : "Completo."} <span className="text-faint">Enter: siguiente.</span>
      </p>
    </Card>
  );
}

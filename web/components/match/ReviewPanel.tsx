"use client";

import { ArrowClockwise, CaretLeft, CaretRight, Minus, Plus, SoccerBall, Target } from "@phosphor-icons/react";
import { useEffect, useRef } from "react";
import { Pitch, toMeters } from "@/components/Pitch";
import { Select } from "@/components/Select";
import { Card, btn, input } from "@/components/Shell";
import { fmtT, isTyping } from "@/lib/format";
import { endKind, missingEnd, missingReview, retype } from "@/lib/tagging";
import { DETAIL_KEYS, DETAIL_TITLES, EVENT_DETAILS, EVENT_LABELS, EVENT_OUTCOMES, OUTCOME_KEYS, type Match, type MatchEvent } from "@/lib/types";
import { GoalFrame } from "./GoalFrame";
import { TYPE_OPTIONS, teamColor, teamOptions } from "./eventOptions";
import { PlayerPicker, type PlayerChoice } from "./PlayerPicker";

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
// + / − move the moment of the event by this much (s).
const NUDGE_S = 0.1;

// The ball from the tracking around the playhead, on the pitch (analysed team attacking right). Null: no tracking here.
export interface BallView {
  now: [number, number] | null;
  trail: [number, number][];
}

// Passes 2 and 3: one event at a time. The video plays from 3 s before the event and stops just after it.
// Enter goes to the next one, Shift + Enter to the previous one, R plays it again, M takes the frame on screen as the
// moment of the event, + / − move it a tenth of a second, V picks the player on the video.
export function ReviewPanel({
  pass,
  match,
  list,
  all,
  current,
  setCurrent,
  update,
  playClip,
  time,
  players,
  near,
  ball,
  picking,
  onPickVideo,
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
  // Playhead (s).
  time: number;
  players: PlayerChoice[];
  // Who the tracking puts near the ball at the moment of the event.
  near: PlayerChoice[];
  ball: BallView | null;
  picking: boolean;
  // Null when this moment has no processed part to click on.
  onPickVideo: (() => void) | null;
}) {
  const i = Math.max(0, list.findIndex((e) => e.event_id === current));
  const e = list[i] ?? null;
  const svgRef = useRef<SVGSVGElement>(null);

  // Each time another event is opened, its moment is played once.
  const replay = () => e && playClip(Math.max(0, e.t_video - 3), e.t_video + 1.5);
  const go = (step: number) => {
    const next = list[Math.min(list.length - 1, Math.max(0, i + step))];
    if (next) setCurrent(next.event_id);
  };
  const shift = (ds: number) => e && update(e.event_id, { t_video: r2(Math.max(0, e.t_video + ds)) });
  const atFrame = () => e && update(e.event_id, { t_video: r2(time) });
  const replayRef = useRef(replay);
  const goRef = useRef(go);
  const shiftRef = useRef(shift);
  const atFrameRef = useRef(atFrame);
  const pickRef = useRef(onPickVideo);
  const completeRef = useRef<(k: string) => boolean>(() => false);
  useEffect(() => {
    replayRef.current = replay;
    goRef.current = go;
    shiftRef.current = shift;
    atFrameRef.current = atFrame;
    pickRef.current = onPickVideo;
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
      const typing = isTyping(el);
      if (ev.key === "Enter") {
        ev.preventDefault();
        (el as HTMLInputElement).blur?.();
        goRef.current(ev.shiftKey ? -1 : 1);
        return;
      }
      if (typing || ev.ctrlKey || ev.metaKey || ev.altKey) return;
      const k = ev.key.toLowerCase();
      // + / −: the moment of the event.
      if (k === "+" || k === "=" || k === "-") {
        ev.preventDefault();
        shiftRef.current(k === "-" ? -NUDGE_S : NUDGE_S);
      } else if (k === "r") replayRef.current();
      else if (k === "m") atFrameRef.current();
      else if (k === "v") pickRef.current?.();
      else completeRef.current(ev.key);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (list.length === 0) {
    return (
      <Card title={pass === 2 ? "Revisión" : "Ejecución"}>
        <p className="text-sm text-muted">
          {pass === 2 ? "No hay eventos con estos filtros." : "No hay tiros, centros, córners, tiros libres ni penales con estos filtros."}
        </p>
      </Card>
    );
  }
  if (!e) return null;

  const missing = pass === 2 ? missingReview(e) : missingEnd(e) ? ["destino"] : [];
  const kind = endKind(e.type);
  const offBy = r2(time - e.t_video);

  return (
    <Card>
      <div className="flex items-center gap-2">
        <button type="button" className={`${btn} h-8 w-8 !p-0`} aria-label="Anterior (Shift + Enter)" title="Anterior (Shift + Enter)" disabled={i === 0} onClick={() => go(-1)}>
          <CaretLeft size={14} />
        </button>
        <span className="tc text-xs text-muted">
          {i + 1} / {list.length}
        </span>
        <button type="button" className={`${btn} h-8 w-8 !p-0`} aria-label="Siguiente (Enter)" title="Siguiente (Enter)" disabled={i === list.length - 1} onClick={() => go(1)}>
          <CaretRight size={14} />
        </button>
        <span className={`ml-2 text-xs ${missing.length ? "text-warn" : "text-ok"}`}>{missing.length ? `Falta ${missing.join(", ")}` : "Completo"}</span>
        <button type="button" className={`${btn} ml-auto h-8 !px-2.5`} title="Volver a ver (R)" onClick={replay}>
          <ArrowClockwise size={14} />
          <kbd className="kbd">R</kbd>
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Select variant="field" label="Tipo de evento" value={e.type} options={TYPE_OPTIONS} onChange={(t) => t && update(e.event_id, retype(e, t))} />
        <Select variant="field" label="Equipo" value={e.team === "own" || e.team === "opp" ? e.team : null} options={teamOptions(match)} onChange={(t) => t && update(e.event_id, { team: t })} />
      </div>

      {/* The moment of the event: nudged, or taken from the frame on screen. */}
      <div className="mt-3 flex items-center gap-2 rounded-xl bg-bg/60 p-1.5">
        <button type="button" className={`${btn} h-7 w-7 !p-0`} aria-label="Antes (−)" title={`−${NUDGE_S} s (−)`} onClick={() => shift(-NUDGE_S)}>
          <Minus size={12} />
        </button>
        <span className="tc min-w-[4.5rem] text-center text-sm text-ink">{fmtT(e.t_video)}</span>
        <button type="button" className={`${btn} h-7 w-7 !p-0`} aria-label="Después (+)" title={`+${NUDGE_S} s (+)`} onClick={() => shift(NUDGE_S)}>
          <Plus size={12} />
        </button>
        <button
          type="button"
          className={`${btn} ml-auto h-7 !px-2.5 text-xs`}
          disabled={Math.abs(offBy) < 0.05}
          title="El momento del evento pasa a ser el cuadro que se ve ahora (M)"
          onClick={atFrame}
        >
          <Target size={13} />
          Este cuadro
          {Math.abs(offBy) >= 0.05 && <span className="tc text-faint">{offBy > 0 ? "+" : ""}{offBy.toFixed(1)} s</span>}
          <kbd className="kbd">M</kbd>
        </button>
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
                o.x === null || o.y === null || o.event_id === e.event_id ? null : <circle key={o.event_id} cx={o.x} cy={o.y} r={0.8} fill={teamColor(o)} opacity={0.25} />,
              )}
              {ball && ball.trail.length > 1 && (
                <polyline points={ball.trail.map((p) => p.join(",")).join(" ")} fill="none" stroke="#ffffff" strokeWidth={0.35} strokeOpacity={0.45} strokeLinecap="round" pointerEvents="none" />
              )}
              {ball?.now && <circle cx={ball.now[0]} cy={ball.now[1]} r={0.9} fill="#ffffff" stroke="var(--color-bg)" strokeWidth={0.25} pointerEvents="none" />}
              {e.x !== null && e.y !== null && (
                <>
                  <circle cx={e.x} cy={e.y} r={2.2} fill="none" stroke="#ffffff" strokeWidth={0.45} />
                  <circle cx={e.x} cy={e.y} r={1} fill={teamColor(e)} />
                </>
              )}
            </Pitch>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-faint">
              <span>Clic donde ocurrió · {match.focus_team} ataca a la derecha</span>
              {ball?.now && (
                <button type="button" className="link inline-flex items-center gap-1" onClick={() => ball.now && update(e.event_id, { x: r1(ball.now[0]), y: r1(ball.now[1]) })}>
                  <SoccerBall size={12} />
                  donde está el balón
                </button>
              )}
              {e.x !== null && (
                <button type="button" className="link ml-auto" onClick={() => update(e.event_id, { x: null, y: null })}>
                  quitar
                </button>
              )}
            </div>
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
          <div className="mt-3">
            <PlayerPicker
              value={e.player_id ?? ""}
              onChange={(v) => update(e.event_id, { player_id: v || null })}
              choices={players}
              near={near}
              picking={picking}
              onPickVideo={onPickVideo ?? undefined}
            />
          </div>
          <input className={`${input} mt-2 w-full`} placeholder="Nota" aria-label="Nota" value={e.note ?? ""} onChange={(ev) => update(e.event_id, { note: ev.target.value || null })} />
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
          <p className="mt-1 flex text-[11px] text-faint">
            Clic donde cruzó la línea de gol, vista desde quien remata.
            {e.goal_y != null && (
              <button type="button" className="link ml-auto" onClick={() => update(e.event_id, { goal_y: null, goal_z: null })}>
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
            {ball && ball.trail.length > 1 && (
              <polyline points={ball.trail.map((p) => p.join(",")).join(" ")} fill="none" stroke="#ffffff" strokeWidth={0.35} strokeOpacity={0.45} pointerEvents="none" />
            )}
            {ball?.now && <circle cx={ball.now[0]} cy={ball.now[1]} r={0.9} fill="#ffffff" stroke="var(--color-bg)" strokeWidth={0.25} pointerEvents="none" />}
            {e.x !== null && e.y !== null && <circle cx={e.x} cy={e.y} r={1} fill={teamColor(e)} />}
            {e.x_end != null && e.y_end != null && (
              <>
                {e.x !== null && e.y !== null && <line x1={e.x} y1={e.y} x2={e.x_end} y2={e.y_end} stroke="#ffffff" strokeWidth={0.4} strokeDasharray="1 0.8" />}
                <circle cx={e.x_end} cy={e.y_end} r={1.4} fill="none" stroke="#ffffff" strokeWidth={0.45} />
              </>
            )}
          </Pitch>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 text-[11px] text-faint">
            <span>Clic donde cayó el balón.{e.x === null && " Sin posición de origen (pasada 2)."}</span>
            {ball?.now && (
              <button type="button" className="link inline-flex items-center gap-1" onClick={() => ball.now && update(e.event_id, { x_end: r1(ball.now[0]), y_end: r1(ball.now[1]) })}>
                <SoccerBall size={12} />
                donde está el balón
              </button>
            )}
            {e.x_end != null && (
              <button type="button" className="link ml-auto" onClick={() => update(e.event_id, { x_end: null, y_end: null })}>
                quitar
              </button>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

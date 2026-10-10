"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { COLORS, Pitch, toMeters } from "@/components/Pitch";
import { Card, btn, input } from "@/components/Shell";
import type { PlayerHandle } from "@/components/VideoPlayer";
import { fmtT } from "@/lib/format";
import { mutate, uid } from "@/lib/store";
import { EVENT_KEYS, EVENT_LABELS, EVENT_TYPES, type EventType, type Match, type MatchEvent } from "@/lib/types";

type Props = {
  match: Match;
  events: MatchEvent[];
  time: number;
  playerRef: RefObject<PlayerHandle | null>;
};

export function TagTab({ match, events, time, playerRef }: Props) {
  const [team, setTeam] = useState<"own" | "opp">("own");
  const [period, setPeriod] = useState<1 | 2>(1);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [playerId, setPlayerId] = useState("");
  const [note, setNote] = useState("");
  // Seconds subtracted from the current time: you press the key after the action happened.
  const [lag, setLag] = useState(3);
  const svgRef = useRef<SVGSVGElement>(null);

  const add = (type: EventType) => {
    const t = Math.max(0, (playerRef.current?.getTime() ?? 0) - lag);
    const ev: MatchEvent = {
      event_id: uid("e"),
      match_id: match.match_id,
      t_video: Math.round(t * 10) / 10,
      period,
      type,
      team,
      player_id: playerId.trim() || null,
      x: pos ? Math.round(pos.x * 10) / 10 : null,
      y: pos ? Math.round(pos.y * 10) / 10 : null,
      outcome: null,
      note: note.trim() || null,
    };
    mutate((s) => ({ ...s, events: [...s.events, ev] }));
    setPos(null);
    setNote("");
    setPlayerId("");
  };
  const addRef = useRef(add);
  useEffect(() => {
    addRef.current = add;
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "a") setTeam("own");
      else if (e.key === "s") setTeam("opp");
      else {
        const type = EVENT_TYPES.find((t) => EVENT_KEYS[t] === e.key);
        if (type) addRef.current(type);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const update = (id: string, patch: Partial<MatchEvent>) =>
    mutate((s) => ({ ...s, events: s.events.map((e) => (e.event_id === id ? { ...e, ...patch } : e)) }));
  const remove = (id: string) => mutate((s) => ({ ...s, events: s.events.filter((e) => e.event_id !== id) }));
  const makePlay = (e: MatchEvent) =>
    mutate((s) => ({
      ...s,
      plays: [
        ...s.plays,
        {
          play_id: uid("p"),
          match_id: match.match_id,
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
      className={`flex-1 rounded-md border px-3 py-2 text-sm font-medium ${
        team === t ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 bg-white text-slate-700"
      }`}
    >
      <span className="mr-1.5 inline-block h-2.5 w-2.5 rounded-full" style={{ background: t === "own" ? COLORS.own : COLORS.opp }} />
      {label} <kbd className="ml-1 text-[10px] opacity-60">{key}</kbd>
    </button>
  );

  return (
    <div className="space-y-4">
      <Card title="Nuevo evento">
        <ol className="mb-3 list-inside list-decimal text-xs text-slate-600">
          <li>Elige el equipo. 2. (Opcional) haz clic en la cancha donde ocurrió. 3. Pulsa el tipo de evento o su tecla.</li>
        </ol>
        <div className="flex gap-2">
          {teamBtn("own", match.focus_team, "A")}
          {teamBtn("opp", match.other_team, "S")}
        </div>
        <div className="mt-3 grid gap-3 2xl:grid-cols-2">
          <div>
            <Pitch
              svgRef={svgRef}
              className="cursor-crosshair"
              onPointerDown={(e) => svgRef.current && setPos(toMeters(svgRef.current, e))}
            >
              {events.map((e) =>
                e.x === null || e.y === null ? null : (
                  <circle key={e.event_id} cx={e.x} cy={e.y} r={0.9} fill={e.team === "own" ? COLORS.own : COLORS.opp} opacity={0.35} />
                ),
              )}
              {pos && <circle cx={pos.x} cy={pos.y} r={1.8} fill="none" stroke="#0b0b0b" strokeWidth={0.6} />}
              {pos && <circle cx={pos.x} cy={pos.y} r={0.5} fill="#0b0b0b" />}
            </Pitch>
            <div className="text-xs text-slate-500">
              {pos ? `Posición: x ${pos.x.toFixed(1)} m, y ${pos.y.toFixed(1)} m` : "Sin posición (se guardará vacía)."}
              {pos && (
                <button type="button" className="ml-2 underline" onClick={() => setPos(null)}>
                  quitar
                </button>
              )}
            </div>
          </div>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
              {EVENT_TYPES.map((t) => (
                <button key={t} type="button" onClick={() => add(t)} className={`${btn} flex items-center justify-between gap-1 text-left`}>
                  <span className="truncate">{EVENT_LABELS[t]}</span>
                  <kbd className="rounded bg-slate-100 px-1 text-[10px] text-slate-500">{EVENT_KEYS[t]}</kbd>
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
              <label className="flex items-center gap-1">
                Periodo
                <select className={input} value={period} onChange={(e) => setPeriod(Number(e.target.value) as 1 | 2)}>
                  <option value={1}>1</option>
                  <option value={2}>2</option>
                </select>
              </label>
              <label className="flex items-center gap-1">
                Restar
                <select className={input} value={lag} onChange={(e) => setLag(Number(e.target.value))}>
                  {[0, 2, 3, 5].map((v) => (
                    <option key={v} value={v}>
                      {v} s
                    </option>
                  ))}
                </select>
              </label>
              <span className="font-mono tabular-nums">Ahora: {fmtT(time)}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              <input className={`${input} w-28`} placeholder="Jugadora (#)" value={playerId} onChange={(e) => setPlayerId(e.target.value)} />
              <input className={`${input} min-w-0 flex-1`} placeholder="Nota (opcional)" value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
          </div>
        </div>
      </Card>

      <Card title={`Eventos etiquetados (${events.length})`}>
        {events.length === 0 ? (
          <p className="text-sm text-slate-500">Aún no hay eventos. Reproduce el video y etiqueta con los botones o las teclas.</p>
        ) : (
          <div className="max-h-96 overflow-auto">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-white text-xs text-slate-500">
                <tr>
                  <th className="py-1 pr-2 font-medium">Tiempo</th>
                  <th className="py-1 pr-2 font-medium">Tipo</th>
                  <th className="py-1 pr-2 font-medium">Equipo</th>
                  <th className="py-1 pr-2 font-medium">Jug.</th>
                  <th className="py-1 pr-2 font-medium">Pos.</th>
                  <th className="py-1 pr-2 font-medium">Nota</th>
                  <th className="py-1 font-medium" />
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.event_id} className="border-t border-slate-100">
                    <td className="py-1 pr-2">
                      <button
                        type="button"
                        className="font-mono text-blue-700 tabular-nums underline"
                        onClick={() => playerRef.current?.seek(Math.max(0, e.t_video - 3), true)}
                      >
                        {fmtT(e.t_video)}
                      </button>
                    </td>
                    <td className="py-1 pr-2">
                      <select
                        className="bg-transparent text-sm"
                        value={e.type}
                        onChange={(ev) => update(e.event_id, { type: ev.target.value as EventType })}
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
                    <td className="py-1 pr-2">{e.player_id ?? "–"}</td>
                    <td className="py-1 pr-2 text-xs text-slate-500">{e.x === null ? "–" : `${e.x.toFixed(0)}, ${(e.y as number).toFixed(0)}`}</td>
                    <td className="max-w-40 truncate py-1 pr-2 text-xs text-slate-600">{e.note ?? ""}</td>
                    <td className="py-1 text-right text-xs whitespace-nowrap">
                      <button type="button" className="mr-2 underline" onClick={() => makePlay(e)}>
                        + jugada
                      </button>
                      <button type="button" className="text-red-700 underline" onClick={() => remove(e.event_id)}>
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
    </div>
  );
}

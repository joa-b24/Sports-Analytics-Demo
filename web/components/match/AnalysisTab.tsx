"use client";

import { useState } from "react";
import { CompareBars, ShotMap, StatTile, ZoneMap } from "@/components/charts";
import { Card, input } from "@/components/Shell";
import { countByType, shotsOf, zoneCounts } from "@/lib/stats";
import { EVENT_LABELS, EVENT_TYPES, type EventType, type Match, type MatchEvent } from "@/lib/types";

export function AnalysisTab({ match, events }: { match: Match; events: MatchEvent[] }) {
  const [zoneType, setZoneType] = useState<EventType>("recovery");
  const [zoneTeam, setZoneTeam] = useState<"own" | "opp">("own");
  const [period, setPeriod] = useState<0 | 1 | 2>(0);

  const evs = period === 0 ? events : events.filter((e) => e.period === period);
  const a = countByType(evs, "own");
  const b = countByType(evs, "opp");
  const A = match.focus_team;
  const B = match.other_team;
  const zones = zoneCounts(evs.filter((e) => e.type === zoneType && e.team === zoneTeam));

  if (events.length === 0) {
    return (
      <Card>
        <p className="text-sm text-slate-600">
          Aún no hay eventos etiquetados en este partido. Los gráficos de esta pestaña se calculan solo con lo que etiquetes en
          «Video y etiquetado».
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm text-slate-600">
        <label className="flex items-center gap-1.5">
          Periodo
          <select className={input} value={period} onChange={(e) => setPeriod(Number(e.target.value) as 0 | 1 | 2)}>
            <option value={0}>Todo el partido</option>
            <option value={1}>1.º tiempo</option>
            <option value={2}>2.º tiempo</option>
          </select>
        </label>
        <span className="text-xs text-slate-500">{evs.length} eventos etiquetados a mano.</span>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Goles" a={a.goal} b={b.goal} aLabel={A} bLabel={B} />
        <StatTile label="Tiros (incluye goles)" a={shotsOf(evs, "own").length} b={shotsOf(evs, "opp").length} aLabel={A} bLabel={B} />
        <StatTile label="Recuperaciones" a={a.recovery} b={b.recovery} aLabel={A} bLabel={B} />
        <StatTile label="Pérdidas" a={a.loss} b={b.loss} aLabel={A} bLabel={B} />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Eventos por tipo">
          <CompareBars aLabel={A} bLabel={B} rows={EVENT_TYPES.map((t) => ({ label: EVENT_LABELS[t], a: a[t], b: b[t] }))} />
          <details className="mt-3 text-xs text-slate-600">
            <summary className="cursor-pointer">Ver como tabla</summary>
            <table className="mt-2 w-full text-left">
              <thead>
                <tr className="text-slate-500">
                  <th className="font-medium">Tipo</th>
                  <th className="font-medium">{A}</th>
                  <th className="font-medium">{B}</th>
                </tr>
              </thead>
              <tbody>
                {EVENT_TYPES.map((t) => (
                  <tr key={t} className="border-t border-slate-100">
                    <td>{EVENT_LABELS[t]}</td>
                    <td className="tabular-nums">{a[t]}</td>
                    <td className="tabular-nums">{b[t]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </Card>

        <Card title="Mapa de tiros">
          <ShotMap events={evs} aLabel={A} bLabel={B} />
        </Card>

        <Card title="Dónde ocurre: zonas de la cancha" className="xl:col-span-2">
          <div className="mb-2 flex flex-wrap gap-2">
            <select className={input} value={zoneType} aria-label="Tipo de evento" onChange={(e) => setZoneType(e.target.value as EventType)}>
              {EVENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {EVENT_LABELS[t]}
                </option>
              ))}
            </select>
            <select className={input} value={zoneTeam} aria-label="Equipo" onChange={(e) => setZoneTeam(e.target.value as "own" | "opp")}>
              <option value="own">{A}</option>
              <option value="opp">{B}</option>
            </select>
          </div>
          <div className="mx-auto max-w-2xl">
            <ZoneMap grid={zones.grid} missing={zones.missing} />
          </div>
        </Card>
      </div>
    </div>
  );
}

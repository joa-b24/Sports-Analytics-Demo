"use client";

import Link from "next/link";
import { useState } from "react";
import { LineChart } from "@/components/charts";
import { COLORS } from "@/components/Pitch";
import { Card, DemoBadge, PageHeader, input } from "@/components/Shell";
import { fmtNum } from "@/lib/format";
import { mean } from "@/lib/stats";
import { useStore } from "@/lib/store";

const METRIC_LABELS: Record<string, string> = {
  duration_min: "Duración (min)",
  total_distance_m: "Distancia total (m)",
  hsr_distance_m: "Distancia a alta velocidad (m)",
  sprints: "Sprints",
  max_speed_kmh: "Velocidad máxima (km/h)",
  player_load: "Carga (player load)",
  hr_avg: "FC media (lpm)",
  hr_max: "FC máxima (lpm)",
};
const label = (m: string) => METRIC_LABELS[m] ?? m;

export default function Page() {
  const { sessions } = useStore();
  const metrics = [...new Set(sessions.flatMap((s) => Object.keys(s.metrics)))];
  const players = [...new Set(sessions.map((s) => s.player_id))].sort();
  const dates = [...new Set(sessions.map((s) => s.date))].sort();
  const [metricSel, setMetric] = useState("");
  const [playerSel, setPlayer] = useState("");
  const metric = metrics.includes(metricSel) ? metricSel : (metrics.find((m) => m === "total_distance_m") ?? metrics[0]);
  const player = players.includes(playerSel) ? playerSel : players[0];

  if (sessions.length === 0) {
    return (
      <>
        <PageHeader title="Entrenamientos" subtitle="Carga de trabajo por jugadora a partir de los datos de sensores (GPS, frecuencia cardiaca)." />
        <Card>
          <p className="text-sm text-slate-600">
            Aún no hay sesiones. Sube el CSV exportado de los sensores en{" "}
            <Link href="/datos" className="text-blue-700 underline">
              Datos
            </Link>{" "}
            (ahí está el formato esperado) o carga los datos de ejemplo.
          </p>
        </Card>
      </>
    );
  }

  const digits = metric === "max_speed_kmh" ? 1 : 0;
  // One value per player and date: mean if the player has several rows that day.
  const value = (p: string, d: string) => mean(sessions.filter((s) => s.player_id === p && s.date === d).map((s) => s.metrics[metric] ?? null));
  const perPlayer = players
    .map((p) => ({ p, v: mean(sessions.filter((s) => s.player_id === p).map((s) => s.metrics[metric] ?? null)) }))
    .sort((a, b) => (b.v ?? -1) - (a.v ?? -1));
  const max = Math.max(1, ...perPlayer.map((x) => x.v ?? 0));
  const teamMean = mean(perPlayer.map((x) => x.v));
  const isDemo = sessions.some((s) => s.is_demo);

  return (
    <>
      <PageHeader title="Entrenamientos" subtitle="Carga de trabajo por jugadora a partir de los datos de sensores.">
        {isDemo && <DemoBadge />}
      </PageHeader>
      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm text-slate-600">
        <label className="flex items-center gap-1.5">
          Métrica
          <select className={input} value={metric} onChange={(e) => setMetric(e.target.value)}>
            {metrics.map((m) => (
              <option key={m} value={m}>
                {label(m)}
              </option>
            ))}
          </select>
        </label>
        <span className="text-xs text-slate-500">
          {dates.length} sesiones · {players.length} jugadoras · {dates[0]} a {dates[dates.length - 1]}
        </span>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card title={`${label(metric)}: promedio por sesión, por jugadora`}>
          <div className="space-y-1.5">
            {perPlayer.map(({ p, v }) => (
              <button
                key={p}
                type="button"
                onClick={() => setPlayer(p)}
                title={`${p}: ${fmtNum(v, digits)}`}
                className={`grid w-full grid-cols-[4rem_1fr] items-center gap-2 rounded px-1 py-0.5 text-left ${p === player ? "bg-slate-100" : "hover:bg-slate-50"}`}
              >
                <span className="text-xs font-medium text-slate-700">{p}</span>
                <span className="flex items-center gap-2 border-l border-slate-300">
                  <span className="h-2.5 rounded-r" style={{ width: `${((v ?? 0) / max) * 80}%`, background: COLORS.own }} />
                  <span className="text-xs text-slate-600 tabular-nums">{fmtNum(v, digits)}</span>
                </span>
              </button>
            ))}
          </div>
          <p className="mt-3 text-xs text-slate-500">
            Promedio del equipo: {fmtNum(teamMean, digits)}. Haz clic en una jugadora para ver su evolución.
          </p>
        </Card>

        <Card title={`${player}: ${label(metric)} por sesión`}>
          <LineChart
            labels={dates}
            series={dates.map((d) => value(player, d))}
            reference={dates.map((d) => mean(players.map((p) => value(p, d))))}
            seriesLabel={player}
            referenceLabel="Promedio del equipo"
            fmt={(v) => fmtNum(v, digits)}
          />
        </Card>

        <Card title="Tabla por sesión" className="xl:col-span-2">
          <div className="max-h-80 overflow-auto">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-white text-slate-500">
                <tr>
                  <th className="py-1 pr-3 font-medium">Jugadora</th>
                  {dates.map((d) => (
                    <th key={d} className="py-1 pr-3 font-medium whitespace-nowrap">
                      {d.slice(5)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {players.map((p) => (
                  <tr key={p} className="border-t border-slate-100">
                    <td className="py-1 pr-3 font-medium text-slate-800">{p}</td>
                    {dates.map((d) => (
                      <td key={d} className="py-1 pr-3 text-slate-700 tabular-nums">
                        {fmtNum(value(p, d), digits)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </>
  );
}

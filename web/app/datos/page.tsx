"use client";

import { useState } from "react";
import { Card, PageHeader, btn, btnPrimary, input } from "@/components/Shell";
import { buildDemo } from "@/lib/demo";
import { downloadText, parseCsv, toCsv } from "@/lib/format";
import { EMPTY, mutate, uid, useStore } from "@/lib/store";
import { EVENT_TYPES, type EventType, type MatchEvent, type SessionRow, type State, type Team } from "@/lib/types";

const EVENT_COLUMNS = ["event_id", "match_id", "t_video", "period", "type", "team", "player_id", "x", "y", "outcome", "note"];
const SESSION_KEYS = ["date", "session_id", "player_id"];

// Empty or non-numeric cells become null (the contract's NaN): never filled in.
const num = (v: string | undefined): number | null => {
  if (v === undefined || v.trim() === "") return null;
  const n = Number(v.replace(",", "."));
  return Number.isFinite(n) ? n : null;
};

async function readFile(e: React.ChangeEvent<HTMLInputElement>): Promise<string | null> {
  const f = e.target.files?.[0];
  e.target.value = "";
  return f ? await f.text() : null;
}

export default function Page() {
  const state = useStore();
  const [msg, setMsg] = useState("");
  const [eventsMatch, setEventsMatch] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const matchId = state.matches.some((m) => m.match_id === eventsMatch) ? eventsMatch : (state.matches[0]?.match_id ?? "");

  const loadDemo = () => {
    const demo = buildDemo();
    mutate((s) => ({
      ...s,
      matches: [...s.matches.filter((m) => !m.is_demo), ...demo.matches],
      events: [...s.events.filter((e) => !e.event_id.startsWith("demo_")), ...demo.events],
      plays: [...s.plays.filter((p) => !p.play_id.startsWith("demo_")), ...demo.plays],
      sessions: [...s.sessions.filter((x) => !x.is_demo), ...demo.sessions],
    }));
    setMsg("Datos de ejemplo cargados: 1 partido de rival, 90 eventos, 1 jugada animada y 12 sesiones de entrenamiento.");
  };
  const removeDemo = () => {
    mutate((s) => ({
      ...s,
      matches: s.matches.filter((m) => !m.is_demo),
      events: s.events.filter((e) => !e.event_id.startsWith("demo_")),
      plays: s.plays.filter((p) => !p.play_id.startsWith("demo_")),
      sessions: s.sessions.filter((x) => !x.is_demo),
    }));
    setMsg("Datos de ejemplo eliminados. Tus datos reales no se tocaron.");
  };

  const importSessions = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const text = await readFile(e);
    if (text === null) return;
    const rows = parseCsv(text);
    const bad = rows.filter((r) => !r.date || !r.player_id).length;
    const parsed: SessionRow[] = rows
      .filter((r) => r.date && r.player_id)
      .map((r) => ({
        date: r.date,
        session_id: r.session_id || r.date,
        player_id: r.player_id,
        metrics: Object.fromEntries(Object.keys(r).filter((k) => !SESSION_KEYS.includes(k)).map((k) => [k, num(r[k])])),
      }));
    if (parsed.length === 0) return setMsg("No pude leer ninguna fila. El CSV necesita al menos las columnas date y player_id.");
    mutate((s) => ({ ...s, sessions: [...s.sessions, ...parsed] }));
    setMsg(`${parsed.length} filas de entrenamiento importadas.${bad ? ` ${bad} filas sin date o player_id se omitieron.` : ""}`);
  };

  const importEvents = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const text = await readFile(e);
    if (text === null || !matchId) return;
    const rows = parseCsv(text);
    const valid = rows.filter((r) => num(r.t_video) !== null && (EVENT_TYPES as readonly string[]).includes(r.type));
    const parsed: MatchEvent[] = valid.map((r) => ({
      event_id: uid("e"),
      match_id: matchId,
      t_video: num(r.t_video) as number,
      period: r.period === "2" ? 2 : 1,
      type: r.type as EventType,
      team: (["own", "opp", "ref", "unk"].includes(r.team) ? r.team : "unk") as Team,
      player_id: r.player_id || null,
      x: num(r.x),
      y: num(r.y),
      outcome: r.outcome || null,
      note: r.note || null,
    }));
    mutate((s) => ({ ...s, events: [...s.events, ...parsed] }));
    setMsg(`${parsed.length} eventos importados. ${rows.length - valid.length} filas omitidas (sin t_video o con type desconocido).`);
  };

  const importAll = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const text = await readFile(e);
    if (text === null) return;
    try {
      const data = JSON.parse(text) as Partial<State>;
      if (!Array.isArray(data.matches) || !Array.isArray(data.events)) throw new Error("formato");
      mutate(() => ({ ...EMPTY, ...data }) as State);
      setMsg("Respaldo restaurado. Reemplazó todo lo que había en este navegador.");
    } catch {
      setMsg("Ese archivo no es un respaldo válido de esta app.");
    }
  };

  return (
    <>
      <PageHeader
        title="Datos"
        subtitle="Todo se guarda en este navegador. Para pasar el trabajo a otra computadora o no perderlo, exporta un respaldo."
      />
      {msg && <div className="mb-4 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800">{msg}</div>}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="En este navegador">
          <ul className="text-sm text-slate-700">
            <li>{state.matches.length} partidos</li>
            <li>{state.events.length} eventos</li>
            <li>{state.plays.length} jugadas</li>
            <li>{state.sessions.length} filas de entrenamiento</li>
          </ul>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className={btnPrimary} onClick={() => downloadText("sportsan_respaldo.json", JSON.stringify(state, null, 1), "application/json")}>
              Exportar respaldo (JSON)
            </button>
            <label className={`${btn} cursor-pointer`}>
              Restaurar respaldo
              <input type="file" accept=".json" className="hidden" onChange={importAll} />
            </label>
          </div>
          <div className="mt-3 text-xs">
            {confirmClear ? (
              <span className="text-slate-700">
                ¿Borrar TODO lo de este navegador?{" "}
                <button
                  type="button"
                  className="font-medium text-red-700 underline"
                  onClick={() => {
                    mutate(() => EMPTY);
                    setConfirmClear(false);
                    setMsg("Se borró todo.");
                  }}
                >
                  Sí, borrar todo
                </button>{" "}
                <button type="button" className="underline" onClick={() => setConfirmClear(false)}>
                  cancelar
                </button>
              </span>
            ) : (
              <button type="button" className="text-slate-500 underline" onClick={() => setConfirmClear(true)}>
                Borrar todo
              </button>
            )}
          </div>
        </Card>

        <Card title="Datos de ejemplo">
          <p className="text-sm text-slate-600">
            Datos sintéticos para ver cómo se llena cada pantalla. Van marcados como «Datos de ejemplo» y no describen a ningún equipo real.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className={btn} onClick={loadDemo}>
              Cargar datos de ejemplo
            </button>
            <button type="button" className={btn} onClick={removeDemo}>
              Quitar datos de ejemplo
            </button>
          </div>
        </Card>

        <Card title="Entrenamientos (sensores) · CSV">
          <p className="text-sm text-slate-600">Una fila por jugadora y sesión. Obligatorias:</p>
          <pre className="mt-2 overflow-x-auto rounded bg-slate-100 p-2 text-xs text-slate-800">date,session_id,player_id,total_distance_m,hsr_distance_m,sprints,max_speed_kmh,hr_avg{"\n"}2026-10-01,s1,J07,5230,410,12,26.4,152</pre>
          <p className="mt-2 text-xs text-slate-600">
            <code>date</code> (AAAA-MM-DD) y <code>player_id</code> son obligatorias. Cualquier otra columna numérica se toma como métrica, así
            que sirve con lo que exporte tu sensor. Las celdas vacías se quedan vacías (no se rellenan).
          </p>
          <label className={`${btn} mt-3 inline-block cursor-pointer`}>
            Subir CSV de entrenamientos
            <input type="file" accept=".csv,text/csv" className="hidden" onChange={importSessions} />
          </label>
        </Card>

        <Card title="Eventos de un partido · CSV">
          <p className="text-sm text-slate-600">Mismo formato que el contrato de datos del proyecto:</p>
          <pre className="mt-2 overflow-x-auto rounded bg-slate-100 p-2 text-xs text-slate-800">{EVENT_COLUMNS.join(",")}</pre>
          <p className="mt-2 text-xs text-slate-600">
            <code>t_video</code> en segundos del video original; <code>x</code>, <code>y</code> en metros (105 × 68); <code>type</code>:{" "}
            {EVENT_TYPES.join(", ")}; <code>team</code>: own (equipo analizado) u opp.
          </p>
          {state.matches.length === 0 ? (
            <p className="mt-3 text-xs text-slate-500">Crea primero un partido para importar o exportar sus eventos.</p>
          ) : (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <select className={input} value={matchId} aria-label="Partido" onChange={(e) => setEventsMatch(e.target.value)}>
                {state.matches.map((m) => (
                  <option key={m.match_id} value={m.match_id}>
                    {m.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={btn}
                onClick={() =>
                  downloadText(
                    `events_${matchId}.csv`,
                    toCsv(state.events.filter((e) => e.match_id === matchId) as unknown as Record<string, unknown>[], EVENT_COLUMNS),
                    "text/csv",
                  )
                }
              >
                Exportar CSV
              </button>
              <label className={`${btn} cursor-pointer`}>
                Importar CSV
                <input type="file" accept=".csv,text/csv" className="hidden" onChange={importEvents} />
              </label>
            </div>
          )}
        </Card>

        <Card title="Tracking automático (posiciones)" className="lg:col-span-2">
          <p className="text-sm text-slate-600">
            Todavía no se carga aquí. El pipeline de Python (<code>src/sportsan/tracking</code>) produce <code>tracking_*.parquet</code> y{" "}
            <code>ball_*.parquet</code>; cuando la calidad sea suficiente, se exportarán por jugada como keyframes para que la animación de
            cancha use posiciones medidas en vez de colocadas a mano. El formato de keyframes ya es el mismo.
          </p>
        </Card>
      </div>
    </>
  );
}

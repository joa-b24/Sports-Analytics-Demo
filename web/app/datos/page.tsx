"use client";

import { DownloadSimple, Info, Sparkle, Trash, UploadSimple } from "@phosphor-icons/react";
import { useState } from "react";
import { Locked } from "@/components/Locked";
import { CountUp, Reveal } from "@/components/motion";
import { Card, PageHeader, Section, btn, btnPrimary, input } from "@/components/Shell";
import { buildDemo } from "@/lib/demo";
import { downloadText, parseCsv, toCsv } from "@/lib/format";
import { isSensitiveColumn } from "@/lib/load";
import { EMPTY, mutate, uid, useStore } from "@/lib/store";
import { DEFAULT_VIDEO, videoOf } from "@/lib/videos";
import { cleanEnd } from "@/lib/tagging";
import { EVENT_TYPES, type EventType, type MatchEvent, type SessionRow, type State, type Team } from "@/lib/types";

const EVENT_COLUMNS = ["event_id", "match_id", "video_id", "t_video", "period", "type", "team", "player_id", "x", "y", "outcome", "detail", "note", "x_end", "y_end", "goal_y", "goal_z"];
const SESSION_KEYS = ["date", "session_id", "player_id"];

// Empty or non-numeric cells become null (the contract's NaN): never filled in.
const num = (v: string | undefined): number | null => {
  if (v === undefined || v.trim() === "") return null;
  const n = Number(v.replace(",", "."));
  return Number.isFinite(n) ? n : null;
};

type DropProps = { accept: string; label: string; hint: string; onText: (text: string) => void };

// File picker that also takes a dropped file. The file is read in the browser; nothing is uploaded.
function DropZone({ accept, label, hint, onText }: DropProps) {
  const [over, setOver] = useState(false);
  const take = async (f?: File) => {
    if (f) onText(await f.text());
  };
  return (
    <label
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        void take(e.dataTransfer.files[0]);
      }}
      className={`group relative flex cursor-pointer flex-col items-center has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent-400 gap-1.5 rounded-2xl border border-dashed px-4 py-6 text-center transition-[border-color,background-color] duration-200 ${
        over ? "border-accent bg-accent/15" : "border-line-strong hover:border-accent-400 hover:bg-accent/5"
      }`}
    >
      <UploadSimple size={24} className="text-accent-300 transition-transform duration-300 group-hover:-translate-y-0.5" />
      <span className="text-sm font-medium text-ink">{label}</span>
      <span className="text-xs text-faint">{hint}</span>
      <input
        type="file"
        accept={accept}
        className="sr-only"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          void take(f);
        }}
      />
    </label>
  );
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
      segments: [...s.segments.filter((g) => !g.mark_id.startsWith("demo_")), ...demo.segments],
    }));
    setMsg(
      `Datos de ejemplo cargados: 1 partido de rival con ${demo.events.length} eventos y sus tramos, 1 jugada animada y ${
        new Set(demo.sessions.map((x) => x.date)).size
      } sesiones de entrenamiento con cuestionario.`,
    );
  };
  const removeDemo = () => {
    mutate((s) => ({
      ...s,
      matches: s.matches.filter((m) => !m.is_demo),
      events: s.events.filter((e) => !e.event_id.startsWith("demo_")),
      plays: s.plays.filter((p) => !p.play_id.startsWith("demo_")),
      sessions: s.sessions.filter((x) => !x.is_demo),
      segments: s.segments.filter((g) => !g.mark_id.startsWith("demo_")),
    }));
    setMsg("Datos de ejemplo eliminados. Tus datos reales no se tocaron.");
  };

  const importSessions = (text: string) => {
    const rows = parseCsv(text);
    const bad = rows.filter((r) => !r.date || !r.player_id).length;
    const parsed: SessionRow[] = rows
      .filter((r) => r.date && r.player_id)
      .map((r) => ({
        date: r.date,
        session_id: r.session_id || r.date,
        player_id: r.player_id,
        metrics: Object.fromEntries(Object.keys(r).filter((k) => !SESSION_KEYS.includes(k) && !isSensitiveColumn(k)).map((k) => [k, num(r[k])])),
      }));
    if (parsed.length === 0) return setMsg("No pude leer ninguna fila. El CSV necesita al menos las columnas date y player_id.");
    mutate((s) => ({ ...s, sessions: [...s.sessions, ...parsed] }));
    const dropped = Object.keys(rows[0] ?? {}).filter(isSensitiveColumn);
    setMsg(
      `${parsed.length} filas de entrenamiento importadas.${bad ? ` ${bad} filas sin date o player_id se omitieron.` : ""}${
        dropped.length ? ` No se guardaron las columnas de salud (${dropped.join(", ")}): la app aún no tiene cuentas para protegerlas.` : ""
      }`,
    );
  };

  const importEvents = (text: string) => {
    if (!matchId) return;
    const rows = parseCsv(text);
    const valid = rows.filter((r) => num(r.t_video) !== null && (EVENT_TYPES as readonly string[]).includes(r.type));
    const parsed: MatchEvent[] = valid.map((r) => ({
      event_id: uid("e"),
      match_id: matchId,
      video_id: r.video_id?.trim() || DEFAULT_VIDEO,
      t_video: num(r.t_video) as number,
      period: r.period === "2" ? 2 : 1,
      type: r.type as EventType,
      team: (["own", "opp", "ref", "unk"].includes(r.team) ? r.team : "unk") as Team,
      player_id: r.player_id || null,
      x: num(r.x),
      y: num(r.y),
      outcome: r.outcome || null,
      detail: r.detail || null,
      note: r.note || null,
      ...cleanEnd(r.type as EventType, { x_end: num(r.x_end), y_end: num(r.y_end), goal_y: num(r.goal_y), goal_z: num(r.goal_z) }),
    }));
    mutate((s) => ({ ...s, events: [...s.events, ...parsed] }));
    setMsg(`${parsed.length} eventos importados. ${rows.length - valid.length} filas omitidas (sin t_video o con type desconocido).`);
  };

  const importAll = (text: string) => {
    try {
      const data = JSON.parse(text) as Partial<State>;
      if (!Array.isArray(data.matches) || !Array.isArray(data.events)) throw new Error("formato");
      mutate(() => ({ ...EMPTY, ...data }) as State);
      setMsg("Respaldo restaurado. Reemplazó todo lo que había en este navegador.");
    } catch {
      setMsg("Ese archivo no es un respaldo válido de esta app.");
    }
  };

  const counts: [string, number][] = [
    ["partidos", state.matches.length],
    ["eventos", state.events.length],
    ["jugadas", state.plays.length],
    ["filas de sensores", state.sessions.length],
    ["cuadros calibrados", state.anchors.length],
  ];

  return (
    <>
      <PageHeader
        eyebrow="Carga de datos"
        title="Nuevos datos"
        subtitle="Todo se guarda en este navegador. Para pasar el trabajo a otra computadora o no perderlo, exporta un respaldo."
      >
        <button type="button" className={btnPrimary} onClick={() => downloadText("sportsan_respaldo.json", JSON.stringify(state, null, 1), "application/json")}>
          <DownloadSimple size={15} />
          Exportar respaldo
        </button>
      </PageHeader>

      {msg && (
        <div
          role="status"
          key={msg}
          className="enter mb-6 flex items-start gap-2.5 rounded-2xl bg-accent-900/70 px-4 py-3 text-sm text-accent-100 shadow-[inset_0_0_0_1px_rgba(74,114,255,.5)]"
        >
          <Info size={16} className="mt-0.5 shrink-0 text-accent-300" />
          {msg}
        </div>
      )}

      <Reveal className="mb-10 flex flex-wrap gap-x-10 gap-y-5">
        {counts.map(([k, v], n) => (
          <div key={k} className={n === 0 ? "" : "border-l border-line-soft pl-4"}>
            <div className={`num ${n === 0 ? "text-6xl text-ink" : "text-5xl text-ink-2"}`}>
              <CountUp value={v} />
            </div>
            <div className="mt-2 text-xs text-muted">{k}</div>
          </div>
        ))}
      </Reveal>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Entrenamientos · CSV de sensores" note="una fila por jugadora y sesión">
          <DropZone
            accept=".csv,text/csv"
            label="Arrastra aquí el CSV de entrenamientos"
            hint="o haz clic para elegirlo · se lee en tu navegador"
            onText={importSessions}
          />
          <pre className="tc mt-4 overflow-x-auto rounded-xl bg-bg/70 p-3 text-[11px] text-ink-2">date,session_id,player_id,total_distance_m,hsr_distance_m,sprints,max_speed_kmh,hr_avg{"\n"}2026-10-01,s1,J07,5230,410,12,26.4,152</pre>
          <p className="mt-3 text-xs text-pretty text-muted">
            <code>date</code> (AAAA-MM-DD) y <code>player_id</code> son obligatorias. Cualquier otra columna numérica se toma como métrica, así
            que sirve con lo que exporte tu sensor. Las celdas vacías se quedan vacías (no se rellenan). Con <code>rpe</code> (1 a 10) y{" "}
            <code>duration_min</code> se calcula la carga de la sesión; <code>sleep_q</code>, <code>stress</code>, <code>fatigue</code>,{" "}
            <code>soreness</code> (1 a 7) y <code>energy</code> (1 a 10) son el cuestionario previo. Las columnas de enfermedad, periodo
            menstrual, ánimo o molestias se descartan al importar.
          </p>
        </Card>

        <Card title="Eventos de un partido · CSV" note="formato del contrato de datos" delay={90}>
          {state.matches.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-line px-4 py-6 text-center text-sm text-muted">
              Crea primero un partido para importar o exportar sus eventos.
            </p>
          ) : (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <select className={`${input} min-w-0 flex-1`} value={matchId} aria-label="Partido" onChange={(e) => setEventsMatch(e.target.value)}>
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
                      toCsv(
                        state.events.filter((e) => e.match_id === matchId).map((e) => ({ ...e, video_id: videoOf(e) })) as unknown as Record<string, unknown>[],
                        EVENT_COLUMNS,
                      ),
                      "text/csv",
                    )
                  }
                >
                  <DownloadSimple size={15} />
                  Exportar CSV
                </button>
              </div>
              <DropZone accept=".csv,text/csv" label="Arrastra aquí el CSV de eventos" hint="se añaden al partido elegido arriba" onText={importEvents} />
            </>
          )}
          <pre className="tc mt-4 overflow-x-auto rounded-xl bg-bg/70 p-3 text-[11px] text-ink-2">{EVENT_COLUMNS.join(",")}</pre>
          <p className="mt-3 text-xs text-pretty text-muted">
            <code>video_id</code>: <code>v1</code> salvo que el partido tenga varios videos; <code>t_video</code> en segundos de ese video; <code>x</code>, <code>y</code> en metros (105 × 68); <code>type</code>:{" "}
            {EVENT_TYPES.join(", ")}; <code>team</code>: own (equipo analizado) u opp.
          </p>
        </Card>

        <Card title="Respaldo completo" note="JSON con todo lo de este navegador">
          <DropZone
            accept=".json"
            label="Arrastra aquí un respaldo para restaurarlo"
            hint="reemplaza todo lo que hay en este navegador"
            onText={importAll}
          />
          <div className="mt-4 text-xs">
            {confirmClear ? (
              <span className="text-ink-2">
                ¿Borrar TODO lo de este navegador?{" "}
                <button
                  type="button"
                  className="font-medium text-danger underline underline-offset-2"
                  onClick={() => {
                    mutate(() => EMPTY);
                    setConfirmClear(false);
                    setMsg("Se borró todo.");
                  }}
                >
                  Sí, borrar todo
                </button>{" "}
                <button type="button" className="link" onClick={() => setConfirmClear(false)}>
                  cancelar
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="inline-flex items-center gap-1.5 text-faint transition-colors hover:text-danger"
                onClick={() => setConfirmClear(true)}
              >
                <Trash size={13} />
                Borrar todo
              </button>
            )}
          </div>
        </Card>

        <Card title="Datos de ejemplo" delay={90}>
          <p className="text-sm text-pretty text-muted">
            Datos sintéticos para ver cómo se llena cada pantalla. Van marcados como «Datos de ejemplo» y no describen a ningún equipo real.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" className={btnPrimary} onClick={loadDemo}>
              <Sparkle size={15} />
              Cargar datos de ejemplo
            </button>
            <button type="button" className={btn} onClick={removeDemo}>
              Quitar datos de ejemplo
            </button>
          </div>
        </Card>
      </div>

      <Section title="En preparación" note="de la propuesta de diseño · todavía no funcionan" className="mt-12">
        <div className="grid gap-4 lg:grid-cols-3">
          <Locked
            reason="dev"
            title="Subir video y enlazar fuentes"
            why="La propuesta permite subir MP4/MOV y enlazar Veo, Drive o una API. Hoy el video no se sube: se abre el archivo local o el enlace de YouTube dentro de cada partido."
            need="almacenamiento y base de datos (fase 2 de la arquitectura), solo con servicios gratuitos."
          />
          <Locked
            reason="tracking"
            delay={80}
            title="Tracking automático (posiciones)"
            why={
              <>
                El pipeline de Python produce <code>tracking_*.parquet</code> y <code>ball_*.parquet</code>, pero todavía no se cargan aquí: la
                calidad no es suficiente.
              </>
            }
            need="terminar los pasos A3 y A4; se exportarán por jugada como keyframes, con el formato que ya usa la animación."
          />
          <Locked
            reason="dev"
            delay={160}
            title="Historial de cargas y archivos GPS (FIT, GPX)"
            why="Lista de archivos subidos con su estado de procesamiento, y lectura directa de FIT/GPX. Por ahora solo se lee CSV y no se guarda el archivo, solo sus filas."
          />
        </div>
      </Section>
    </>
  );
}

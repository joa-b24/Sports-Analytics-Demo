"use client";

import { useMemo, useState } from "react";
import { LockedRow } from "@/components/Locked";
import { PanelTitle } from "@/components/studio/Studio";
import { useFixedParts } from "@/lib/fixed";
import { fmtT } from "@/lib/format";
import { missingReason, playMetrics, playPlayers, type Edge, type PlayMetrics, type ShapeNow } from "@/lib/playMetrics";
import { useStore } from "@/lib/store";
import type { Match } from "@/lib/types";

const num = (v: number, digits = 1, unit = "") => (Number.isFinite(v) ? `${v.toFixed(digits)}${unit}` : "sin dato");
const pct = (v: number) => `${Math.round(v * 100)} %`;

function Row({ label, value, note }: { label: string; value: string; note?: string }) {
  const missing = value === "sin dato";
  return (
    <div className="flex items-baseline gap-2 py-0.5">
      <dt className="text-faint">{label}</dt>
      <dd className={`num m-0 ml-auto text-right ${missing ? "text-faint" : "text-ink"}`}>
        {value}
        {note && <span className="ml-1.5 text-[11px] font-normal text-faint">{note}</span>}
      </dd>
    </div>
  );
}

const edgeText = (e: Edge | null) => (e ? `${e.behind} detrás · ${e.ahead} delante (de ${e.seen} en cuadro)` : "sin dato");
const shapeText = (s: ShapeNow | null) => (s ? `ancho ${s.width_m.toFixed(0)} · largo ${s.length_m.toFixed(0)} · línea ${s.line_height_m.toFixed(0)} · bloque ${s.block_height_m.toFixed(0)} m` : "sin dato");

// The metrics of the stretch of a clip (or play) from the corrected tracking, as a panel or a compact card over the video.
export function usePlayMetrics(match: Match, videoId: string, t0: number, t1: number, players: string[]) {
  const fixed = useFixedParts(match.folder, [videoId]);
  const { events } = useStore();
  const evs = useMemo(() => events.filter((e) => e.match_id === match.match_id), [events, match.match_id]);
  const roster = useMemo(() => playPlayers(fixed?.parts.map((p) => ({ file: p.file, ownRight: p.ownRight })) ?? []), [fixed]);
  const metrics = useMemo<PlayMetrics | null>(
    () => (fixed ? playMetrics({ parts: fixed.parts.map((p) => ({ file: p.file, ownRight: p.ownRight })), videoId, t0, t1, events: evs, players }) : null),
    [fixed, videoId, t0, t1, evs, players],
  );
  return { metrics, roster, loading: !!match.folder && !fixed, hasFolder: !!match.folder };
}

export function PlayMetricsCard({ match, videoId, t0, t1 }: { match: Match; videoId: string; t0: number; t1: number }) {
  const { metrics } = usePlayMetrics(match, videoId, t0, t1, []);
  if (!metrics) return null;
  const m = metrics;
  return (
    <div className="pointer-events-none absolute top-2 left-2 z-10 w-56 rounded-lg bg-bg/80 px-3 py-2 text-[11px] backdrop-blur">
      <dl className="m-0">
        <Row label="Duración" value={num(m.duration_s, 1, " s")} />
        <Row label="Balón recorrió" value={num(m.ball.distance_m, 0, " m")} />
        <Row label="Posesión" value={m.possession.coverage > 0 ? `${num(m.possession.own_s, 1, " s")} · ${num(m.possession.opp_s, 1, " s")}` : "sin dato"} note="propio · rival" />
        <Row label="Pases (tracking)" value={Number.isFinite(m.passes.own) ? `${m.passes.own} · ${m.passes.opp}` : "sin dato"} note="propio · rival" />
      </dl>
    </div>
  );
}

export function PlayMetricsPanel({ match, videoId, t0, t1 }: { match: Match; videoId: string; t0: number; t1: number }) {
  const [picked, setPicked] = useState<string[]>([]);
  const { metrics: m, roster, loading, hasFolder } = usePlayMetrics(match, videoId, t0, t1, picked);
  if (!hasFolder) return <LockedRow reason="data" title="Métricas de la jugada" why="El partido no tiene carpeta: las métricas se leen del tracking corregido de la carpeta." />;
  if (loading || !m) return <p className="text-xs text-faint">Leyendo el tracking de la carpeta…</p>;
  const toggle = (n: string) => setPicked((p) => (p.includes(n) ? p.filter((x) => x !== n) : p.length >= 4 ? p : [...p, n]));
  const why = (w: Parameters<typeof missingReason>[1]) => missingReason(m, w);
  const ballWhy = why("ball");
  return (
    <div className="space-y-4 text-xs">
      {!m.tracked && <LockedRow reason="tracking" title="Esta jugada no cae en una parte con tracking" why="Sin posiciones no se calcula nada de lo de abajo; solo la duración. Procesa y corrige su parte en Tracking." />}
      <div>
        <PanelTitle right={<span className="tc text-faint">{fmtT(t0)}–{fmtT(t1)}</span>}>Tramo</PanelTitle>
        <dl className="m-0">
          <Row label="Duración" value={num(m.duration_s, 1, " s")} />
          <Row label="Balón medido en" value={m.tracked ? pct(m.ball.coverage) : "sin dato"} note="del tramo" />
          <Row label="Distancia del balón" value={num(m.ball.distance_m, 0, " m")} note={Number.isFinite(m.ball.distance_m) ? "mínimo, en línea recta" : undefined} />
          <Row label="Velocidad media / máx." value={Number.isFinite(m.ball.mean_ms) ? `${(m.ball.mean_ms * 3.6).toFixed(0)} / ${(m.ball.max_ms * 3.6).toFixed(0)} km/h` : "sin dato"} />
        </dl>
        {m.tracked && ballWhy && <p className="mt-1 text-faint">{ballWhy}</p>}
        {m.ball.aerial > 0 && <p className="mt-1 text-faint">{m.ball.aerial} marcas del balón en el aire: la distancia es la de su proyección al suelo.</p>}
      </div>

      <div>
        <PanelTitle>Posesión del tramo</PanelTitle>
        {m.tracked && m.possession.coverage > 0 ? (
          <>
            <div className="flex h-2 overflow-hidden rounded-full bg-raised" role="img" aria-label={`Posesión: propio ${num(m.possession.own_s)} s, rival ${num(m.possession.opp_s)} s`}>
              <span style={{ width: `${(m.possession.own_s / m.duration_s) * 100}%`, background: "var(--color-own)" }} />
              <span style={{ width: `${(m.possession.unclear_s / m.duration_s) * 100}%`, background: "var(--color-line-strong)" }} />
              <span style={{ width: `${(m.possession.opp_s / m.duration_s) * 100}%`, background: "var(--color-opp)" }} />
            </div>
            <dl className="m-0 mt-1.5">
              <Row label={match.focus_team} value={num(m.possession.own_s, 1, " s")} />
              <Row label={match.other_team} value={num(m.possession.opp_s, 1, " s")} />
              <Row label="Sin posesión clara" value={num(m.possession.unclear_s, 1, " s")} note="disputado, libre o suelto" />
              <Row label="Balón no medido" value={num(m.possession.unmeasured_s, 1, " s")} />
            </dl>
            {m.possession.coverage < 0.7 && <p className="mt-1 text-warn">El balón se midió solo en {pct(m.possession.coverage)} del tramo: la posesión es parcial.</p>}
          </>
        ) : (
          <LockedRow reason={m.tracked ? "data" : "tracking"} title="Posesión" why={why("possession") || "Sin balón medido en el tramo."} />
        )}
      </div>

      <div>
        <PanelTitle>Pases</PanelTitle>
        <dl className="m-0">
          <Row label="Del tracking" value={Number.isFinite(m.passes.own) ? `${m.passes.own} propios · ${m.passes.opp} rival` : "sin dato"} note={m.passes.approx > 0 ? `${m.passes.approx} aprox.` : undefined} />
          <Row label="Pases clave marcados" value={`${m.key_passes.own} · ${m.key_passes.opp}`} note="eventos a mano" />
        </dl>
        <p className="mt-1 text-faint">Del tracking: lectura de toques del balón medido. Los marcados a mano son solo los pases clave etiquetados; no se suman.</p>
        {!Number.isFinite(m.passes.own) && m.tracked && <p className="mt-1 text-faint">{why("passes")}</p>}
      </div>

      <div>
        <PanelTitle>Detrás y delante del balón</PanelTitle>
        <dl className="m-0">
          <Row label={`${match.focus_team} · inicio`} value={edgeText(m.ball_side.start.own)} />
          <Row label={`${match.focus_team} · fin`} value={edgeText(m.ball_side.end.own)} />
          <Row label={`${match.other_team} · inicio`} value={edgeText(m.ball_side.start.opp)} />
          <Row label={`${match.other_team} · fin`} value={edgeText(m.ball_side.end.opp)} />
        </dl>
        {m.tracked && !m.ball_side.start.own && <p className="mt-1 text-faint">{why("edge")}</p>}
      </div>

      <div>
        <PanelTitle>Forma del equipo</PanelTitle>
        <dl className="m-0">
          <Row label={`${match.focus_team} · inicio`} value={shapeText(m.shape.start.own)} />
          <Row label={`${match.focus_team} · fin`} value={shapeText(m.shape.end.own)} />
          <Row label={`${match.other_team} · inicio`} value={shapeText(m.shape.start.opp)} />
          <Row label={`${match.other_team} · fin`} value={shapeText(m.shape.end.opp)} />
        </dl>
        {m.tracked && !m.shape.start.own && <p className="mt-1 text-faint">{why("shape")}</p>}
        <p className="mt-1 text-faint">Alturas en metros desde su propia portería; el equipo propio ataca hacia la derecha.</p>
      </div>

      <div>
        <PanelTitle right={<span className="text-faint">hasta 4</span>}>Por jugadora</PanelTitle>
        {roster.length === 0 ? (
          <p className="text-faint">No hay jugadoras con nombre en el tracking de este tramo.</p>
        ) : (
          <div className="mb-2 flex flex-wrap gap-1">
            {roster.map((p) => (
              <button
                key={p.name}
                type="button"
                aria-pressed={picked.includes(p.name)}
                onClick={() => toggle(p.name)}
                className={`rounded-md px-1.5 py-0.5 text-[11px] ${picked.includes(p.name) ? "bg-accent-900 text-accent-300 ring-1 ring-accent/60" : "bg-raised text-muted hover:text-ink"}`}
              >
                {p.name}
                <span className="ml-1 text-faint">{p.team === "own" ? "P" : "R"}</span>
              </button>
            ))}
          </div>
        )}
        {m.players.length > 0 && (
          <table className="w-full text-left">
            <thead>
              <tr className="text-faint">
                <th className="py-0.5 font-normal">Jugadora</th>
                <th className="py-0.5 text-right font-normal">m</th>
                <th className="py-0.5 text-right font-normal">máx km/h</th>
                <th className="py-0.5 text-right font-normal">HSR m</th>
                <th className="py-0.5 text-right font-normal">sprints</th>
                <th className="py-0.5 text-right font-normal" title="Parte del tiempo visto que viene de posiciones rellenadas por el suavizado">relleno</th>
              </tr>
            </thead>
            <tbody>
              {m.players.map((p) => (
                <tr key={p.name} className="text-ink">
                  <td className="py-0.5">{p.name}</td>
                  <td className="num py-0.5 text-right">{p.distance_m}</td>
                  <td className={`num py-0.5 text-right ${Number.isFinite(p.top_kmh) ? "" : "text-faint"}`}>{num(p.top_kmh, 1)}</td>
                  <td className="num py-0.5 text-right">{p.hsr_m}</td>
                  <td className="num py-0.5 text-right">{p.sprints}</td>
                  <td className="num py-0.5 text-right">{p.fill_time_pct} %</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {m.players_missing.length > 0 && <p className="mt-1 text-faint">Sin posiciones medidas en el tramo: {m.players_missing.join(", ")}.</p>}
        {m.players.length > 0 && <p className="mt-1 text-faint">Sin posiciones sostenidas fuera de cuadro (extrapoladas). «sin dato» en la velocidad: no hubo una ventana de un segundo continua. Un tramo corto da cifras cortas: no se comparan con las del partido.</p>}
      </div>
    </div>
  );
}

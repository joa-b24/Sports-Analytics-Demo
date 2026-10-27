"use client";

import { useMemo } from "react";
import { Plus, X } from "@phosphor-icons/react";
import { COLORS, Pitch } from "@/components/Pitch";
import { Card, input } from "@/components/Shell";
import { useFixedParts } from "@/lib/fixed";
import { MAX_COMPARE, NO_DATA, metricValue, playerRows, shownMetrics, type Metric, type PlayerRow } from "@/lib/players";
import { heatmap, type Oriented } from "@/lib/positions";
import type { Segment } from "@/lib/segments";
import { setPref, usePref, useStore } from "@/lib/store";
import { PITCH, type Match, type MatchEvent } from "@/lib/types";
import { fullWindows, matchVideos, type HalfWindows } from "@/lib/videos";

type Side = "own" | "opp";
// Each compared player keeps her colour while she stays picked (identity, never rank); the team is the small bar.
const SLOTS = ["var(--slot-1)", "var(--slot-2)", "var(--slot-3)", "var(--slot-4)"];
const GROUPS: Metric["group"][] = ["Ataque", "Con balón", "Defensa", "Físico"];
const fmt = (v: number) => (Number.isInteger(v) ? v.toLocaleString("es-MX") : v.toLocaleString("es-MX", { maximumFractionDigits: 1 }));

// Individual performance: up to MAX_COMPARE players of either team, figure by figure, with where each one played.
// Events count only when tagged with her name; the tracking needs her name in the correction table.
export function PlayersCompare({
  match,
  events,
  videoIds,
  segmentsByVideo,
  periodNote = false,
}: {
  match: Match;
  events: MatchEvent[];
  videoIds: string[];
  segmentsByVideo: Record<string, Segment[]>;
  periodNote?: boolean;
}) {
  const state = useStore();
  const fixed = useFixedParts(match.folder, videoIds);
  const parts = useMemo(() => fixed?.parts ?? [], [fixed]);
  // Which half each video is (a half can come in several videos); absent = first video 1, others 2.
  const videoPeriods = useMemo(() => matchVideos(match).map((v, i) => ({ video_id: v.video_id, period: v.period ?? (i === 0 ? 1 : 2) })), [match]);
  const videoHalves = useMemo(() => {
    const out: Record<string, HalfWindows> = {};
    for (const v of matchVideos(match)) {
      const w = fullWindows(v);
      if (w) out[v.video_id] = w;
    }
    return out;
  }, [match]);
  const rows = useMemo(() => playerRows({ events, parts, playByVideo: segmentsByVideo, videoPeriods, videoHalves }), [events, parts, segmentsByVideo, videoPeriods, videoHalves]);
  const prefKey = `players:${match.match_id}`;
  const saved = usePref(prefKey, "");
  const per10 = usePref("players:per10", "0") === "1";

  // Names to show: dorsal from our squad; a rival "R7" with the name given in the quick review, if any.
  const label = useMemo(() => {
    const number = new Map((state.roster ?? []).map((r) => [r.player_id, r.number]));
    const rival = new Map<string, string>();
    for (const mid of new Set(parts.map((o) => o.file.match_id)))
      for (const r of state.rivals?.[mid] ?? []) rival.set(`R${r.number}`, r.name ? `${r.number} ${r.name}` : `Rival ${r.number}`);
    return (r: PlayerRow) => {
      if (r.team === "opp") return rival.get(r.id) ?? (/^R\d+$/.test(r.id) ? `Rival ${r.id.slice(1)}` : r.id);
      const n = number.get(r.id);
      return n != null ? `${n} · ${r.id}` : r.id;
    };
  }, [state.roster, state.rivals, parts]);

  // The picked ones, in their slot order; by default the two of ours with most to show.
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const picked: PlayerRow[] = (() => {
    // "-": all removed on purpose (empty would bring the default back).
    const keys = saved === "-" ? [] : saved ? saved.split("\n") : rows.filter((r) => r.team === "own").slice(0, 2).map((r) => r.key);
    return keys.map((k) => byKey.get(k)).filter((r): r is PlayerRow => !!r).slice(0, MAX_COMPARE);
  })();
  const setPicked = (list: PlayerRow[]) => setPref(prefKey, list.length ? list.map((r) => r.key).join("\n") : "-");
  const free = rows.filter((r) => !picked.some((p) => p.key === r.key));
  const team = (s: Side) => (s === "own" ? match.focus_team : match.other_team);

  if (rows.length === 0)
    return (
      <Card>
        <p className="text-sm text-muted">
          Ninguna jugadora tiene datos propios todavía: hacen falta eventos etiquetados con su nombre (columna «Jugadora» en Eventos) o su nombre en la
          mesa de corrección del tracking.
        </p>
        {match.folder && fixed === null && <p className="mt-2 text-xs text-faint">Leyendo el tracking de la carpeta del partido…</p>}
      </Card>
    );

  const metrics = shownMetrics(picked, per10);
  const anyMinutes = picked.some((r) => r.minutes);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        {picked.map((r, i) => (
          <span key={r.key} className="inline-flex items-center gap-2 rounded-full border border-line bg-surface py-1 pr-1 pl-3 text-sm text-ink">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: SLOTS[i] }} />
            {label(r)}
            <i className="h-3 w-1 rounded-full" style={{ background: r.team === "own" ? COLORS.own : COLORS.opp }} title={team(r.team)} />
            <button type="button" className="rounded-full p-1 text-faint hover:bg-raised hover:text-ink" aria-label={`Quitar a ${label(r)}`} onClick={() => setPicked(picked.filter((p) => p.key !== r.key))}>
              <X size={12} />
            </button>
          </span>
        ))}
        {picked.length < MAX_COMPARE && free.length > 0 && (
          <label className="inline-flex items-center gap-1.5 text-sm text-muted">
            <Plus size={14} />
            <select
              className={input}
              value=""
              aria-label="Añadir jugadora a la comparación"
              onChange={(e) => {
                const r = byKey.get(e.target.value);
                if (r) setPicked([...picked, r]);
              }}
            >
              <option value="">Añadir jugadora…</option>
              {(["own", "opp"] as const).map((s) => {
                const list = free.filter((r) => r.team === s);
                return list.length === 0 ? null : (
                  <optgroup key={s} label={team(s)}>
                    {list.map((r) => (
                      <option key={r.key} value={r.key}>
                        {label(r)}
                        {` · ${r.minutes_played != null ? `${Math.round(r.minutes_played)} min jugados` : `jugados: ${NO_DATA}`}`}
                        {r.events ? ` · ${r.events} eventos` : ""}
                      </option>
                    ))}
                  </optgroup>
                );
              })}
            </select>
          </label>
        )}
        <div className="seg ml-auto" role="group" aria-label="Cómo contar">
          <button type="button" className="seg-opt" aria-pressed={!per10} onClick={() => setPref("players:per10", "0")}>
            Totales
          </button>
          <button type="button" className="seg-opt" aria-pressed={per10} disabled={!anyMinutes} onClick={() => setPref("players:per10", "1")} title={anyMinutes ? "" : "Hace falta tracking con su nombre"}>
            Por 10 min vistos
          </button>
        </div>
      </div>

      {picked.length === 0 ? (
        <Card>
          <p className="text-sm text-muted">Elige hasta {MAX_COMPARE} jugadoras para compararlas, de los dos equipos.</p>
        </Card>
      ) : (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
          <Card title="Cifra por cifra" note={per10 ? "por 10 minutos en cuadro" : "totales del partido"}>
            {metrics.length === 0 ? (
              <p className="text-sm text-faint">Sin cifras para estas jugadoras.</p>
            ) : (
              <div className="grid gap-x-8 gap-y-5 lg:grid-cols-2">
                {GROUPS.map((g) => {
                  const ms = metrics.filter((m) => m.group === g);
                  if (ms.length === 0) return null;
                  return (
                    <div key={g}>
                      <div className="eyebrow mb-1.5">{g}</div>
                      <div className="divide-y divide-line-soft">
                        {ms.map((m) => (
                          <MetricRow key={m.key} m={m} rows={picked} per10={per10} />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <p className="mt-4 text-xs text-pretty text-faint">
              {picked.some((r) => r.fill_time_pct != null) &&
                `Relleno (posición extrapolada, no medida): ${picked
                  .filter((r) => r.fill_time_pct != null)
                  .map((r) => `${label(r)} ${fmt(r.fill_time_pct ?? 0)} % del tiempo visto, ${r.fill_dist_pct != null ? fmt(r.fill_dist_pct) : NO_DATA} % de la distancia`)
                  .join("; ")}. `}
              Minutos jugados: reloj del partido por tiempo, del inicio al fin del juego de cada video (sin las pausas internas), menos lo que la jugadora estuvo fuera (sin dato si es suplente y no hay cambio etiquetado). «Tiempo visto»: solo lo que salió en cuadro. Eventos: solo los etiquetados con su nombre{periodNote ? " (en el tiempo elegido arriba)" : ""}; si su equipo no tiene eventos con nombre, «—». Toques, pases y físico: del tracking corregido,
              solo el tiempo en cuadro{periodNote ? ", de todo el partido" : ""}; «—» es que no se midió, no que fuera 0.
            </p>
          </Card>
          <Card title="Dónde jugó" note="tiempo en cada zona, atacando hacia la derecha">
            {anyMinutes ? (
              <div className="grid grid-cols-2 gap-3 xl:grid-cols-1 2xl:grid-cols-2">
                {picked.map((r, i) => (
                  <PlayerHeat key={r.key} parts={parts} row={r} color={SLOTS[i]} name={label(r)} />
                ))}
              </div>
            ) : (
              <p className="text-sm text-faint">Ninguna de las elegidas tiene posiciones con su nombre en el tracking corregido.</p>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}

// One figure for the picked players: a bar each in her colour, scaled to the largest of them; the figure in ink.
function MetricRow({ m, rows, per10 }: { m: Metric; rows: PlayerRow[]; per10: boolean }) {
  const values = rows.map((r) => metricValue(r, m, per10));
  const max = Math.max(1e-9, ...values.map((v) => v ?? 0));
  const unit = m.unit && m.unit !== "%" ? ` ${m.unit}` : m.unit === "%" ? " %" : "";
  return (
    <div className="grid grid-cols-[minmax(0,9.5rem)_minmax(0,1fr)] items-center gap-3 py-1.5">
      <div className="text-xs leading-tight text-ink-2">
        {m.label}
        {m.lower && <span className="block text-[10px] text-faint">menos es mejor</span>}
      </div>
      <div className="space-y-1">
        {values.map((v, i) => (
          <div key={rows[i].key} className="flex items-center gap-2" title={`${m.label}: ${v === null ? "sin medir" : fmt(v) + unit}`}>
            <div className="h-1.5 min-w-0 flex-1">
              {v !== null && v > 0 && <div className="h-full rounded-r-[4px]" style={{ width: `${(100 * v) / max}%`, minWidth: 3, background: SLOTS[i] }} />}
            </div>
            <span className={`num w-16 shrink-0 text-right text-sm ${v === null ? "text-faint" : "text-ink"}`}>{v === null ? "—" : `${fmt(v)}${unit}`}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function PlayerHeat({ parts, row, color, name }: { parts: Oriented[]; row: PlayerRow; color: string; name: string }) {
  const h = useMemo(() => heatmap(parts, row.team, row.id, 21, 14), [parts, row.team, row.id]);
  const max = Math.max(...h.seconds, 1e-9);
  const cw = PITCH.length / h.nx;
  const ch = PITCH.width / h.ny;
  return (
    <figure className="min-w-0">
      <figcaption className="mb-1 flex items-center justify-between gap-2 text-xs">
        <span className="inline-flex min-w-0 items-center gap-1.5 text-ink-2">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} />
          <span className="truncate">{name}</span>
        </span>
        <span className="num text-faint" title="Tiempo visto en cuadro; los minutos jugados van en la cifra «Minutos jugados»">
          {row.minutes ? `${Math.round(row.minutes)} min visto` : "—"}
        </span>
      </figcaption>
      {h.total === 0 ? (
        <p className="text-xs text-faint">Sin posiciones con su nombre.</p>
      ) : (
        <Pitch showDirection={false}>
          {h.seconds.map((v, k) => {
            if (v / max <= 0.06) return null;
            // heatmap() draws our team attacking right; a rival is turned to attack right too.
            let i = k % h.nx;
            let j = Math.floor(k / h.nx);
            if (row.team === "opp") [i, j] = [h.nx - 1 - i, h.ny - 1 - j];
            return <rect key={k} x={i * cw} y={j * ch} width={cw} height={ch} fill={color} opacity={0.85 * (v / max)} />;
          })}
        </Pitch>
      )}
    </figure>
  );
}

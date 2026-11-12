"use client";

import { useMemo, useState } from "react";
import { Locked } from "@/components/Locked";
import { useMomentPlayer } from "@/components/match/MomentPlayer";
import { Card } from "@/components/Shell";
import { fmtT } from "@/lib/format";
import { ACCEL_MAX_MS2, HSR_KMH, SPRINT_KMH, SPRINT_MIN_S, playerSprints } from "@/lib/physical";
import { passItems, type PassItem, type PassTeam } from "@/lib/playgroundPasses";
import type { PlaygroundCtx } from "./context";

type Row =
  | { kind: "pass"; key: string; video_id: string; t: number; t_end: number; item: PassItem; role: "made" | "received" }
  | { kind: "sprint"; key: string; video_id: string; t: number; t_end: number; peak: number; valid: boolean; accel: number };

const KIND_LABEL = { all: "Todo", passes: "Pases", sprints: "Sprints" } as const;

// Laboratorio > Por jugadora: every pass (made and received) and every candidate sprint of ONE named player, each one a row
// that plays its moment in the video. To check the rules by eye: a pass she made or received, completed or cut; a sprint that
// counts and the ones the acceleration check refused (with the largest change of speed it saw). Read only: nothing is saved.
export function PlayerTab({ ctx }: { ctx: PlaygroundCtx }) {
  const { match, fixed, segmentsByVideo } = ctx;
  const parts = useMemo(() => fixed?.parts ?? [], [fixed]);
  const [team, setTeam] = useState<PassTeam>("own");
  const [picked, setPicked] = useState("");
  const [kind, setKind] = useState<keyof typeof KIND_LABEL>("all");
  const [selected, setSelected] = useState<string | null>(null);
  const { show, panel } = useMomentPlayer(match, { bare: true });

  // The named players of each team in the parts.
  const names = useMemo(() => {
    const out: Record<PassTeam, string[]> = { own: [], opp: [] };
    for (const t of ["own", "opp"] as const) {
      const set = new Set<string>();
      for (const o of parts) for (const p of o.file.people) if (p.team === t && p.player_id) set.add(p.player_id);
      out[t] = [...set].sort((a, b) => a.localeCompare(b, "es"));
    }
    return out;
  }, [parts]);
  const name = names[team].includes(picked) ? picked : (names[team][0] ?? "");

  const hasPlay = useMemo(() => Object.values(segmentsByVideo).some((segs) => segs.some((g) => g.tipo === "juego" && g.end !== null)), [segmentsByVideo]);
  const passes = useMemo(() => (name ? passItems(parts, segmentsByVideo).filter((p) => p.team === team && (p.from_name === name || p.to_name === name)) : []), [parts, segmentsByVideo, team, name]);
  const sprints = useMemo(() => (name ? playerSprints(parts, team, name, hasPlay ? segmentsByVideo : null) : []), [parts, team, name, segmentsByVideo, hasPlay]);

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    if (kind !== "sprints")
      for (const p of passes) {
        // A pass she made (her last touch to where it ended) or one she received.
        const made = p.from_name === name;
        out.push({ kind: "pass", key: `${p.id}|${made ? "m" : "r"}`, video_id: p.video_id, t: p.t_start, t_end: p.t_end, item: p, role: made ? "made" : "received" });
      }
    if (kind !== "passes")
      for (const s of sprints) out.push({ kind: "sprint", key: `s|${s.video_id}|${s.t_start.toFixed(2)}`, video_id: s.video_id, t: s.t_start, t_end: s.t_end, peak: s.peak_kmh, valid: s.valid, accel: s.max_accel_ms2 });
    return out.sort((a, b) => a.video_id.localeCompare(b.video_id) || a.t - b.t);
  }, [passes, sprints, kind, name]);

  if (!fixed) return <p className="text-sm text-faint">Leyendo las posiciones del partido…</p>;
  if (parts.length === 0 || names.own.length + names.opp.length === 0) {
    return (
      <Locked reason="tracking" title="Por jugadora" why={`${match.name} no tiene partes con jugadoras con nombre.`} need="Procesa el video en Tracking y ponle nombre a las jugadoras en la corrección: aquí se listan sus pases y sprints." />
    );
  }

  const made = passes.filter((p) => p.from_name === name);
  const received = passes.filter((p) => p.to_name === name);
  const done = made.filter((p) => p.completed).length;
  const validSprints = sprints.filter((s) => s.valid);
  const top = validSprints.length ? Math.max(...validSprints.map((s) => s.peak_kmh)) : null;
  const pick = (r: Row) => {
    setSelected(r.key);
    if (r.kind === "pass") show({ video_id: r.video_id, t: r.t, t_end: r.t_end, label: `${name}: pase ${r.item.completed ? "completado" : "cortado"} (${r.role === "made" ? "lo hizo" : "lo recibió"})` });
    else show({ video_id: r.video_id, t: Math.max(0, r.t - 1), t_end: r.t_end + 1, label: `${name}: sprint ${r.valid ? "válido" : "rechazado"} a ${r.peak.toFixed(1)} km/h` });
  };
  const other = (p: PassItem, role: "made" | "received") => {
    const n = role === "made" ? p.to_name : p.from_name;
    return role === "made" ? (p.completed ? (n ?? "sin nombre") : "cortado (rival)") : (n ?? "sin nombre");
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-2 text-xs text-muted">
        <label>
          Equipo
          <select className="input mt-0.5 block" value={team} onChange={(e) => (setTeam(e.target.value as PassTeam), setSelected(null))}>
            <option value="own">{match.focus_team}</option>
            <option value="opp">{match.other_team}</option>
          </select>
        </label>
        <label>
          Jugadora
          <select className="input mt-0.5 block" value={name} onChange={(e) => (setPicked(e.target.value), setSelected(null))}>
            {names[team].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
            {names[team].length === 0 && <option value="">Sin nombres en este equipo</option>}
          </select>
        </label>
        <div className="seg" role="group" aria-label="Qué listar">
          {(Object.keys(KIND_LABEL) as (keyof typeof KIND_LABEL)[]).map((k) => (
            <button key={k} type="button" className="seg-opt" aria-pressed={kind === k} onClick={() => setKind(k)}>
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
      </div>

      <p className="m-0 text-xs text-muted">
        <span className="text-ink">{name || "—"}</span>: hizo {made.length} pases ({done} completados, {made.length - done} cortados) y recibió {received.length}. Sprints:{" "}
        {validSprints.length} válidos{sprints.length > validSprints.length ? ` y ${sprints.length - validSprints.length} rechazados` : ""}
        {top !== null ? `, el más rápido a ${top.toFixed(1)} km/h` : ""}.{hasPlay ? " Solo dentro de los tramos de juego." : ""}
      </p>
      <p className="m-0 text-[11px] text-faint">
        Reglas vigentes: un sprint es una carrera de {SPRINT_KMH} km/h o más durante al menos {SPRINT_MIN_S} s, con una aceleración posible (hasta {ACCEL_MAX_MS2} m/s², contando 0,5 s de arranque); el trabajo a alta intensidad cuenta desde {HSR_KMH} km/h. Un pase cuenta desde su último toque hasta que lo recibe otra jugadora (completado) o el otro equipo (cortado).
      </p>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card title="Pases y sprints" note={`${rows.length} filas`} className="!p-3">
          {rows.length === 0 ? (
            <p className="text-sm text-faint">Nada que listar para esta jugadora con este filtro.</p>
          ) : (
            <ul className="m-0 max-h-[34rem] list-none overflow-auto p-0">
              {rows.map((r) => (
                <li key={r.key}>
                  <button
                    type="button"
                    onClick={() => pick(r)}
                    aria-pressed={selected === r.key}
                    title="Reproducir este momento"
                    className={`grid w-full grid-cols-[3.2rem_5.2rem_minmax(0,1fr)_auto] items-center gap-x-2 border-b border-line-soft px-1 py-1.5 text-left text-xs hover:bg-raised ${selected === r.key ? "bg-raised" : ""}`}
                  >
                    <span className="tc text-ink">{fmtT(r.t)}</span>
                    <span>
                      <span className={r.kind === "pass" ? "tag" : "tag tag-accent"}>{r.kind === "pass" ? (r.role === "made" ? "Pase hecho" : "Pase recibido") : "Sprint"}</span>
                    </span>
                    {r.kind === "pass" ? (
                      <>
                        <span className="truncate text-muted">
                          {r.role === "made" ? "→ " : "← "}
                          {other(r.item, r.role)}
                          {r.item.approx && <span className="ml-1 text-faint">aprox.</span>}
                        </span>
                        <span className={r.item.completed ? "text-ink" : "text-warn"}>{r.item.completed ? "Completado" : "Cortado"}</span>
                      </>
                    ) : (
                      <>
                        <span className="tc truncate text-muted">
                          {r.peak.toFixed(1)} km/h · {(r.t_end - r.t).toFixed(1)} s · acel. máx. {r.accel.toFixed(1)} m/s²
                        </span>
                        <span className={r.valid ? "text-ok" : "text-danger"}>{r.valid ? "Válido" : "Rechazado"}</span>
                      </>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Video" className="!p-3">
          {panel ?? <p className="text-sm text-faint">Elige una fila: aquí se reproduce el momento, con la opción de repetirlo en bucle.</p>}
        </Card>
      </div>
    </div>
  );
}

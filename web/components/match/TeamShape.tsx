"use client";

import { useEffect, useMemo, useState } from "react";
import { BinChart } from "@/components/charts";
import { Locked } from "@/components/Locked";
import { Card, input } from "@/components/Shell";
import { blockShape, MIN_VISIBLE, type ShapeMeasure } from "@/lib/blockShape";
import { useFixedParts } from "@/lib/fixed";
import { readLocal } from "@/lib/local";
import type { Segment } from "@/lib/segments";
import type { Match } from "@/lib/types";

// Shape of both teams over the match. It is calculated here from the positions of the correction table, with no step
// outside the app (lib/blockShape.ts, same definitions as sportsan.metrics.team_blocks). If there are no positions
// to read, the file that `python -m sportsan.metrics.report` writes (team_metrics_<video>.json) is used when it
// exists; with neither, the card says what is missing. Only the team of each person is needed, not who she is.

const MEASURES: Record<ShapeMeasure, string> = {
  line_height: "Altura de la línea (m desde su portería)",
  block_height: "Altura del bloque (m desde su portería)",
  width: "Ancho (m)",
  length: "Largo (m)",
};
interface Bin {
  bin: number;
  from_min: number;
  to_min: number;
  frames: number;
  valid_share: number;
  line_height: number | null;
  block_height: number | null;
  width: number | null;
  length: number | null;
}
interface TeamMetrics {
  video_id: string;
  own_attacks: string | null;
  min_visible: number;
  parts: number;
  source: string;
  teams: Record<"own" | "opp", { frames: number; valid_frames: number; bins: Record<string, Bin[]> }>;
}

const r1 = (v: number | null | undefined) => (v == null ? 0 : Math.round(v * 10) / 10);

export function TeamShapeCard({ match, videoIds, segmentsByVideo = {} }: { match: Match; videoIds: string[]; segmentsByVideo?: Record<string, Segment[]> }) {
  const [binMin, setBinMin] = useState<5 | 10>(5);
  const [measure, setMeasure] = useState<ShapeMeasure>("line_height");
  const folder = match.folder;
  const key = videoIds.join(",");
  const fixed = useFixedParts(folder, videoIds);
  const parts = useMemo(() => fixed?.parts ?? [], [fixed]);
  const shape = useMemo(() => (parts.length ? blockShape(parts, segmentsByVideo, videoIds, binMin) : null), [parts, segmentsByVideo, videoIds, binMin]);

  // Fallback: the file written by Python, only read when the app has no positions of its own to calculate from.
  const [files, setFiles] = useState<TeamMetrics[] | null>(null);
  const needFile = !!folder && !!fixed && parts.length === 0;
  useEffect(() => {
    if (!folder || !needFile) return;
    let live = true;
    void Promise.all(key.split(",").map((v) => readLocal(`matches/${folder}/tracking/team_metrics_${v}.json`))).then((texts) => {
      if (!live) return;
      setFiles(
        texts.flatMap((t) => {
          try {
            return t ? [JSON.parse(t) as TeamMetrics] : [];
          } catch {
            return [];
          }
        }),
      );
    });
    return () => {
      live = false;
    };
  }, [folder, key, needFile]);

  const header = (
    <div className="mb-4 flex flex-wrap items-center gap-3">
      <div className="seg">
        {([5, 10] as const).map((m) => (
          <button key={m} type="button" aria-pressed={binMin === m} onClick={() => setBinMin(m)} className="seg-opt">
            Cada {m} min
          </button>
        ))}
      </div>
      <select className={input} value={measure} aria-label="Medida" onChange={(e) => setMeasure(e.target.value as ShapeMeasure)}>
        {Object.entries(MEASURES).map(([k, v]) => (
          <option key={k} value={k}>
            {v}
          </option>
        ))}
      </select>
    </div>
  );

  if (shape && shape.bins.length > 0) {
    const unit = shape.clock === "play" ? "min de juego" : "min de video";
    const rows = shape.bins.map((b) => ({ label: `${b.from_min}–${b.to_min}`, a: r1(b.own[measure]), b: r1(b.opp[measure]) }));
    return (
      <Card title="Altura y anchura del bloque" note={`C4 · calculado en la app · ${unit}`}>
        {header}
        <BinChart key={`${binMin}-${measure}-${rows.length}`} bins={rows} aLabel={match.focus_team} bLabel={match.other_team} />
        <p className="mt-3 text-xs text-pretty text-faint">
          Mediana de cada tramo de {binMin} {unit}, con las jugadoras de campo que salen en cuadro (la portera se quita si va sola atrás). Un
          cuadro cuenta si se ven al menos {MIN_VISIBLE} de un equipo: para {match.focus_team} contaron {shape.valid.own} de {shape.frames.own}{" "}
          cuadros. Lo que no sale en cuadro no se mide, así que describe sobre todo la zona de la jugada. Un 0 es un tramo sin cuadros suficientes,
          no una altura medida.
          {shape.clock === "video" && " Sin tramos de juego marcados, los minutos son del video."} Siempre con {match.focus_team} atacando hacia la
          derecha; la altura se mide desde la portería de cada equipo. Aún no distingue quién tiene el balón.
        </p>
      </Card>
    );
  }

  if (files && files.length > 0) {
    const rows = files.flatMap((f) => {
      const own = f.teams.own.bins[String(binMin)] ?? [];
      const opp = f.teams.opp.bins[String(binMin)] ?? [];
      return own.map((b) => ({ label: `${files.length > 1 ? `${f.video_id} ` : ""}${b.from_min}–${b.to_min}`, a: r1(b[measure]), b: r1(opp.find((x) => x.bin === b.bin)?.[measure]) }));
    });
    const noHeights = files.some((f) => !f.own_attacks) && (measure === "line_height" || measure === "block_height");
    return (
      <Card title="Altura y anchura del bloque" note={`C4 · archivo ${files.map((f) => `${f.video_id}: ${f.parts} partes`).join(" · ")}`}>
        {header}
        {noHeights ? (
          <p className="text-sm text-warn">Este archivo no sabe hacia dónde ataca el equipo, así que no tiene alturas, solo ancho y largo.</p>
        ) : (
          <BinChart key={`${binMin}-${measure}-f`} bins={rows} aLabel={match.focus_team} bLabel={match.other_team} />
        )}
        <p className="mt-3 text-xs text-pretty text-faint">
          Leído del archivo de métricas del tracking de la carpeta del partido, porque la app no tiene posiciones para calcularlo. Un 0 es un tramo
          sin cuadros suficientes.
        </p>
      </Card>
    );
  }

  const why = !folder
    ? "Este partido no tiene carpeta (se pone en «editar datos»), así que no hay tracking que leer."
    : !fixed
      ? "Buscando las partes procesadas en la carpeta del partido…"
      : fixed.unoriented.length > 0
        ? `Hay ${fixed.unoriented.length} parte(s) con posiciones, pero no se sabe hacia dónde ataca cada equipo, y sin eso no hay alturas.`
        : parts.length > 0
          ? "Las partes procesadas no tienen cuadros con suficientes jugadoras a la vista en los tramos de juego."
          : "Todavía no hay partes procesadas de este partido.";
  return (
    <Locked
      reason="tracking"
      title="Altura y anchura del bloque"
      why={why}
      need={
        !folder
          ? "poner la carpeta del partido y procesar el tracking."
          : fixed && fixed.unoriented.length > 0
            ? "indicar hacia dónde ataca cada equipo en la vista Balón de la mesa de corrección."
            : "procesar el tracking del partido (pestaña Tracking); la app calcula la forma sola al leerlo."
      }
    />
  );
}

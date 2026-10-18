"use client";

import { useEffect, useState } from "react";
import { BinChart } from "@/components/charts";
import { Command } from "@/components/Command";
import { Card, input } from "@/components/Shell";
import { readLocal } from "@/lib/local";
import type { Match } from "@/lib/types";

// Shape of both teams over the match, from the tracking (sportsan.metrics.report writes team_metrics_<video>.json in
// the tracking folder of the match). Only the team of each person is needed, not who she is.

type Measure = "line_height" | "block_height" | "width" | "length";
const MEASURES: Record<Measure, string> = {
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

export function TeamShapeCard({ match, videoIds }: { match: Match; videoIds: string[] }) {
  const [files, setFiles] = useState<TeamMetrics[] | null>(null);
  const [binMin, setBinMin] = useState<5 | 10>(5);
  const [measure, setMeasure] = useState<Measure>("line_height");
  const folder = match.folder;
  const key = videoIds.join(",");
  useEffect(() => {
    if (!folder) return;
    let live = true;
    void Promise.all(key.split(",").map((v) => readLocal(`matches/${folder}/tracking/team_metrics_${v}.json`))).then((texts) => {
      if (!live) return;
      const parsed = texts.flatMap((t) => {
        try {
          return t ? [JSON.parse(t) as TeamMetrics] : [];
        } catch {
          return [];
        }
      });
      setFiles(parsed);
    });
    return () => {
      live = false;
    };
  }, [folder, key]);

  const command = `python -m sportsan.metrics.report --match ${folder ?? "<carpeta>"} --own-attacks right`;
  if (!folder || !files || files.length === 0) {
    return (
      <Card title="Altura y anchura del bloque" note="C4 · desde el tracking">
        <p className="text-sm text-pretty text-muted">
          {folder
            ? "Todavía no hay métricas de equipo para este partido. Después de procesar el tracking, en la terminal (desde la carpeta del repo):"
            : "Este partido no tiene carpeta: se pone en «editar datos». Después, con el tracking procesado:"}
        </p>
        <Command className="mt-2">{command}</Command>
        <p className="mt-2 text-[11px] text-faint">
          --own-attacks dice hacia dónde ataca el equipo analizado en ese video (right = hacia la derecha de la cancha de la calibración). Sin él no
          hay alturas, solo ancho y largo.
        </p>
      </Card>
    );
  }

  const label = (f: TeamMetrics, b: Bin) => `${files.length > 1 ? `${f.video_id} ` : ""}${b.from_min}–${b.to_min}`;
  const rows = files.flatMap((f) => {
    const own = f.teams.own.bins[String(binMin)] ?? [];
    const opp = f.teams.opp.bins[String(binMin)] ?? [];
    return own.map((b) => {
      const o = opp.find((x) => x.bin === b.bin);
      const r = (v: number | null | undefined) => (v == null ? 0 : Math.round(v * 10) / 10);
      return { label: label(f, b), a: r(b[measure]), b: r(o?.[measure]), share: Math.min(b.valid_share, o?.valid_share ?? 0) };
    });
  });
  const noHeights = files.some((f) => !f.own_attacks) && (measure === "line_height" || measure === "block_height");
  const valid = files.reduce((n, f) => n + f.teams.own.valid_frames, 0);
  const total = files.reduce((n, f) => n + f.teams.own.frames, 0);

  return (
    <Card title="Altura y anchura del bloque" note={`C4 · ${files.map((f) => `${f.video_id}: ${f.parts} partes`).join(" · ")} · ${files[0].source}`}>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="seg">
          {([5, 10] as const).map((m) => (
            <button key={m} type="button" aria-pressed={binMin === m} onClick={() => setBinMin(m)} className="seg-opt">
              Cada {m} min
            </button>
          ))}
        </div>
        <select className={input} value={measure} aria-label="Medida" onChange={(e) => setMeasure(e.target.value as Measure)}>
          {Object.entries(MEASURES).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </div>
      {noHeights ? (
        <p className="text-sm text-warn">Para las alturas hace falta saber hacia dónde ataca el equipo: vuelve a correr el comando con --own-attacks.</p>
      ) : (
        <BinChart key={`${binMin}-${measure}`} bins={rows.map(({ label: l, a, b }) => ({ label: l, a, b }))} aLabel={match.focus_team} bLabel={match.other_team} />
      )}
      <p className="mt-3 text-xs text-pretty text-faint">
        Mediana de cada tramo de minutos de juego, con las jugadoras de campo que salen en cuadro (la portera se quita si va sola atrás). Un cuadro
        cuenta si se ven al menos {files[0].min_visible} de un equipo: para {match.focus_team} contaron {valid} de {total} cuadros. Lo que no sale
        en cuadro no se mide, así que describe sobre todo la zona de la jugada. Un 0 es un tramo sin cuadros suficientes. Aún no distingue quién
        tiene el balón: cuando se cruce con los eventos, se podrá ver el bloque defendiendo.
      </p>
    </Card>
  );
}

"use client";

import { CheckCircle, XCircle } from "@phosphor-icons/react";
import { useState } from "react";
import { Pitch } from "@/components/Pitch";
import { Card } from "@/components/Shell";
import { fmtT } from "@/lib/format";
import { KIND_LABEL, NOTE_LABEL, TEAM_LABEL, SRC_LABEL, fmtTd, rowDuration, type Review, type Scene, type Verdict } from "@/lib/playgroundPossession";
import type { PossessionRow } from "@/lib/possession";

const DOT: Record<string, string> = { own: "var(--color-own)", opp: "var(--color-opp)", ref: "var(--color-warn)", unk: "var(--color-faint)" };
const TEAM_NAME: Record<string, string> = { own: "nuestro equipo", opp: "rival", ref: "árbitro", unk: "sin equipo" };

// The frame the table decided on: players by team, the ball, the box that decided (ring) and the line to the ball.
type Ends = { start: [number, number] | null; end: [number, number] | null };

export function SceneView({ scene, ends }: { scene: Scene; ends?: Ends }) {
  const o = scene.owner;
  const dot = o ? scene.dots.find((d) => d.id === o.id) : undefined;
  return (
    <Pitch showDirection={false}>
      {scene.view && <polygon points={scene.view.map(([x, y]) => `${x},${y}`).join(" ")} fill="none" stroke="var(--color-line-strong)" strokeWidth={0.3} strokeDasharray="1 1" />}
      {dot && scene.ball && <line x1={dot.x} y1={dot.y} x2={scene.ball[0]} y2={scene.ball[1]} stroke={o?.role === "blocker" ? "var(--color-danger)" : "var(--color-ok)"} strokeWidth={0.3} />}
      {scene.dots.map((d) => (
        <g key={d.id}>
          <circle cx={d.x} cy={d.y} r={1.1} fill={DOT[d.team] ?? DOT.unk} stroke="var(--color-bg)" strokeWidth={0.2} />
          {o?.id === d.id && (
            <circle cx={d.x} cy={d.y} r={2.2} fill="none" strokeWidth={0.45} stroke={o.role === "blocker" ? "var(--color-danger)" : "var(--color-ok)"} strokeDasharray={o.role === "blocker" ? "0.9 0.6" : undefined} />
          )}
          {(d.label || o?.id === d.id) && (
            <text x={d.x} y={d.y - 2.8} textAnchor="middle" fontSize={2.2} fill="var(--color-ink)">
              {d.label || `#${d.id}`}
            </text>
          )}
        </g>
      ))}
      {ends?.start && ends.end && <line x1={ends.start[0]} y1={ends.start[1]} x2={ends.end[0]} y2={ends.end[1]} stroke="var(--color-ball)" strokeWidth={0.25} strokeDasharray="0.8 0.8" />}
      {ends?.start && (
        <g>
          <circle cx={ends.start[0]} cy={ends.start[1]} r={1.5} fill="none" stroke="var(--color-ball)" strokeWidth={0.4} />
          <text x={ends.start[0]} y={ends.start[1] + 4} textAnchor="middle" fontSize={2.2} fill="var(--color-ink)">Inicio</text>
        </g>
      )}
      {ends?.end && (
        <g>
          <rect x={ends.end[0] - 1.3} y={ends.end[1] - 1.3} width={2.6} height={2.6} fill="none" stroke="var(--color-ball)" strokeWidth={0.4} />
          <text x={ends.end[0]} y={ends.end[1] + 4.4} textAnchor="middle" fontSize={2.2} fill="var(--color-ink)">Fin</text>
        </g>
      )}
      {scene.ball && <circle cx={scene.ball[0]} cy={scene.ball[1]} r={0.8} fill="var(--color-ball)" stroke="var(--color-bg)" strokeWidth={0.25} />}
    </Pitch>
  );
}

// Check of one interval: what the table decided (the frame, the box), the video at that moment and the analyst's verdict.
export function PossessionScene({
  row, scene, ends, review, onVerdict,
}: {
  row: PossessionRow | null;
  scene: Scene | null;
  ends: Ends | null;
  review: Review | null;
  onVerdict: (v: Verdict | null, note: string) => void;
}) {
  const [draft, setDraft] = useState<{ id: string; note: string } | null>(null);
  if (!row) {
    return (
      <Card title="Verificación" className="h-full overflow-auto">
        <p className="text-sm text-faint">Elige un intervalo de la tabla: aquí se ve la cancha en ese instante, la jugadora a la que la tabla le da el balón y el video.</p>
      </Card>
    );
  }
  const id = `${row.video_id}|${row.t_start}`;
  const note = draft?.id === id ? draft.note : (review?.note ?? "");
  const o = scene?.owner;
  return (
    <Card title="Verificación" className="h-full overflow-auto">
      <p className="tc mb-1 text-sm text-ink" aria-live="polite">
        {fmtTd(row.t_start)} – {fmtTd(row.t_end)} <span className="text-muted">({rowDuration(row).toFixed(1)} s)</span>
      </p>
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        <span className="text-ink">{TEAM_LABEL[row.team]}</span>
        <span>{KIND_LABEL[row.kind]}</span>
        <span>Balón: {SRC_LABEL[row.flags.ball_source]}</span>
        {row.flags.notes.length > 0 && <span className="text-faint">{row.flags.notes.map((n) => NOTE_LABEL[n] ?? n).join(", ")}</span>}
      </div>
      {scene ? (
        <>
          <SceneView scene={scene} ends={ends ?? undefined} />
          <p className="mt-1 text-xs text-muted">
            Balón al inicio: {ends?.start ? `${ends.start[0].toFixed(1)}, ${ends.start[1].toFixed(1)} m` : "sin medir"} · al final: {ends?.end ? `${ends.end[0].toFixed(1)}, ${ends.end[1].toFixed(1)} m` : "sin medir"}.
          </p>
          <p className="mt-1 text-xs text-muted" aria-live="polite">
            <span className="tc text-faint">Cuadro de {fmtT(scene.t)}. </span>
            {o
              ? o.role === "holder"
                ? `Dueña según la tabla: ${o.name ?? `caja #${o.id}`} (${TEAM_NAME[o.team] ?? o.team})${o.distance !== null ? `, a ${o.distance.toLocaleString("es-MX", { maximumFractionDigits: 1 })} m del balón` : ""}.`
                : `Caja bloqueante: ${o.name ?? `#${o.id}`} (${TEAM_NAME[o.team] ?? o.team})${o.distance !== null ? `, a ${o.distance.toLocaleString("es-MX", { maximumFractionDigits: 1 })} m del balón` : ""}. Nadie se lleva el balón.`
              : "La tabla no asigna una jugadora concreta a este intervalo."}
            {!scene.ball && " Sin balón medido en este cuadro."}
          </p>
        </>
      ) : (
        <p className="text-sm text-faint">Ninguna parte procesada tiene posiciones en este instante: no se puede dibujar la cancha.</p>
      )}
      <div className="mt-3 border-t border-line-soft pt-3">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={`btn ${review?.verdict === "correct" ? "btn-primary" : ""}`} aria-pressed={review?.verdict === "correct"} onClick={() => onVerdict(review?.verdict === "correct" ? null : "correct", note)}>
            <CheckCircle size={15} />
            Correcto
          </button>
          <button type="button" className={`btn ${review?.verdict === "incorrect" ? "btn-primary" : ""}`} aria-pressed={review?.verdict === "incorrect"} onClick={() => onVerdict(review?.verdict === "incorrect" ? null : "incorrect", note)}>
            <XCircle size={15} />
            Incorrecto
          </button>
          <input
            className="input min-w-40 flex-1"
            placeholder="Nota opcional"
            aria-label="Nota del intervalo"
            value={note}
            onChange={(e) => setDraft({ id, note: e.target.value })}
            onBlur={() => review && note !== review.note && onVerdict(review.verdict, note)}
          />
        </div>
        {!review && <p className="mt-1 text-xs text-faint">Sin revisar. La nota se guarda junto con el veredicto.</p>}
      </div>
    </Card>
  );
}

"use client";

import { CheckCircle, XCircle } from "@phosphor-icons/react";
import { useState } from "react";
import { Pitch } from "@/components/Pitch";
import { Card } from "@/components/Shell";
import type { DetectedEvent } from "@/lib/eventDetect";
import { CONF_LABEL, FLAG_LABEL, TEAM_LABEL, TYPE_LABEL, type EventReview, type EventScene, type EventVerdict } from "@/lib/eventReview";
import { fmtT } from "@/lib/format";
import { fmtTd } from "@/lib/playgroundPossession";

const DOT: Record<string, string> = { own: "var(--color-own)", opp: "var(--color-opp)", ref: "var(--color-warn)", unk: "var(--color-faint)" };

// The pitch at the moment of the detection: players by team, the ball, the point where the event is placed (ring) and, for
// a corner or a cross, the arrow to where the ball went.
export function EventSceneView({ ev, scene }: { ev: DetectedEvent; scene: EventScene }) {
  return (
    <Pitch showDirection={false}>
      {scene.view && <polygon points={scene.view.map(([x, y]) => `${x},${y}`).join(" ")} fill="none" stroke="var(--color-line-strong)" strokeWidth={0.3} strokeDasharray="1 1" />}
      {scene.dots.map((d) => (
        <g key={d.id}>
          <circle cx={d.x} cy={d.y} r={1.1} fill={DOT[d.team] ?? DOT.unk} stroke="var(--color-bg)" strokeWidth={0.2} />
          {d.label && (
            <text x={d.x} y={d.y - 2.2} textAnchor="middle" fontSize={2.2} fill="var(--color-ink)">
              {d.label}
            </text>
          )}
        </g>
      ))}
      {ev.x_end != null && ev.y_end != null && (
        <g>
          <line x1={ev.x} y1={ev.y} x2={ev.x_end} y2={ev.y_end} stroke="var(--color-ball)" strokeWidth={0.3} strokeDasharray="0.8 0.8" />
          <rect x={ev.x_end - 1.2} y={ev.y_end - 1.2} width={2.4} height={2.4} fill="none" stroke="var(--color-ball)" strokeWidth={0.4} />
        </g>
      )}
      <circle cx={ev.x} cy={ev.y} r={2.4} fill="none" stroke="var(--color-ok)" strokeWidth={0.5} />
      <circle cx={ev.x} cy={ev.y} r={0.4} fill="var(--color-ok)" />
      {scene.ball && <circle cx={scene.ball[0]} cy={scene.ball[1]} r={0.8} fill="var(--color-ball)" stroke="var(--color-bg)" strokeWidth={0.25} />}
    </Pitch>
  );
}

// Check of one detection: where the rule put it, the pitch at that moment and the analyst's verdict.
export function EventsScene({
  ev, scene, review, stale, onVerdict,
}: {
  ev: DetectedEvent | null;
  scene: EventScene | null;
  review: EventReview | null;
  stale: boolean;
  onVerdict: (v: EventVerdict | null, note: string) => void;
}) {
  const [draft, setDraft] = useState<{ id: string; note: string } | null>(null);
  if (!ev) {
    return (
      <Card title="Verificación" className="h-full">
        <p className="text-sm text-faint">Elige una detección de la lista: aquí se ve la cancha en ese instante, el punto donde la regla la puso y el video.</p>
      </Card>
    );
  }
  const note = draft?.id === ev.id ? draft.note : (review?.note ?? "");
  const verdict = stale ? null : (review?.verdict ?? null);
  return (
    <Card title="Verificación" className="h-full !p-3">
      <p className="tc text-sm text-ink" aria-live="polite">
        {TYPE_LABEL[ev.type]} · {fmtTd(ev.t_video)} <span className="text-muted">({fmtT(ev.t_video)})</span>
      </p>
      <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted">
        <span className="text-ink">{TEAM_LABEL[ev.team]}</span>
        <span>{ev.player ?? "jugadora sin nombre o no determinada"}</span>
        {ev.detail && <span>detalle: {ev.detail}</span>}
        <span>confianza {CONF_LABEL[ev.confidence].toLowerCase()}</span>
        <span className="text-faint">regla {ev.rule} · v{ev.rule_version}</span>
      </div>
      {ev.flags.length > 0 && <p className="mb-1 text-[11px] text-faint">{ev.flags.map((f) => FLAG_LABEL[f] ?? f).join(" · ")}</p>}
      {scene ? <EventSceneView ev={ev} scene={scene} /> : <p className="text-sm text-faint">Ninguna parte procesada tiene posiciones en este instante: no se puede dibujar la cancha.</p>}
      {scene && !scene.ball && <p className="mt-1 text-[11px] text-faint">Sin balón medido en este cuadro.</p>}
      {stale && <p className="mt-1 text-[11px] text-warn">Tenía una revisión de otra versión de la regla: ya no cuenta, revísala de nuevo.</p>}
      <div className="mt-2 border-t border-line-soft pt-2">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={`btn ${verdict === "correct" ? "btn-primary" : ""}`} aria-pressed={verdict === "correct"} onClick={() => onVerdict(verdict === "correct" ? null : "correct", note)}>
            <CheckCircle size={15} />
            Correcto
          </button>
          <button type="button" className={`btn ${verdict === "incorrect" ? "btn-primary" : ""}`} aria-pressed={verdict === "incorrect"} onClick={() => onVerdict(verdict === "incorrect" ? null : "incorrect", note)}>
            <XCircle size={15} />
            Incorrecto
          </button>
          <input
            className="input min-w-32 flex-1 !py-1.5 text-xs"
            placeholder="Nota (p. ej. era un fuera de lugar)"
            aria-label="Nota de la detección"
            value={note}
            onChange={(e) => setDraft({ id: ev.id, note: e.target.value })}
            onBlur={() => review && !stale && note !== review.note && onVerdict(review.verdict, note)}
          />
        </div>
        {!verdict && <p className="mt-1 text-[11px] text-faint">Sin revisar. La nota se guarda junto con el veredicto.</p>}
      </div>
    </Card>
  );
}

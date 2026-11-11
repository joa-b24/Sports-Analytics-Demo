"use client";

import { ArrowCounterClockwise } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { TechNumber, TechSwitch } from "@/components/match/TechField";
import { DETECTED_TYPES, type DetectedType } from "@/lib/eventDetect";
import { eventReviewPath, parseEventReview, type EventReviewFile } from "@/lib/eventReview";
import { readLocal } from "@/lib/local";
import { mutate } from "@/lib/store";
import { AUTO_EVENTS_LEGEND, TRACKING_DEFAULTS, TRACKING_FIELDS, TRACKING_GROUPS, clampTracking, resetTracking, reviewFigures, trackingChanged, trackingParamsOf, withTrackingParam } from "@/lib/techTracking";
import { autoEventsOf, withAutoEvent } from "@/lib/tech";
import { EVENT_LABELS, EVENT_TYPES, type Match } from "@/lib/types";
import { matchVideos } from "@/lib/videos";

const patchMatch = (id: string, f: (m: Match) => Match) => mutate((s) => ({ ...s, matches: s.matches.map((m) => (m.match_id === id ? f(m) : m)) }));

// Detalles técnicos, part 2 (lib/techTracking.ts): tracking tools by group, and the event types accepted as automatic.
export function TechTracking({ match }: { match: Match }) {
  const p = trackingParamsOf(match);
  const changed = trackingChanged(match);
  return (
    <div>
      {TRACKING_GROUPS.map((g) => (
        <section key={g.id} className="mb-5" aria-label={g.title}>
          <h3 className="eyebrow mb-1">{g.title}</h3>
          <p className="m-0 mb-1 text-xs text-faint">{g.help}</p>
          {TRACKING_FIELDS.filter((f) => f.group === g.id).map((f) => (
            <TechNumber
              key={f.key}
              label={f.label}
              help={f.help}
              unit={f.unit}
              value={p[f.key]}
              def={TRACKING_DEFAULTS[f.key]}
              min={f.min}
              max={f.max}
              step={f.step}
              clamp={(v, prev) => clampTracking(f, v, prev)}
              onChange={(v) => patchMatch(match.match_id, (m) => withTrackingParam(m, f.key, v))}
            />
          ))}
          {g.id === "fill" && (
            <TechSwitch
              label="Abstenerse si hay empate cercano"
              help="Con empate cercano entre dos jugadoras, el relleno no asigna."
              checked={p.fillRejectClose}
              def={TRACKING_DEFAULTS.fillRejectClose}
              onChange={(v) => patchMatch(match.match_id, (m) => withTrackingParam(m, "fillRejectClose", v))}
            />
          )}
          {g.id === "assist" && (
            <TechSwitch
              label="Aceptar las seguras al abrir la parte"
              help="Al abrir Anclas se aplican las uniones seguras en un solo paso, con aviso y botón Deshacer; quedan en «Aceptadas automáticamente»."
              checked={p.autoAcceptOn}
              def={TRACKING_DEFAULTS.autoAcceptOn}
              onChange={(v) => patchMatch(match.match_id, (m) => withTrackingParam(m, "autoAcceptOn", v))}
            />
          )}
        </section>
      ))}
      <div className="flex flex-wrap items-center gap-3 border-t border-line-soft pt-3 text-xs text-faint">
        <button type="button" className="btn" disabled={changed.length === 0} onClick={() => patchMatch(match.match_id, resetTracking)}>
          <ArrowCounterClockwise size={14} />
          Restablecer herramientas de tracking
        </button>
        <span aria-live="polite">{changed.length === 0 ? "Todo con su valor original." : `${changed.length} cambiado${changed.length === 1 ? "" : "s"} (en amarillo).`}</span>
      </div>
    </div>
  );
}

// Which event types are created by themselves from the detection (Match.tech.autoEvents), each with the verdict of its
// verification in the Playground (precision over the reviews saved in the folder).
export function AutoEvents({ match }: { match: Match }) {
  const on = autoEventsOf(match);
  const [files, setFiles] = useState<EventReviewFile[] | null>(null);
  const folder = match.folder;
  const videoIds = matchVideos(match).map((v) => v.video_id).join(",");
  useEffect(() => {
    let live = true;
    if (!folder) return;
    void Promise.all(videoIds.split(",").map(async (v) => parseEventReview(await readLocal(eventReviewPath(folder, v)), v))).then((r) => live && setFiles(r));
    return () => {
      live = false;
    };
  }, [folder, videoIds]);
  const fig = reviewFigures(files ?? []);
  return (
    <section aria-label="Eventos automáticos">
      <h3 className="eyebrow mb-1">Eventos automáticos</h3>
      <p className="m-0 mb-1 text-xs text-faint">Tipos de evento que se aceptan a partir de la detección sin etiquetarlos a mano. {AUTO_EVENTS_LEGEND}</p>
      {EVENT_TYPES.filter((t) => (DETECTED_TYPES as readonly string[]).includes(t)).map((t) => {
        const f = fig[t as DetectedType];
        return (
          <TechSwitch
            key={t}
            label={`Aceptar detección automática · ${EVENT_LABELS[t]}`}
            help={
              !folder
                ? "Sin carpeta: no hay revisiones."
                : files === null
                  ? "Leyendo las revisiones…"
                  : f && f.precision !== null
                    ? `Playground: ${Math.round(f.precision * 100)} % de acierto sobre ${f.reviewed} revisados (${f.verdict === "pass" ? "pasa" : f.verdict === "redefine" ? "redefinir la regla" : "aún pocas revisiones"}).`
                    : "Playground: sin revisiones de este tipo."
            }
            checked={on.includes(t as DetectedType)}
            def={false}
            onChange={(v) => patchMatch(match.match_id, (m) => withAutoEvent(m, t as DetectedType, v))}
          />
        );
      })}
    </section>
  );
}

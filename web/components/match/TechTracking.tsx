"use client";

import { ArrowCounterClockwise } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { DETECTED_TYPES, type DetectedType } from "@/lib/eventDetect";
import { eventReviewPath, parseEventReview, type EventReviewFile } from "@/lib/eventReview";
import { readLocal } from "@/lib/local";
import { mutate } from "@/lib/store";
import { AUTO_EVENTS_LEGEND, TRACKING_DEFAULTS, TRACKING_FIELDS, TRACKING_GROUPS, clampTracking, resetTracking, reviewFigures, trackingChanged, trackingParamsOf, withTrackingParam, type TrackingField } from "@/lib/techTracking";
import { autoEventsOf, withAutoEvent } from "@/lib/tech";
import { EVENT_LABELS, EVENT_TYPES, type Match } from "@/lib/types";
import { matchVideos } from "@/lib/videos";

const fmt = (n: number) => n.toLocaleString("es-MX", { maximumFractionDigits: 3 });
const patchMatch = (id: string, f: (m: Match) => Match) => mutate((s) => ({ ...s, matches: s.matches.map((m) => (m.match_id === id ? f(m) : m)) }));

function Field({ field, value, onChange }: { field: TrackingField; value: number; onChange: (v: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const def = TRACKING_DEFAULTS[field.key];
  return (
    <label className="block text-xs text-muted" title={field.help}>
      <span className="block">{field.label}</span>
      <span className="mt-1 flex items-center gap-1.5">
        <input
          type="number"
          inputMode="decimal"
          className="input tc w-24"
          min={field.min}
          max={field.max}
          step={field.step}
          value={draft ?? String(value)}
          aria-label={`${field.label}${field.unit ? ` (${field.unit})` : ""}`}
          onFocus={() => setDraft(String(value))}
          onBlur={() => setDraft(null)}
          onChange={(e) => {
            setDraft(e.target.value);
            if (e.target.value.trim() === "") return;
            const v = clampTracking(field, Number(e.target.value), value);
            if (v !== value) onChange(v);
          }}
        />
        <span className="text-faint">{field.unit}</span>
        <span className={value !== def ? "tag tag-accent" : "text-faint"}>por defecto {fmt(def)}</span>
      </span>
      <span className="mt-0.5 block text-[11px] text-faint">{field.help}</span>
    </label>
  );
}

// Detalles técnicos, part 2 (lib/techTracking.ts): tracking tools by group, and the event types accepted as automatic.
export function TechTracking({ match }: { match: Match }) {
  const p = trackingParamsOf(match);
  const changed = trackingChanged(match);
  return (
    <>
      {TRACKING_GROUPS.map((g) => (
        <section key={g.id} aria-label={g.title}>
          <h3 className="m-0 text-sm font-semibold text-ink">{g.title}</h3>
          <p className="m-0 mb-2 text-faint">{g.help}</p>
          <div className="grid grid-cols-1 gap-x-5 gap-y-3 sm:grid-cols-2">
            {TRACKING_FIELDS.filter((f) => f.group === g.id).map((f) => (
              <Field key={f.key} field={f} value={p[f.key]} onChange={(v) => patchMatch(match.match_id, (m) => withTrackingParam(m, f.key, v))} />
            ))}
            {g.id === "fill" && (
              <label className="flex items-start gap-2 text-xs text-muted" title="Si otra jugadora quedó casi empatada en la asignación, el relleno no decide">
                <input type="checkbox" className="mt-0.5" checked={p.fillRejectClose} onChange={(e) => patchMatch(match.match_id, (m) => withTrackingParam(m, "fillRejectClose", e.target.checked))} />
                <span>
                  Abstenerse si hay empate cercano
                  <span className="mt-0.5 block text-[11px] text-faint">Por defecto: {TRACKING_DEFAULTS.fillRejectClose ? "sí" : "no"}. Con empate cercano entre dos jugadoras, no asigna.</span>
                </span>
              </label>
            )}
          </div>
        </section>
      ))}
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn" disabled={changed.length === 0} onClick={() => patchMatch(match.match_id, resetTracking)}>
          <ArrowCounterClockwise size={14} />
          Restablecer herramientas de tracking
        </button>
        <span className="text-faint" aria-live="polite">
          {changed.length === 0 ? "Herramientas de tracking con los valores por defecto." : `${changed.length} distinto${changed.length === 1 ? "" : "s"} del defecto.`}
        </span>
      </div>
      <AutoEvents match={match} />
    </>
  );
}

// Which event types are created by themselves from the detection (Match.tech.autoEvents), each with the verdict of its
// verification in the Playground (precision over the reviews saved in the folder).
function AutoEvents({ match }: { match: Match }) {
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
      <h3 className="m-0 text-sm font-semibold text-ink">Eventos automáticos</h3>
      <p className="m-0 mb-2 text-faint">Tipos de evento que se aceptan a partir de la detección sin etiquetarlos a mano. {AUTO_EVENTS_LEGEND}</p>
      <ul className="m-0 grid list-none grid-cols-1 gap-x-5 gap-y-1.5 p-0 sm:grid-cols-2">
        {EVENT_TYPES.map((t) => {
          const detectable = (DETECTED_TYPES as readonly string[]).includes(t);
          const f = detectable ? fig[t as DetectedType] : null;
          return (
            <li key={t}>
              <label className={`flex items-start gap-2 text-xs ${detectable ? "text-muted" : "text-faint"}`}>
                <input
                  type="checkbox"
                  className="mt-0.5"
                  disabled={!detectable}
                  checked={detectable && on.includes(t as DetectedType)}
                  onChange={(e) => patchMatch(match.match_id, (m) => withAutoEvent(m, t as DetectedType, e.target.checked))}
                />
                <span>
                  <span className="text-ink">Aceptar detección automática</span> · {EVENT_LABELS[t]}
                  <span className="mt-0.5 block text-[11px] text-faint">
                    {!detectable
                      ? "Este tipo no tiene detección automática."
                      : !folder
                        ? "Sin carpeta: no hay revisiones."
                        : files === null
                          ? "Leyendo las revisiones…"
                          : f && f.precision !== null
                            ? `Playground: ${Math.round(f.precision * 100)} % de acierto sobre ${f.reviewed} revisados (${f.verdict === "pass" ? "pasa" : f.verdict === "redefine" ? "redefinir la regla" : "aún pocas revisiones"}).`
                            : "Playground: sin revisiones de este tipo."}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

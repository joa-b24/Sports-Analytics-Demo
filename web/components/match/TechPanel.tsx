"use client";

import { ArrowCounterClockwise } from "@phosphor-icons/react";
import { TechNumber, TechSwitch } from "@/components/match/TechField";
import { autoDownloadOn } from "@/lib/downloads";
import { EVENT_DEFAULTS } from "@/lib/eventDetect";
import { EVENT_PARAM_FIELDS, clampEventParam } from "@/lib/eventReview";
import { PARAM_FIELDS, clampParam } from "@/lib/playgroundPossession";
import { POSSESSION_DEFAULTS } from "@/lib/possession";
import { mutate } from "@/lib/store";
import {
  ANALYSIS_DEFAULTS,
  ANALYSIS_FIELDS,
  EVENT_TECH_GROUP,
  TECH_GROUPS,
  analysisChanged,
  analysisParamsOf,
  clampAnalysis,
  eventParamsOf,
  eventTechChanged,
  possessionParamsOf,
  resetAnalysisTech,
  resetEventTech,
  resetTech,
  techChanged,
  withAnalysisParam,
  withEventParam,
  withTech,
  withTechParam,
} from "@/lib/tech";
import { trackingChanged } from "@/lib/techTracking";
import type { Match } from "@/lib/types";
import { AutoEvents, TechTracking } from "./TechTracking";

const patchMatch = (id: string, f: (m: Match) => Match) => mutate((s) => ({ ...s, matches: s.matches.map((m) => (m.match_id === id ? f(m) : m)) }));

// The pages of the settings, each short enough to read without scrolling much. Grouped in the sidebar.
export type TechPage = "posesion" | "balon" | "eventos" | "analisis" | "tracking" | "videos";
export const TECH_PAGES: { id: TechPage; group: string; label: string; hint: string }[] = [
  { id: "posesion", group: "Cálculo", label: "Posesión", hint: "Cuándo un toque es control de un equipo y qué pasa en una disputa." },
  { id: "balon", group: "Cálculo", label: "Balón", hint: "Cómo se reconoce un balón parado, una reanudación o un vuelo largo." },
  { id: "eventos", group: "Cálculo", label: "Eventos detectados", hint: "Reglas con las que se detectan saques, faltas, pérdidas, entradas y centros desde las posiciones." },
  { id: "analisis", group: "Análisis", label: "Análisis", hint: "Cómo se corta la cancha en el Dashboard y cuánto dura cada transición." },
  { id: "tracking", group: "Herramientas", label: "Tracking", hint: "Relleno, huecos, confianza del balón y ayudas de la mesa de corrección." },
  { id: "videos", group: "Partido", label: "Videos", hint: "Descarga de los videos del partido." },
];

// Which pages have a value that is not the default (the sidebar marks them in yellow).
export function changedPages(m: Match): Set<TechPage> {
  const out = new Set<TechPage>();
  const pos = techChanged(m);
  const group = (id: string) => (TECH_GROUPS.find((g) => g.id === id)?.keys ?? []) as string[];
  if (pos.some((k) => group("control").includes(k) || group("contest").includes(k) || k === "joinSegments")) out.add("posesion");
  if (pos.some((k) => group("ball").includes(k))) out.add("balon");
  if (eventTechChanged(m).length > 0 || (m.tech?.autoEvents?.length ?? 0) > 0) out.add("eventos");
  if (analysisChanged(m).length > 0) out.add("analisis");
  if (trackingChanged(m).length > 0) out.add("tracking");
  if (m.tech?.autoDownload === false) out.add("videos");
  return out;
}

function ResetBar({ n, what, onReset }: { n: number; what: string; onReset: () => void }) {
  return (
    <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-line-soft pt-3 text-xs text-faint">
      <button type="button" className="btn" disabled={n === 0} onClick={onReset}>
        <ArrowCounterClockwise size={14} />
        Restablecer {what}
      </button>
      <span aria-live="polite">{n === 0 ? "Todo con su valor original." : `${n} valor${n === 1 ? "" : "es"} cambiado${n === 1 ? "" : "s"} (en amarillo).`}</span>
    </div>
  );
}

// One page of the match settings (Configuración del partido). Values are saved per match: the report, the summary and the
// evaluation tools read them, so changing one changes them.
export function TechPanel({ match, page }: { match: Match; page: TechPage }) {
  const params = possessionParamsOf(match);
  const eventParams = eventParamsOf(match);
  const analysis = analysisParamsOf(match);
  const group = (id: string) => TECH_GROUPS.find((g) => g.id === id);
  const possessionFields = (ids: string[]) =>
    ids.flatMap((id) =>
      (group(id)?.keys ?? []).map((k) => {
        const f = PARAM_FIELDS.find((x) => x.key === k);
        return f ? (
          <TechNumber
            key={k}
            label={f.label}
            help={f.help}
            unit={f.unit}
            value={params[k] as number}
            def={POSSESSION_DEFAULTS[k] as number}
            min={f.min}
            max={f.max}
            step={f.step}
            clamp={(v, prev) => clampParam(f, v, prev)}
            onChange={(v) => patchMatch(match.match_id, (m) => withTechParam(m, f.key, v))}
          />
        ) : null;
      }),
    );

  if (page === "posesion")
    return (
      <div>
        {possessionFields(["control", "contest"])}
        <TechSwitch
          label="Unir tramos de juego cortados"
          help="Entre dos tramos de juego, el balón se sigue si no se movió mucho."
          checked={params.joinSegments}
          def={POSSESSION_DEFAULTS.joinSegments}
          onChange={(v) => patchMatch(match.match_id, (m) => withTechParam(m, "joinSegments", v))}
        />
        <ResetBar n={techChanged(match).length} what="la posesión y el balón" onReset={() => patchMatch(match.match_id, resetTech)} />
      </div>
    );
  if (page === "balon")
    return (
      <div>
        {possessionFields(["ball"])}
        <ResetBar n={techChanged(match).length} what="la posesión y el balón" onReset={() => patchMatch(match.match_id, resetTech)} />
      </div>
    );
  if (page === "eventos")
    return (
      <div>
        <p className="mb-2 text-xs text-faint">{EVENT_TECH_GROUP.help} Se verifican en Playground &gt; Eventos.</p>
        {EVENT_PARAM_FIELDS.map((f) => (
          <TechNumber
            key={f.key}
            label={f.label}
            help={f.help}
            unit={f.unit}
            value={eventParams[f.key] as number}
            def={EVENT_DEFAULTS[f.key] as number}
            min={f.min}
            max={f.max}
            step={f.step}
            clamp={(v, prev) => clampEventParam(f, v, prev)}
            onChange={(v) => patchMatch(match.match_id, (m) => withEventParam(m, f.key, v))}
          />
        ))}
        <ResetBar n={eventTechChanged(match).length} what="las reglas de eventos" onReset={() => patchMatch(match.match_id, resetEventTech)} />
        <div className="mt-6">
          <AutoEvents match={match} />
        </div>
      </div>
    );
  if (page === "analisis")
    return (
      <div>
        {(["cut", "windows"] as const).map((g) => (
          <section key={g} className="mb-4" aria-label={g === "cut" ? "Cortes de la cancha" : "Ventanas de tiempo"}>
            <h3 className="eyebrow mb-1">{g === "cut" ? "Cortes de la cancha" : "Ventanas de tiempo"}</h3>
            {ANALYSIS_FIELDS.filter((f) => f.group === g).map((f) => (
              <TechNumber
                key={f.key}
                label={f.label}
                help={f.help}
                unit={f.unit}
                value={analysis[f.key]}
                def={ANALYSIS_DEFAULTS[f.key]}
                min={f.min}
                max={f.max}
                step={f.step}
                clamp={(v, prev) => clampAnalysis(f, v, prev)}
                onChange={(v) => patchMatch(match.match_id, (m) => withAnalysisParam(m, f.key, v))}
              />
            ))}
          </section>
        ))}
        <p className="text-xs text-pretty text-faint">
          Los carriles y las zonas cambian el dominio territorial y las entradas al último tercio del Dashboard; las ventanas, las tres cifras de transiciones de Defensa. El Informe usa por ahora 15 s.
        </p>
        <ResetBar n={analysisChanged(match).length} what="el análisis" onReset={() => patchMatch(match.match_id, resetAnalysisTech)} />
      </div>
    );
  if (page === "tracking") return <TechTracking match={match} />;
  return (
    <div>
      <TechSwitch
        label="Descargar videos que falten automáticamente"
        help="Al abrir el partido, cada video con enlace de YouTube que no esté en su carpeta se baja solo (1080p, solo imagen). Solo funciona con la app en esta computadora; un error o una cancelación no se reintentan solos."
        checked={autoDownloadOn(match)}
        def={true}
        onChange={(v) => patchMatch(match.match_id, (m) => withTech(m, { autoDownload: v ? undefined : false }))}
      />
    </div>
  );
}

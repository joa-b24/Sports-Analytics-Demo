"use client";

import { ArrowCounterClockwise, FilmSlate, FloppyDisk, Lock, MagnifyingGlass, MapTrifold, Palette, PencilSimple, Plus, Trash, UsersThree } from "@phosphor-icons/react";
import Link from "next/link";
import { useState } from "react";
import { Locked, SkBars } from "@/components/Locked";
import { Card, PageHeader } from "@/components/Shell";
import { VenueDiagram, VenueEditor } from "@/components/VenueEditor";
import { LABEL_STYLES } from "@/components/PlayerMark";
import { RosterCard } from "@/components/RosterCard";
import { AUTOSAVE_PREF } from "@/lib/saveMatch";
import { TEAM_SECTIONS } from "@/lib/features";
import { getPref, mutate, setPref, uid, usePref, useStore } from "@/lib/store";
import { DEFAULT_BALL, DEFAULT_OPP, DEFAULT_OWN, TEAM_COLORS } from "@/lib/teamColors";
import { PITCH, type VenueSpec } from "@/lib/types";
import { BUILTIN_SPECS, allVenues } from "@/lib/venue";
import { referenceGroups } from "@/lib/venueFit";

// One adjustable setting: where it lives, how to find it and how to draw it. `modified` marks it when it is not the
// default value (like VS Code's blue bar); the arrow puts the default back.
type Setting = {
  id: string;
  section: SectionId;
  label: string;
  help: string;
  keys: string;
  pref: string;
  def: string;
  control: (value: string, set: (v: string) => void) => React.ReactNode;
};

const SECTIONS = [
  { id: "look", label: "Apariencia", icon: Palette },
  { id: "video", label: "Video y etiquetado", icon: FilmSlate },
  { id: "save", label: "Guardado", icon: FloppyDisk },
  { id: "venues", label: "Sedes", icon: MapTrifold },
  { id: "roster", label: "Equipos y plantillas", icon: UsersThree },
  { id: "thresholds", label: "Umbrales y zonas", icon: Lock },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];
// Thresholds are about training load: hidden with the team sections (lib/features.ts).
const VISIBLE = SECTIONS.filter((t) => TEAM_SECTIONS || t.id !== "thresholds");
const SETTING_SECTIONS: SectionId[] = ["look", "video", "save"];

const choice = (options: [string, string][]) => {
  const Choice = (value: string, set: (v: string) => void) => (
    <div className="seg" role="radiogroup">
      {options.map(([id, label]) => (
        <button key={id} type="button" aria-pressed={value === id} onClick={() => set(id)} className="seg-opt">
          {label}
        </button>
      ))}
    </div>
  );
  return Choice;
};
const swatches = (other: string) => {
  const Swatches = (value: string, set: (v: string) => void) => (
    <div className="flex flex-wrap gap-1" role="radiogroup">
      {TEAM_COLORS.map((c) => (
        <button
          key={c.id}
          type="button"
          role="radio"
          aria-checked={value === c.id}
          disabled={!!other && other === c.id}
          title={other === c.id ? `${c.label}: lo usa el otro equipo` : c.label}
          onClick={() => set(c.id)}
          className={`grid h-8 w-8 place-items-center rounded-md border-2 transition-colors disabled:cursor-not-allowed disabled:opacity-20 ${value === c.id ? "border-ink" : "border-transparent hover:border-line-strong"}`}
        >
          <span className="h-4 w-4 rounded-full" style={{ background: c.value }} />
        </button>
      ))}
    </div>
  );
  return Swatches;
};

const zoomText = (v: string) => `${(Number(v) || 1).toFixed(2).replace(/\.?0+$/, "")}×`;

function useSettings(own: string, opp: string): Setting[] {
  return [
    { id: "theme", section: "look", label: "Tema", help: "Oscuro (por defecto) o claro.", keys: "tema oscuro claro color", pref: "theme", def: "dark", control: choice([["dark", "Oscuro"], ["light", "Claro"]]) },
    { id: "sidebar", section: "look", label: "Barra lateral", help: "Solo iconos o con los nombres.", keys: "menú barra lateral iconos", pref: "sidebar", def: "icons", control: choice([["icons", "Iconos"], ["full", "Con nombres"]]) },
    { id: "ownColor", section: "look", label: "Color de nuestro equipo", help: "Marcador, mapas y gráficos.", keys: "color equipo propio azul", pref: "ownColor", def: DEFAULT_OWN, control: swatches(opp) },
    { id: "oppColor", section: "look", label: "Color del rival", help: "No puede ser el mismo que el nuestro.", keys: "color rival equipo contrario", pref: "oppColor", def: DEFAULT_OPP, control: swatches(own) },
    { id: "ballColor", section: "look", label: "Línea del balón", help: "Trayectoria del balón en la mesa de corrección.", keys: "color balón línea trayectoria", pref: "ballColor", def: DEFAULT_BALL, control: swatches("") },
    {
      id: "labelStyle",
      section: "look",
      label: "Jugadoras sobre el video",
      help: "Cómo se marca a cada persona. Mayús + L lo cambia en la mesa.",
      keys: "etiquetas caja óvalo flecha marca jugadora video",
      pref: "labelStyle",
      def: "oval",
      control: (v, set) => (
        <div className="grid grid-cols-3 gap-1.5" role="radiogroup">
          {LABEL_STYLES.map((o) => (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={v === o.id}
              onClick={() => set(o.id)}
              className={`flex flex-col items-center gap-1 rounded-md border px-3 py-2 transition-colors ${v === o.id ? "border-accent bg-accent-900/40 text-ink" : "border-line text-muted hover:border-line-strong hover:bg-raised"}`}
            >
              <LabelGlyph kind={o.id} />
              <span className="text-xs">{o.label}</span>
            </button>
          ))}
        </div>
      ),
    },
    {
      id: "playerZoom",
      section: "video",
      label: "Zoom del reproductor",
      help: "Acerca la imagen dentro del recuadro; se mueve con el botón de la cruz sobre el video.",
      keys: "zoom acercar reproductor video imagen",
      pref: "playerZoom",
      def: "1",
      control: (v, set) => (
        <label className="flex items-center gap-3 text-xs text-ink-2">
          <input type="range" min={1} max={4} step={0.25} value={Number(v) || 1} onChange={(e) => set(e.target.value)} className="w-40" />
          <span className="num w-10">{zoomText(v)}</span>
        </label>
      ),
    },
    {
      id: "playerFrame",
      section: "video",
      label: "Forma del recuadro",
      help: "Más alto que 16:9 deja ver más de la imagen sin desplazarte.",
      keys: "recuadro alto ancho reproductor proporción aspecto",
      pref: "playerFrame",
      def: "16/9",
      control: choice([["16/9", "Ancho"], ["4/3", "4:3"], ["1/1", "Cuadrado"], ["3/4", "Alto"]]),
    },
    { id: "skipPauses", section: "video", label: "Saltar pausas al etiquetar", help: "La reproducción se salta lo que está fuera de los tramos de juego.", keys: "pausas saltar tramos etiquetar", pref: "skipPauses", def: "on", control: choice([["on", "Sí"], ["off", "No"]]) },
    {
      id: "tagLag",
      section: "video",
      label: "Retraso al etiquetar",
      help: "Segundos que se restan al tiempo actual: pulsas la tecla después de que pasó la acción.",
      keys: "retraso lag segundos etiquetar tecla",
      pref: "tagLag",
      def: "3",
      control: (v, set) => (
        <label className="flex items-center gap-2 text-xs text-ink-2">
          <input type="number" min={0} max={10} step={0.5} value={v} onChange={(e) => set(e.target.value)} className="input !w-20" />s
        </label>
      ),
    },
    { id: "autosave", section: "save", label: "Guardado automático", help: "Cada 5 minutos y solo tras 30 s sin cambios, a la carpeta del partido. Ctrl + S siempre guarda al momento.", keys: "guardar automático autoguardado respaldo carpeta", pref: AUTOSAVE_PREF, def: "on", control: choice([["on", "Activado"], ["off", "Apagado"]]) },
  ];
}

export default function Page() {
  // Remembered, and set from outside too (a match's «+ Sede» opens Sedes). An old tab id falls back to Apariencia.
  const tabPref = usePref("config:tab", "look");
  const tab: SectionId = VISIBLE.some((t) => t.id === tabPref) ? (tabPref as SectionId) : "look";
  const setTab = (t: SectionId) => setPref("config:tab", t);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<{ spec: VenueSpec; isNew: boolean } | null>(null);
  const own = usePref("ownColor", DEFAULT_OWN);
  const opp = usePref("oppColor", DEFAULT_OPP);
  const settings = useSettings(own, opp);
  // Every preference of the list, read through one subscription so the marks follow them.
  usePref("theme", "dark");
  const valueOf = (x: Setting) => getPref(x.pref, x.def);

  const saveVenue = (spec: VenueSpec) => {
    mutate((s) => ({ ...s, venues: [...s.venues.filter((v) => v.venue_id !== spec.venue_id), spec] }));
    setEditing(null);
  };
  const newVenue = () =>
    setEditing({
      isNew: true,
      spec: { venue_id: uid("sede"), name: "", kind: "soccer", length_m: 105, width_m: 68, soccer_color: "#f8fafc", grid_color: "#cbd5e1" },
    });

  // The venue editor takes the whole screen: no header or tabs, so it fits without scrolling.
  if (tab === "venues" && editing)
    return <VenueEditor key={editing.spec.venue_id} initial={editing.spec} isNew={editing.isNew} onSave={saveVenue} onCancel={() => setEditing(null)} />;

  const q = query.trim().toLowerCase();
  const found = q ? settings.filter((x) => `${x.label} ${x.help} ${x.keys}`.toLowerCase().includes(q)) : [];
  const sectionsFound = q ? VISIBLE.filter((x) => x.label.toLowerCase().includes(q) && !SETTING_SECTIONS.includes(x.id)) : [];
  const modifiedIn = (id: SectionId) => settings.filter((x) => x.section === id && valueOf(x) !== x.def).length;
  const current = VISIBLE.find((x) => x.id === tab) ?? VISIBLE[0];

  const rowOf = (x: Setting) => {
    const value = valueOf(x);
    const changed = value !== x.def;
    return (
      <div key={x.id} className="relative grid gap-x-8 gap-y-2 border-t border-line-soft py-4 pl-4 first:border-t-0 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
        {/* The bar on the left says this value is not the default. */}
        <i className={`absolute top-3 bottom-3 left-0 w-0.5 rounded-full ${changed ? "bg-accent" : "bg-transparent"}`} aria-hidden />
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm text-ink">
            {x.label}
            {changed && (
              <button type="button" className="inline-flex items-center gap-1 text-[11px] text-accent-300 hover:text-accent-200" onClick={() => setPref(x.pref, x.def)} title="Volver al valor por defecto">
                <ArrowCounterClockwise size={11} />
                modificado
              </button>
            )}
          </div>
          <p className="m-0 mt-0.5 max-w-xl text-xs text-pretty text-faint">{x.help}</p>
        </div>
        <div>{x.control(value, (v) => setPref(x.pref, v))}</div>
      </div>
    );
  };

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader title="Configuración">
        <label className="relative">
          <MagnifyingGlass size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-faint" aria-hidden />
          <input className="input !w-64 !pl-8" placeholder="Buscar un ajuste" aria-label="Buscar un ajuste" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
      </PageHeader>

      <div className="grid gap-6 md:grid-cols-[13rem_minmax(0,1fr)]">
        <nav aria-label="Secciones de configuración" className="flex gap-1 overflow-x-auto md:flex-col md:self-start md:overflow-visible md:border-r md:border-line-soft md:pr-3">
          {VISIBLE.map((t) => {
            const n = modifiedIn(t.id);
            return (
              <button
                key={t.id}
                type="button"
                aria-current={!q && tab === t.id ? "page" : undefined}
                onClick={() => {
                  setQuery("");
                  setTab(t.id);
                }}
                className={`flex shrink-0 items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors ${!q && tab === t.id ? "bg-raised text-ink" : "text-muted hover:bg-raised/60 hover:text-ink"}`}
              >
                <t.icon size={16} className="shrink-0" />
                <span className="flex-1 whitespace-nowrap">{t.label}</span>
                {n > 0 && (
                  <span className="tc rounded bg-accent-900 px-1.5 text-[10px] text-accent-200" title={`${n} ajuste(s) distintos del valor por defecto`}>
                    {n}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="min-w-0">
          {q ? (
            <section aria-label="Resultados de la búsqueda">
              <h2 className="mb-1 text-[15px] text-ink">
                {found.length + sectionsFound.length} resultado{found.length + sectionsFound.length === 1 ? "" : "s"} para «{query}»
              </h2>
              {found.map((x) => (
                <div key={x.id}>
                  <span className="tag tag-outline mt-3 inline-block">{VISIBLE.find((v) => v.id === x.section)?.label}</span>
                  {rowOf(x)}
                </div>
              ))}
              {sectionsFound.map((x) => (
                <button
                  key={x.id}
                  type="button"
                  className="btn mt-3 mr-2"
                  onClick={() => {
                    setQuery("");
                    setTab(x.id);
                  }}
                >
                  <x.icon size={14} />
                  Ir a {x.label}
                </button>
              ))}
              {found.length + sectionsFound.length === 0 && <p className="text-sm text-faint">Ningún ajuste coincide. Prueba con otra palabra (por ejemplo «color», «zoom» o «guardar»).</p>}
            </section>
          ) : (
            <section aria-label={current.label}>
              {SETTING_SECTIONS.includes(current.id) && (
                <>
                  <h2 className="mb-1 text-[15px] text-ink">{current.label}</h2>
                  {current.id === "look" && <ColorPreview />}
                  <div>{settings.filter((x) => x.section === current.id).map(rowOf)}</div>
                </>
              )}
              {current.id === "venues" && <Venues onEdit={(spec) => setEditing({ spec, isNew: false })} onNew={newVenue} />}
              {current.id === "roster" && (
                <div className="space-y-5">
                  <TeamsCard />
                  <RosterCard />
                </div>
              )}
              {current.id === "thresholds" && (
                <Locked
                  reason="dev"
                  title="Umbrales y zonas"
                  why="Velocidad a partir de la cual se cuenta alta intensidad y sprint, zonas de frecuencia cardiaca y rango seguro de carga aguda : crónica. Hoy la app no calcula ninguna de esas métricas: muestra las columnas tal como vienen del sensor."
                  need="que existan las métricas que usan esos umbrales (zonas de FC, ACWR), y la FC máxima de cada jugadora en la plantilla."
                >
                  <SkBars rows={4} />
                </Locked>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

// A scoreboard and a pitch with the live colours, so a colour change is seen where it counts.
function ColorPreview() {
  return (
    <div className="my-3 flex flex-col gap-3 rounded-md bg-bg/60 p-4 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-stretch overflow-hidden rounded-md text-sm">
        <span className="flex flex-1 items-center bg-own px-3 py-2 text-[color:var(--on-own)]">Tec CCM</span>
        <span className="num grid place-items-center bg-raised px-3 text-lg text-ink">2 – 1</span>
        <span className="flex flex-1 items-center justify-end bg-opp px-3 py-2 text-[color:var(--on-opp)]">Rival</span>
      </div>
      <svg viewBox="0 0 105 68" className="w-44 shrink-0 rounded-md bg-pitch" aria-hidden>
        <rect x={1} y={1} width={103} height={66} fill="none" className="stroke-line-strong" strokeWidth={0.6} />
        <line x1={52.5} y1={1} x2={52.5} y2={67} className="stroke-line-strong" strokeWidth={0.6} />
        {[[20, 20], [30, 45], [42, 30]].map(([x, y], i) => (
          <circle key={`o${i}`} cx={x} cy={y} r={3} className="fill-own" />
        ))}
        {[[66, 24], [74, 44], [86, 34]].map(([x, y], i) => (
          <circle key={`r${i}`} cx={x} cy={y} r={3} className="fill-opp" />
        ))}
      </svg>
    </div>
  );
}

// Small drawing of each way of marking a player over the video.
function LabelGlyph({ kind }: { kind: string }) {
  return (
    <svg viewBox="0 0 40 40" className="h-10 w-10" aria-hidden>
      <circle cx={20} cy={13} r={4} className="fill-current opacity-60" />
      <path d="M14 33 L16 20 Q20 17 24 20 L26 33 Z" className="fill-current opacity-60" />
      {kind === "box" && <rect x={9} y={6} width={22} height={30} rx={2} fill="none" className="stroke-accent-300" strokeWidth={1.6} />}
      {kind === "oval" && <ellipse cx={20} cy={34} rx={10} ry={3.2} fill="none" className="stroke-accent-300" strokeWidth={1.8} />}
      {kind === "arrow" && <path d="M20 4 L20 1 M15 1 L20 6 L25 1" fill="none" className="stroke-accent-300" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  );
}

// The teams of the app. For now there is one, Tec CCM (the analysed team): its squad is the one below.
function TeamsCard() {
  const { roster } = useStore();
  const ownId = usePref("ownColor", DEFAULT_OWN);
  const own = TEAM_COLORS.find((c) => c.id === ownId) ?? TEAM_COLORS[0];
  return (
    <section className="rounded-lg bg-surface p-4" aria-label="Equipos">
      <div className="mb-3 flex items-center gap-3">
        <h3 className="m-0 text-sm text-ink">Equipos</h3>
        <span className="hr-fade-l min-w-8 flex-1" />
        <button type="button" className="btn" disabled title="Por ahora solo existe Tec CCM: los equipos rivales se escriben en cada partido">
          <Plus size={14} />
          Añadir equipo
        </button>
      </div>
      <ul className="m-0 list-none p-0">
        <li className="flex items-center gap-3 rounded-lg bg-bg/50 px-3 py-2.5">
          <i className="h-8 w-1 shrink-0 rounded-full" style={{ background: "var(--color-own)" }} aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="cond block text-sm font-bold text-ink uppercase">Tec CCM</span>
            <span className="block text-xs text-faint">
              Equipo analizado · {(roster ?? []).length} jugadoras · color {own.label.toLowerCase()} (se cambia en Apariencia)
            </span>
          </span>
          <span className="tag tag-accent">Por defecto</span>
        </li>
      </ul>
      <p className="mt-3 mb-0 text-xs text-pretty text-faint">La plantilla de abajo es la de Tec CCM. Más equipos con su propia plantilla llegarán después.</p>
    </section>
  );
}

function Venues({ onEdit, onNew }: { onEdit: (spec: VenueSpec) => void; onNew: () => void }) {
  const state = useStore();
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const venues = allVenues(state.venues);
  const builtinIds = new Set(BUILTIN_SPECS.map((b) => b.venue_id));
  const removeVenue = (id: string) => {
    mutate((s) => ({ ...s, venues: s.venues.filter((v) => v.venue_id !== id) }));
    setConfirmDelete(null);
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-2">
        {venues.map((v, n) => {
          const exact = v.landmarks.filter((l) => l.exact).length;
          const anchors = state.anchors.filter((a) => a.venue_id === v.venue_id).length;
          const custom = !v.builtin;
          const overrides = custom && builtinIds.has(v.venue_id);
          const groups = referenceGroups(v.spec.kind);
          const checked = groups.filter((g) => v.spec.checked?.includes(g.id)).length;
          return (
            <Card key={v.venue_id} delay={n * 60} className="flex flex-col">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="tag">{v.spec.kind === "soccer" ? "Solo fútbol" : "Sobre campo de americano"}</span>
                    {overrides && <span className="tag tag-outline">editada</span>}
                    {custom && !overrides && <span className="tag tag-outline">creada aquí</span>}
                  </div>
                  <h2 className="mt-2 truncate text-2xl text-ink">{v.name}</h2>
                  <p className="mt-0.5 text-xs text-faint">
                    {anchors} cuadro{anchors === 1 ? "" : "s"} calibrado{anchors === 1 ? "" : "s"} · <span className="tc">{v.venue_id}</span>
                  </p>
                </div>
                <div className="text-right">
                  <div className="num text-4xl text-ink">
                    {v.length_m}
                    <span className="mx-1 text-xl text-faint">×</span>
                    {v.width_m}
                  </div>
                  <div className="mt-1 text-[11px] text-muted">metros</div>
                </div>
              </div>

              <VenueDiagram venue={v} className="mt-4" />

              <dl className="mt-4 grid grid-cols-4 gap-3 text-[11px]">
                <Stat label="Puntos exactos" value={exact} />
                <Stat label="Por confirmar" value={v.landmarks.length - exact} />
                <Stat label="Portería" value={v.spec.goal_width_m !== undefined ? `${v.spec.goal_width_m}${v.spec.goal_height_m !== undefined ? ` × ${v.spec.goal_height_m}` : ""}` : "—"} muted={v.spec.goal_width_m === undefined} />
                <Stat label="Verificado en imagen" value={`${checked}/${groups.length}`} muted={!checked} />
              </dl>

              <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line-soft pt-3">
                <button type="button" className="btn" onClick={() => onEdit(v.spec)}>
                  <PencilSimple size={15} />
                  Editar
                </button>
                <span className="flex-1" />
                {custom &&
                  (confirmDelete === v.venue_id ? (
                    <span className="flex items-center gap-2 text-xs text-ink-2">
                      {overrides ? "¿Volver a la sede original del código?" : `¿Borrar esta sede?${anchors ? ` Sus ${anchors} anclas quedarán sin modelo.` : ""}`}
                      <button type="button" className="btn h-7 !border-danger/60 !px-2 text-danger" onClick={() => removeVenue(v.venue_id)}>
                        Sí
                      </button>
                      <button type="button" className="btn btn-ghost h-7 !px-2" onClick={() => setConfirmDelete(null)}>
                        Cancelar
                      </button>
                    </span>
                  ) : (
                    <button type="button" className="btn btn-ghost" onClick={() => setConfirmDelete(v.venue_id)}>
                      {overrides ? <ArrowCounterClockwise size={15} /> : <Trash size={15} />}
                      {overrides ? "Restablecer la original" : "Borrar"}
                    </button>
                  ))}
              </div>
            </Card>
          );
        })}
        <button
          type="button"
          onClick={onNew}
          className="group grid min-h-64 place-items-center rounded-md border border-dashed border-line-strong text-muted transition-colors hover:border-accent hover:bg-accent-900/20 hover:text-ink"
        >
          <span className="flex flex-col items-center gap-3">
            <span className="grid h-12 w-12 place-items-center rounded-full bg-raised transition-colors group-hover:bg-accent-900 group-hover:text-accent-200">
              <Plus size={22} />
            </span>
            <span className="text-sm">Nueva sede</span>
            <span className="max-w-xs text-center text-xs text-pretty text-faint">Medidas, colores y la cancha calzada sobre una captura satelital.</span>
          </span>
        </button>
      </div>
      <p className="max-w-3xl text-xs text-pretty text-faint">
        Las posiciones se normalizan a {PITCH.length} × {PITCH.width}. Cambiar una sede recalcula las anclas que la usan (se guardan los clics, no la
        matriz). Las medidas para Python siguen en el <code>match.yaml</code> de cada partido: si cambias aquí el largo o el ancho, actualízalo
        también ahí. La sede de un partido se elige en su pestaña{" "}
        <Link href="/partidos" className="link">
          Calibración
        </Link>
        .
      </p>
    </div>
  );
}

function Stat({ label, value, muted = false }: { label: string; value: React.ReactNode; muted?: boolean }) {
  return (
    <div>
      <dt className="text-faint">{label}</dt>
      <dd className={`num mt-1 text-xl ${muted ? "text-faint" : "text-ink-2"}`}>{value}</dd>
    </div>
  );
}

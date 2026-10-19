"use client";

import { ArrowCounterClockwise, CheckCircle, Lock, MapTrifold, Moon, Palette, PencilSimple, Plus, Sun, Trash, UsersThree } from "@phosphor-icons/react";
import Link from "next/link";
import { useState } from "react";
import { Locked, SkBars } from "@/components/Locked";
import { Card, PageHeader } from "@/components/Shell";
import { VenueDiagram, VenueEditor } from "@/components/VenueEditor";
import { LABEL_STYLES } from "@/components/PlayerMark";
import { RosterCard } from "@/components/RosterCard";
import { TEAM_SECTIONS } from "@/lib/features";
import { mutate, setPref, uid, usePref, useStore } from "@/lib/store";
import { DEFAULT_OPP, DEFAULT_OWN, TEAM_COLORS } from "@/lib/teamColors";
import { PITCH, type VenueSpec } from "@/lib/types";
import { BUILTIN_SPECS, allVenues } from "@/lib/venue";
import { referenceGroups } from "@/lib/venueFit";

const TABS = [
  { id: "look", label: "Apariencia", icon: Palette, locked: false },
  { id: "venues", label: "Sedes", icon: MapTrifold, locked: false },
  { id: "roster", label: "Plantilla", icon: UsersThree, locked: false },
  { id: "thresholds", label: "Umbrales y zonas", icon: Lock, locked: true },
] as const;
type TabId = (typeof TABS)[number]["id"];
// Thresholds are about training load: hidden with the team sections (lib/features.ts).
const VISIBLE_TABS = TABS.filter((t) => TEAM_SECTIONS || t.id !== "thresholds");

export default function Page() {
  // Remembered, and set from outside too (a match's «+ Sede» opens Sedes). An old "keys" falls back to Apariencia.
  const tabPref = usePref("config:tab", "look");
  const tab: TabId = VISIBLE_TABS.some((t) => t.id === tabPref) ? (tabPref as TabId) : "look";
  const setTab = (t: TabId) => setPref("config:tab", t);
  const [editing, setEditing] = useState<{ spec: VenueSpec; isNew: boolean } | null>(null);

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

  return (
    <>
      <PageHeader title="Configuración">
        <div className="seg" role="tablist" aria-label="Sección de configuración">
          {VISIBLE_TABS.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)} className="seg-opt inline-flex items-center gap-1.5">
              <t.icon size={14} />
              {t.label}
              {t.locked && <Lock size={11} className="text-warn/80" />}
            </button>
          ))}
        </div>
      </PageHeader>

      {tab === "look" && <Appearance />}
      {tab === "venues" && <Venues onEdit={(spec) => setEditing({ spec, isNew: false })} onNew={newVenue} />}
      {tab === "roster" && <RosterCard />}
      {tab === "thresholds" && (
        <Locked
          reason="dev"
          title="Umbrales y zonas"
          why="Velocidad a partir de la cual se cuenta alta intensidad y sprint, zonas de frecuencia cardiaca y rango seguro de carga aguda : crónica. Hoy la app no calcula ninguna de esas métricas: muestra las columnas tal como vienen del sensor."
          need="que existan las métricas que usan esos umbrales (zonas de FC, ACWR), y la FC máxima de cada jugadora en la plantilla."
        >
          <SkBars rows={4} />
        </Locked>
      )}
    </>
  );
}

function Appearance() {
  const theme = usePref("theme", "dark");
  const ownColor = usePref("ownColor", DEFAULT_OWN);
  const oppColor = usePref("oppColor", DEFAULT_OPP);
  const labelStyle = usePref("labelStyle", "oval");

  return (
    <div className="grid max-w-5xl gap-4 lg:grid-cols-2">
      <Card title="Tema">
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Tema">
          {(
            [
              ["dark", "Oscuro", Moon],
              ["light", "Claro", Sun],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={theme === id}
              onClick={() => setPref("theme", id)}
              className={`flex items-center gap-3 rounded-[10px] border p-3 text-left transition-colors ${theme === id ? "border-accent bg-accent-900/40" : "border-line hover:border-line-strong hover:bg-raised"}`}
            >
              <span className={`grid h-9 w-9 place-items-center rounded-full ${theme === id ? "bg-accent-900 text-accent-200" : "bg-raised text-muted"}`}>
                <Icon size={17} />
              </span>
              <span className="text-sm text-ink">{label}</span>
              {theme === id && <CheckCircle size={16} weight="fill" className="ml-auto text-accent-300" />}
            </button>
          ))}
        </div>
      </Card>

      <Card title="Jugadoras sobre el video" note="Mayús + L lo cambia en la mesa">
        <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Cómo se marca a cada persona">
          {LABEL_STYLES.map((o) => (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={labelStyle === o.id}
              onClick={() => setPref("labelStyle", o.id)}
              className={`flex flex-col items-center gap-2 rounded-[10px] border px-2 py-3 transition-colors ${labelStyle === o.id ? "border-accent bg-accent-900/40 text-ink" : "border-line text-muted hover:border-line-strong hover:bg-raised"}`}
            >
              <LabelGlyph kind={o.id} />
              <span className="text-xs">{o.label}</span>
            </button>
          ))}
        </div>
      </Card>

      <Card title="Colores de los equipos" className="lg:col-span-2">
        <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_16rem]">
          <div className="space-y-4">
            {(
              [
                ["ownColor", "Nuestro equipo", ownColor, oppColor],
                ["oppColor", "Rival", oppColor, ownColor],
              ] as const
            ).map(([key, title, value, other]) => (
              <div key={key}>
                <div className="mb-2 flex items-baseline justify-between text-xs">
                  <span className="text-ink-2">{title}</span>
                  <span className="text-faint">{TEAM_COLORS.find((c) => c.id === value)?.label}</span>
                </div>
                <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={`Color: ${title}`}>
                  {TEAM_COLORS.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      role="radio"
                      aria-checked={value === c.id}
                      disabled={other === c.id}
                      title={other === c.id ? `${c.label}: lo usa el otro equipo` : c.label}
                      onClick={() => setPref(key, c.id)}
                      className={`grid h-9 w-9 place-items-center rounded-lg border-2 transition-colors disabled:cursor-not-allowed disabled:opacity-20 ${value === c.id ? "border-ink" : "border-transparent hover:border-line-strong"}`}
                    >
                      <span className="h-5 w-5 rounded-full" style={{ background: c.value }} />
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          {/* Preview with the live tokens: what a scoreboard and a pitch will look like. */}
          <div className="flex flex-col justify-center gap-3 rounded-[10px] bg-bg/60 p-4">
            <div className="flex items-stretch overflow-hidden rounded-md text-sm">
              <span className="flex flex-1 items-center bg-own px-3 py-2 text-[color:var(--on-own)]">Tec CCM</span>
              <span className="num grid place-items-center bg-raised px-3 text-lg text-ink">2 – 1</span>
              <span className="flex flex-1 items-center justify-end bg-opp px-3 py-2 text-[color:var(--on-opp)]">Rival</span>
            </div>
            <svg viewBox="0 0 105 68" className="w-full rounded-md bg-pitch" aria-hidden>
              <rect x={1} y={1} width={103} height={66} fill="none" className="stroke-line-strong" strokeWidth={0.6} />
              <line x1={52.5} y1={1} x2={52.5} y2={67} className="stroke-line-strong" strokeWidth={0.6} />
              {[
                [20, 20],
                [30, 45],
                [42, 30],
              ].map(([x, y], i) => (
                <circle key={`o${i}`} cx={x} cy={y} r={3} className="fill-own" />
              ))}
              {[
                [66, 24],
                [74, 44],
                [86, 34],
              ].map(([x, y], i) => (
                <circle key={`r${i}`} cx={x} cy={y} r={3} className="fill-opp" />
              ))}
            </svg>
          </div>
        </div>
      </Card>
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
          className="group grid min-h-64 place-items-center rounded-[10px] border border-dashed border-line-strong text-muted transition-colors hover:border-accent hover:bg-accent-900/20 hover:text-ink"
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

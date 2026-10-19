"use client";

import { ArrowCounterClockwise, Lock, PencilSimple, Plus, Trash } from "@phosphor-icons/react";
import Link from "next/link";
import { useState } from "react";
import { Locked, LockedRow, SkBars } from "@/components/Locked";
import { Reveal } from "@/components/motion";
import { Card, PageHeader, btn, btnPrimary } from "@/components/Shell";
import { VenueDiagram, VenueEditor } from "@/components/VenueEditor";
import { LABEL_STYLES } from "@/components/PlayerMark";
import { mutate, setPref, uid, usePref, useStore } from "@/lib/store";
import { DEFAULT_OPP, DEFAULT_OWN, TEAM_COLORS } from "@/lib/teamColors";
import { EVENT_KEYS, EVENT_LABELS, EVENT_TYPES, PITCH, type VenueSpec } from "@/lib/types";
import { BUILTIN_SPECS, allVenues } from "@/lib/venue";

const TABS = [
  { id: "look", label: "Apariencia", locked: false },
  { id: "venues", label: "Sedes", locked: false },
  { id: "keys", label: "Teclas de eventos", locked: false },
  { id: "roster", label: "Plantilla", locked: true },
  { id: "thresholds", label: "Umbrales y zonas", locked: true },
] as const;
type TabId = (typeof TABS)[number]["id"];

const ROSTER_FIELDS = ["Foto", "Nombre completo", "Dorsal", "Posición", "Estatura", "Peso", "Pie hábil", "FC máx.", "ID del GPS", "Carrera y semestre"];

export default function Page() {
  const [tab, setTab] = useState<TabId>("look");
  const theme = usePref("theme", "dark");
  const ownColor = usePref("ownColor", DEFAULT_OWN);
  const oppColor = usePref("oppColor", DEFAULT_OPP);
  const labelStyle = usePref("labelStyle", "oval");
  const state = useStore();
  const [editing, setEditing] = useState<{ spec: VenueSpec; isNew: boolean } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const venues = allVenues(state.venues);
  const builtinIds = new Set(BUILTIN_SPECS.map((b) => b.venue_id));

  const saveVenue = (spec: VenueSpec) => {
    mutate((s) => ({ ...s, venues: [...s.venues.filter((v) => v.venue_id !== spec.venue_id), spec] }));
    setEditing(null);
  };
  const removeVenue = (id: string) => {
    mutate((s) => ({ ...s, venues: s.venues.filter((v) => v.venue_id !== id) }));
    setConfirmDelete(null);
  };
  const newVenue = () =>
    setEditing({
      isNew: true,
      spec: { venue_id: uid("sede"), name: "", kind: "soccer", length_m: 105, width_m: 68, soccer_color: "#f8fafc", grid_color: "#cbd5e1" },
    });

  return (
    <>
      <PageHeader title={TABS.find((t) => t.id === tab)?.label ?? ""} />

      <div className="enter mb-8 overflow-x-auto pb-1" style={{ "--d": "160ms" } as React.CSSProperties}>
        <div className="seg" role="group" aria-label="Sección de configuración">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-pressed={tab === t.id}
              onClick={() => setTab(t.id)}
              className="seg-opt inline-flex items-center gap-1.5"
            >
              {t.label}
              {t.locked && <Lock size={11} className="text-warn/80" />}
            </button>
          ))}
        </div>
      </div>

      {tab === "look" && (
        <div className="grid max-w-3xl gap-4">
          <Card title="Tema">
            <div className="seg" role="group" aria-label="Tema">
              {(
                [
                  ["dark", "Oscuro"],
                  ["light", "Claro"],
                ] as const
              ).map(([id, label]) => (
                <button key={id} type="button" className="seg-opt" aria-pressed={theme === id} onClick={() => setPref("theme", id)}>
                  {label}
                </button>
              ))}
            </div>
          </Card>
          {(
            [
              ["ownColor", "Nuestro equipo", ownColor, oppColor],
              ["oppColor", "Rival", oppColor, ownColor],
            ] as const
          ).map(([key, title, value, other]) => (
            <Card key={key} title={title} note={TEAM_COLORS.find((c) => c.id === value)?.label}>
              <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={`Color: ${title}`}>
                {TEAM_COLORS.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    role="radio"
                    aria-checked={value === c.id}
                    disabled={other === c.id}
                    title={other === c.id ? `${c.label}: lo usa el otro equipo` : c.label}
                    onClick={() => setPref(key, c.id)}
                    className={`grid h-10 w-10 place-items-center rounded-lg border-2 transition-colors disabled:opacity-25 ${value === c.id ? "border-ink" : "border-transparent hover:border-line-strong"}`}
                  >
                    <span className="h-6 w-6 rounded-full" style={{ background: c.value }} />
                  </button>
                ))}
              </div>
            </Card>
          ))}
          <Card title="Jugadoras sobre el video" note="Mayús + L lo cambia en la mesa">
            <div className="seg" role="group" aria-label="Cómo se marca a cada persona">
              {LABEL_STYLES.map((o) => (
                <button key={o.id} type="button" className="seg-opt" aria-pressed={labelStyle === o.id} onClick={() => setPref("labelStyle", o.id)}>
                  {o.label}
                </button>
              ))}
            </div>
          </Card>
        </div>
      )}

      {tab === "venues" && editing && (
        <Card title={editing.isNew ? "Nueva sede" : `Editar · ${editing.spec.name}`} note="se guarda en este navegador">
          <VenueEditor key={editing.spec.venue_id} initial={editing.spec} isNew={editing.isNew} onSave={saveVenue} onCancel={() => setEditing(null)} />
        </Card>
      )}

      {tab === "venues" && !editing && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-2xl text-sm text-pretty text-muted">
              Cada sede es el modelo con el que se calibra: sus medidas reales y qué líneas hay pintadas. Las posiciones se normalizan a{" "}
              {PITCH.length} × {PITCH.width} para que todos los partidos sean comparables.
            </p>
            <button type="button" className={btnPrimary} onClick={newVenue}>
              <Plus size={15} />
              Nueva sede
            </button>
          </div>
          {venues.map((v, n) => {
            const exact = v.landmarks.filter((l) => l.exact).length;
            const anchors = state.anchors.filter((a) => a.venue_id === v.venue_id).length;
            const custom = !v.builtin;
            const overrides = custom && builtinIds.has(v.venue_id);
            return (
              <Card key={v.venue_id} tone={n === 0 ? "hero" : "default"}>
                <div className="flex flex-wrap items-end justify-between gap-6">
                  <div>
                    <div className="eyebrow">
                      {v.spec.kind === "soccer" ? "Solo fútbol" : "Fútbol sobre campo de americano"}
                      {overrides ? " · editada" : custom ? " · creada aquí" : ""}
                    </div>
                    <h2 className="mt-1 text-3xl text-ink">{v.name}</h2>
                    <p className="mt-1 text-xs text-faint">
                      {anchors} cuadro(s) calibrado(s) con esta sede · <span className="tc">{v.venue_id}</span>
                    </p>
                  </div>
                  <div className="flex gap-8">
                    <div>
                      <div className="num text-5xl text-ink">
                        {v.length_m} <span className="text-2xl text-faint">×</span> {v.width_m}
                      </div>
                      <div className="mt-1.5 text-[11px] text-muted">metros reales</div>
                    </div>
                    <div>
                      <div className="num text-5xl text-accent-200">{exact}</div>
                      <div className="mt-1.5 text-[11px] text-muted">puntos de referencia exactos</div>
                    </div>
                    <div>
                      <div className="num text-5xl text-ink-2">{v.landmarks.length - exact}</div>
                      <div className="mt-1.5 text-[11px] text-muted">por verificar</div>
                    </div>
                  </div>
                </div>
                <VenueDiagram venue={v} className="mt-6 max-w-3xl" />
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <button type="button" className={btn} onClick={() => setEditing({ spec: v.spec, isNew: false })}>
                    <PencilSimple size={15} />
                    Editar medidas, rejilla y colores
                  </button>
                  {custom &&
                    (confirmDelete === v.venue_id ? (
                      <span className="text-xs text-ink-2">
                        {overrides ? "¿Volver a la sede original del código?" : `¿Borrar esta sede?${anchors ? ` Sus ${anchors} anclas quedarán sin modelo.` : ""}`}{" "}
                        <button type="button" className="font-medium text-danger underline underline-offset-2" onClick={() => removeVenue(v.venue_id)}>
                          Sí
                        </button>{" "}
                        <button type="button" className="link" onClick={() => setConfirmDelete(null)}>
                          cancelar
                        </button>
                      </span>
                    ) : (
                      <button type="button" className="btn btn-ghost" onClick={() => setConfirmDelete(v.venue_id)}>
                        {overrides ? <ArrowCounterClockwise size={15} /> : <Trash size={15} />}
                        {overrides ? "Restablecer la original" : "Borrar sede"}
                      </button>
                    ))}
                </div>
              </Card>
            );
          })}
          <p className="text-xs text-pretty text-faint">
            Cambiar una sede recalcula las anclas que la usan, porque se guardan los clics y no la matriz. Las medidas de cada partido para
            Python siguen en su <code>match.yaml</code>: si cambias aquí el largo o el ancho, actualízalo también ahí. La sede se elige en{" "}
            <Link href="/calibracion" className="link">
              Calibración
            </Link>
            .
          </p>
        </div>
      )}

      {tab === "keys" && (
        <div className="space-y-5">
          <Card title="Teclas del etiquetado" note="se usan en «Video y etiquetado» de cada partido">
            <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {EVENT_TYPES.map((t, n) => (
                <Reveal as="li" key={t} delay={n * 30} className="flex items-center justify-between gap-3 rounded-xl bg-bg/60 px-3 py-2">
                  <span className="text-sm text-ink-2">{EVENT_LABELS[t]}</span>
                  <kbd className="kbd">{EVENT_KEYS[t]}</kbd>
                </Reveal>
              ))}
              {[
                ["Equipo analizado", "A"],
                ["Equipo contrario", "S"],
              ].map(([l, k]) => (
                <li key={k} className="flex items-center justify-between gap-3 rounded-xl bg-accent-900/50 px-3 py-2">
                  <span className="text-sm text-accent-200">{l}</span>
                  <kbd className="kbd">{k}</kbd>
                </li>
              ))}
            </ul>
          </Card>
          <LockedRow
            reason="dev"
            title="Editar teclas y tipos de evento"
            why="Los tipos de evento son parte del contrato de datos, así que cambiarlos implica actualizar el contrato y sus pruebas. Un editor de teclas llegará después del contrato v2."
          />
        </div>
      )}

      {tab === "roster" && (
        <Locked
          reason="data"
          title="Plantilla de jugadoras"
          why="Alta de cada jugadora con sus datos. Es lo que desbloquea el perfil individual, el comparador, las alertas y los nombres en vez de identificadores. Todavía no hay dónde guardarla ni quién la haya capturado."
          need="definir la tabla de jugadoras en el contrato v2 y la base de datos (fase 2); después, capturar la plantilla una vez."
        >
          <div className="grid gap-5 lg:grid-cols-[1fr_18rem]">
            <div className="grid gap-3 sm:grid-cols-2">
              {Array.from({ length: 4 }, (_, n) => (
                <div key={n} className="flex items-center gap-3 rounded-2xl bg-surface/70 p-3">
                  <span className="sk h-12 w-12 rounded-full" />
                  <span className="flex-1 space-y-2">
                    <span className="sk sk-shimmer block h-2.5 w-3/4" />
                    <span className="sk block h-2 w-1/2" />
                  </span>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap content-start gap-1.5">
              {ROSTER_FIELDS.map((f) => (
                <span key={f} className="tag tag-outline">
                  {f}
                </span>
              ))}
            </div>
          </div>
        </Locked>
      )}

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

"use client";

import {
  Barbell,
  CalendarDots,
  CaretDoubleLeft,
  CaretDoubleRight,
  Database,
  DownloadSimple,
  GearSix,
  House,
  Lock,
  SoccerBall,
  Strategy,
  UsersThree,
  VideoCamera,
  type Icon,
} from "@phosphor-icons/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { revealRef } from "@/components/motion";
import { setPref, usePref, useStore } from "@/lib/store";
import { useRosterFromFile } from "@/components/RosterCard";

type NavItem = { href: string; label: string; icon: Icon; locked?: string };

// Same grouping as the design proposal. `locked` marks screens that are only a preview: the text is the reason.
const NAV: { label: string; items: NavItem[] }[] = [
  {
    label: "Análisis",
    items: [
      { href: "/", label: "Resumen", icon: House },
      { href: "/partidos", label: "Análisis con video", icon: VideoCamera },
      { href: "/pizarron", label: "Pizarrón", icon: Strategy },
      { href: "/jugadoras", label: "Jugadoras", icon: UsersThree },
    ],
  },
  {
    label: "Entrenamiento",
    items: [
      { href: "/entrenamientos", label: "Sesiones", icon: Barbell },
      { href: "/planificacion", label: "Planificación", icon: CalendarDots, locked: "Herramienta en desarrollo" },
    ],
  },
  {
    label: "Datos",
    items: [{ href: "/datos", label: "Carga de datos", icon: Database }],
  },
  {
    label: "Sistema",
    items: [{ href: "/configuracion", label: "Configuración", icon: GearSix }],
  },
];

export function Shell({ children }: { children: React.ReactNode }) {
  useRosterFromFile();
  const path = usePathname();
  const { matches, events, sessions } = useStore();
  // Icons only, to leave the width to the video. Applies from the desktop layout up; on a phone the menu is a strip.
  const collapsed = usePref("sidebar") === "icons";
  const isActive = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside
        className={`relative shrink-0 overflow-hidden border-line-soft transition-[width] duration-300 ease-out md:sticky md:top-0 md:h-screen md:border-r print:hidden ${
          collapsed ? "md:w-[4.25rem]" : "md:w-60"
        }`}
      >
        {/* Saturated ground that fades into the page, with a slow drifting glow. */}
        <div className="absolute inset-0 bg-linear-to-b from-section to-bg to-70%" />
        <div className="absolute -top-24 -left-16 h-64 w-64 rounded-full bg-accent/25 blur-3xl" />
        <div className="relative flex h-full flex-col gap-5 px-3 py-4 md:gap-7 md:py-6">
          <Link href="/" className="flex items-center gap-2.5 px-2" title="Rendimiento · inicio">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-accent-400/70 text-accent-300">
              <SoccerBall size={20} />
            </span>
            <span className={`flex flex-col leading-tight whitespace-nowrap ${collapsed ? "md:hidden" : ""}`}>
              <span className="font-display text-[15px] font-medium text-ink">Rendimiento</span>
              <span className="text-[11px] text-muted">Fútbol femenil · MVP</span>
            </span>
          </Link>

          <nav aria-label="Secciones" className="flex gap-4 overflow-x-auto md:flex-col md:gap-5 md:overflow-visible">
            {NAV.map((g) => (
              <div key={g.label} className="flex shrink-0 gap-0.5 md:flex-col">
                <span className={`eyebrow hidden px-3 pb-1 text-[11px] text-faint ${collapsed ? "" : "md:block"}`}>{g.label}</span>
                {g.items.map((n) => {
                  const active = isActive(n.href);
                  const I = n.icon;
                  return (
                    <Link
                      key={n.href}
                      href={n.href}
                      title={collapsed ? `${n.label}${n.locked ? ` · ${n.locked}` : ""}` : n.locked}
                      aria-current={active ? "page" : undefined}
                      className={`group relative flex items-center gap-2.5 rounded-full px-3 py-2 text-[13px] font-medium whitespace-nowrap transition-[background-color,color,padding] duration-200 ${
                        active
                          ? "bg-accent/20 text-accent-100 shadow-[inset_0_0_0_1px_rgba(74,114,255,.55)]"
                          : `text-muted hover:bg-accent/10 hover:text-ink ${collapsed ? "" : "hover:pl-4"}`
                      } ${collapsed ? "md:justify-center md:px-0" : ""}`}
                    >
                      <I size={17} weight={active ? "fill" : "regular"} className="shrink-0" />
                      <span className={collapsed ? "md:sr-only" : ""}>{n.label}</span>
                      {n.locked && (
                        <Lock size={12} className={`shrink-0 text-warn/80 ${collapsed ? "ml-auto md:absolute md:top-1 md:right-2.5 md:ml-0" : "ml-auto"}`} aria-label={n.locked} />
                      )}
                    </Link>
                  );
                })}
              </div>
            ))}
          </nav>

          <div className={`mt-auto hidden rounded-2xl bg-bg/50 p-3 text-[11px] leading-snug text-muted ${collapsed ? "" : "md:block"}`}>
            <div className="mb-1 flex items-center gap-1.5 text-ink-2">
              <span className="h-1.5 w-1.5 rounded-full bg-ok" />
              Datos en este navegador
            </div>
            {matches.length} partidos · {events.length} eventos · {sessions.length} filas de sensores
          </div>
          <button
            type="button"
            onClick={() => setPref("sidebar", collapsed ? "full" : "icons")}
            aria-pressed={collapsed}
            title={collapsed ? "Mostrar el menú completo" : "Dejar solo los iconos"}
            className={`hidden items-center gap-2.5 rounded-full px-3 py-2 text-[13px] text-muted transition-colors hover:bg-accent/10 hover:text-ink md:flex ${
              collapsed ? "mt-auto justify-center px-0" : ""
            }`}
          >
            {collapsed ? <CaretDoubleRight size={16} /> : <CaretDoubleLeft size={16} />}
            <span className={collapsed ? "sr-only" : ""}>Ocultar menú</span>
          </button>
        </div>
      </aside>

      <main className="relative min-w-0 flex-1 px-4 pt-4 pb-16 md:px-10 md:pt-5 print:p-0">
        <div
          className={`scroll-progress fixed top-0 right-0 left-0 z-20 h-0.5 bg-linear-to-r from-accent-700 via-accent to-accent-300 print:hidden ${
            collapsed ? "md:left-[4.25rem]" : "md:left-60"
          }`}
        />
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 text-xs text-muted md:mb-9 print:hidden">
          <span className="flex flex-wrap items-center gap-x-5 gap-y-1">
            <span>Versión MVP · eventos etiquetados a mano</span>
            <span className="text-faint">Sin cuentas: todo vive en este navegador</span>
          </span>
          <Link href="/datos" className="btn">
            <DownloadSimple size={15} />
            Respaldo y carga
          </Link>
        </div>
        {/* Keyed by route so the entrance animation replays on every navigation. */}
        <div key={path}>{children}</div>
      </main>
    </div>
  );
}

type HeaderProps = { eyebrow?: string; title: React.ReactNode; subtitle?: React.ReactNode; children?: React.ReactNode };

export function PageHeader({ eyebrow, title, subtitle, children }: HeaderProps) {
  return (
    <header className="mb-8 flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
      <div className="min-w-0">
        {eyebrow && <div className="eyebrow enter">{eyebrow}</div>}
        <h1 className="enter mt-1 text-4xl leading-[1.05] text-ink md:text-5xl" style={{ "--d": "60ms" } as React.CSSProperties}>
          {title}
        </h1>
        {subtitle && (
          <p className="enter mt-3 max-w-2xl text-sm text-pretty text-muted" style={{ "--d": "130ms" } as React.CSSProperties}>
            {subtitle}
          </p>
        )}
      </div>
      {children && (
        <div className="enter flex flex-wrap items-center gap-2" style={{ "--d": "180ms" } as React.CSSProperties}>
          {children}
        </div>
      )}
    </header>
  );
}

type CardProps = {
  title?: React.ReactNode;
  // Small note at the right of the title (units, scope, how to read it).
  note?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  tone?: "default" | "hero";
  // Milliseconds; staggers cards that enter together.
  delay?: number;
};

export function Card({ title, note, children, className = "", tone = "default", delay = 0 }: CardProps) {
  return (
    <section
      ref={revealRef}
      className={`card reveal ${tone === "hero" ? "card-hero" : ""} ${className}`}
      style={delay ? ({ "--d": `${delay}ms` } as React.CSSProperties) : undefined}
    >
      {title && (
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h2 className="text-base text-ink">{title}</h2>
          {note && <span className="text-[11px] text-faint">{note}</span>}
        </div>
      )}
      {children}
    </section>
  );
}

// Unboxed group: a title with a rule that fades out, then the content straight on the page.
export function Section({ title, note, children, className = "" }: { title: string; note?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={className}>
      <div className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-xl text-ink">{title}</h2>
        {note && <span className="text-xs text-faint">{note}</span>}
        <span className="hr-fade-l min-w-8 self-center" />
      </div>
      {children}
    </section>
  );
}

export function DemoBadge() {
  return <span className="tag tag-warn">Datos de ejemplo</span>;
}

export const btn = "btn";
export const btnPrimary = "btn btn-primary";
export const input = "input";

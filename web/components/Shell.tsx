"use client";

import {
  Barbell,
  CalendarDots,
  Database,
  GearSix,
  House,
  Moon,
  Strategy,
  Sun,
  UsersThree,
  VideoCamera,
  type Icon,
} from "@phosphor-icons/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { revealRef } from "@/components/motion";
import { setPref, usePref } from "@/lib/store";
import { useThemeSync } from "@/lib/theme";
import { useRosterFromFile } from "@/components/RosterCard";

type NavItem = { href: string; label: string; icon: Icon; locked?: string };

// Icon rail: the width goes to the video. Each icon names itself on hover; `locked` marks a screen that is only a
// preview (the text is the reason).
const NAV: NavItem[] = [
  { href: "/", label: "Inicio", icon: House },
  { href: "/partidos", label: "Partidos", icon: VideoCamera },
  { href: "/jugadoras", label: "Jugadoras", icon: UsersThree },
  { href: "/entrenamientos", label: "Sesiones", icon: Barbell },
  { href: "/planificacion", label: "Calendario", icon: CalendarDots, locked: "en desarrollo" },
  { href: "/pizarron", label: "Pizarrón", icon: Strategy },
];
const NAV_END: NavItem[] = [
  { href: "/datos", label: "Datos", icon: Database },
  { href: "/configuracion", label: "Configuración", icon: GearSix },
];

function RailLink({ n, active }: { n: NavItem; active: boolean }) {
  const I = n.icon;
  return (
    <Link
      href={n.href}
      aria-label={n.label}
      aria-current={active ? "page" : undefined}
      className={`group relative grid h-10 w-10 shrink-0 place-items-center rounded-lg transition-colors ${
        active ? "bg-line-strong text-ink" : "text-faint hover:bg-raised hover:text-ink"
      }`}
    >
      <I size={20} weight={active ? "fill" : "regular"} />
      {n.locked && <span className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-warn" aria-hidden />}
      <span className="pointer-events-none absolute left-12 z-30 hidden rounded-md bg-ink px-2 py-1 text-xs font-medium whitespace-nowrap text-bg shadow-lg group-hover:md:block group-focus-visible:md:block">
        {n.label}
        {n.locked && <span className="opacity-70"> · {n.locked}</span>}
      </span>
    </Link>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  useRosterFromFile();
  useThemeSync();
  const path = usePathname();
  const light = usePref("theme", "dark") === "light";
  const isActive = (href: string) => (href === "/" ? path === "/" : path.startsWith(href) || (href === "/partidos" && path.startsWith("/partido")));

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="sticky top-0 z-20 shrink-0 border-b border-line bg-bg md:h-screen md:w-14 md:border-r md:border-b-0 print:hidden">
        <nav aria-label="Secciones" className="flex h-full items-center gap-1 overflow-x-auto px-2 py-1.5 md:flex-col md:overflow-visible md:px-0 md:py-3">
          <Link href="/" aria-label="Rendimiento · inicio" className="mr-2 grid h-9 w-9 shrink-0 place-items-center md:mr-0 md:mb-3">
            <svg width="24" height="18" viewBox="0 0 26 20" aria-hidden>
              <rect x="0" y="0" width="12" height="20" rx="2" fill="var(--color-own)" />
              <rect x="14" y="0" width="12" height="20" rx="2" fill="var(--color-ink)" />
            </svg>
          </Link>
          {NAV.map((n) => (
            <RailLink key={n.href} n={n} active={isActive(n.href)} />
          ))}
          <span className="flex-1" />
          {NAV_END.map((n) => (
            <RailLink key={n.href} n={n} active={isActive(n.href)} />
          ))}
          <button
            type="button"
            onClick={() => setPref("theme", light ? "dark" : "light")}
            aria-label={light ? "Tema oscuro" : "Tema claro"}
            title={light ? "Tema oscuro" : "Tema claro"}
            className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-faint transition-colors hover:bg-raised hover:text-ink"
          >
            {light ? <Moon size={19} /> : <Sun size={19} />}
          </button>
        </nav>
      </aside>

      <main className="relative min-w-0 flex-1 px-4 pt-5 pb-16 md:px-8 print:p-0">
        {/* Keyed by route so each screen starts from the top state. */}
        <div key={path}>{children}</div>
      </main>
    </div>
  );
}

type HeaderProps = { eyebrow?: string; title: React.ReactNode; subtitle?: React.ReactNode; children?: React.ReactNode };

export function PageHeader({ eyebrow, title, subtitle, children }: HeaderProps) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        {eyebrow && <div className="text-xs text-faint">{eyebrow}</div>}
        <h1 className="mt-0.5 text-2xl leading-tight text-ink">{title}</h1>
        {subtitle && <p className="mt-1.5 max-w-2xl text-sm text-pretty text-muted">{subtitle}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
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
          <h2 className="text-[15px] text-ink">{title}</h2>
          {note && <span className="text-xs text-faint">{note}</span>}
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
      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="sec-tag">{title}</h2>
        <span className="hr-fade-l min-w-8" />
        {note && <span className="text-xs text-faint">{note}</span>}
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

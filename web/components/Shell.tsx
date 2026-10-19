"use client";

import {
  Barbell,
  CalendarDots,
  CaretDoubleLeft,
  CaretDoubleRight,
  ChartBar,
  Crosshair,
  Database,
  FilmSlate,
  GearSix,
  House,
  ListDashes,
  Moon,
  Sun,
  UsersThree,
  type Icon,
} from "@phosphor-icons/react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { revealRef } from "@/components/motion";
import { setPref, usePref, useStore } from "@/lib/store";
import type { Match, MatchEvent } from "@/lib/types";
import { useThemeSync } from "@/lib/theme";
import { useRosterFromFile } from "@/components/RosterCard";
import { TEAM_SECTIONS } from "@/lib/features";
import { EdgeReveal, useFocusMode } from "@/components/FocusMode";

type NavItem = { href: string; label: string; icon: Icon; locked?: string; disabled?: string; active: boolean };

// One entry of the sidebar: icon only (its name shows on hover) or icon and name when the sidebar is open.
function NavLink({ n, open }: { n: NavItem; open: boolean }) {
  const I = n.icon;
  const cls = `group relative flex h-10 shrink-0 items-center gap-3 rounded-lg transition-colors duration-150 ${open ? "w-full px-3" : "w-10 justify-center"} ${
    n.active ? "bg-line-strong text-ink" : n.disabled ? "text-faint/50" : "text-faint hover:bg-raised hover:text-ink"
  }`;
  const body = (
    <>
      <I size={20} weight={n.active ? "fill" : "regular"} className="shrink-0" />
      {open && <span className="truncate text-sm font-medium">{n.label}</span>}
      {n.locked && <span className={`absolute h-1.5 w-1.5 rounded-full bg-warn ${open ? "right-3" : "top-1.5 right-1.5"}`} aria-hidden />}
      {!open && (
        <span className="pointer-events-none absolute left-12 z-30 hidden rounded-md bg-ink px-2 py-1 text-xs font-medium whitespace-nowrap text-bg shadow-lg group-hover:md:block group-focus-visible:md:block">
          {n.label}
          {(n.locked || n.disabled) && <span className="opacity-70"> · {n.locked ?? n.disabled}</span>}
        </span>
      )}
    </>
  );
  if (n.disabled) {
    return (
      <span className={cls} aria-disabled title={open ? n.disabled : undefined}>
        {body}
      </span>
    );
  }
  return (
    <Link href={n.href} aria-label={n.label} aria-current={n.active ? "page" : undefined} className={cls}>
      {body}
    </Link>
  );
}

// The match the three modes below work on: its teams and score, as a small scoreboard. With the sidebar folded, the
// score alone (or both initials before any goal), the name on hover.
function CurrentMatch({ match, events, open, active }: { match: Match | undefined; events: MatchEvent[]; open: boolean; active: boolean }) {
  if (!match) return open ? <p className="m-0 px-2 py-1 text-[11px] text-faint">Elige un partido en Resumen</p> : null;
  const goals = events.filter((e) => e.match_id === match.match_id && e.type === "goal");
  const own = goals.filter((e) => e.team === "own").length;
  const opp = goals.filter((e) => e.team === "opp").length;
  const initials = (s: string) => s.trim().split(/\s+/).map((w) => w[0]).join("").slice(0, 3).toUpperCase();
  const date = match.date ? new Date(`${match.date}T12:00:00`).toLocaleDateString("es-MX", { day: "numeric", month: "short" }) : "";
  const ring = active ? "shadow-[inset_0_0_0_1px_var(--color-own)]" : "shadow-[inset_0_0_0_1px_var(--color-line)] hover:shadow-[inset_0_0_0_1px_var(--color-line-strong)]";
  const href = `/partido?id=${encodeURIComponent(match.match_id)}`;
  if (!open)
    return (
      <Link href={href} title={`${match.name}${date ? ` · ${date}` : ""}`} aria-label={`Partido elegido: ${match.name}`} className={`cond grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-bg/70 text-[11px] leading-none font-extrabold text-ink uppercase transition-shadow ${ring}`}>
        {goals.length ? (
          <span className="tabular-nums">
            {own}–{opp}
          </span>
        ) : (
          <span className="flex flex-col items-center gap-0.5">
            <span className="text-own">{initials(match.focus_team)}</span>
            <span className="text-faint">{initials(match.other_team)}</span>
          </span>
        )}
      </Link>
    );
  return (
    <Link href={href} title="Abrir el partido" aria-label={`Partido elegido: ${match.name}`} className={`my-0.5 flex items-stretch gap-2 rounded-lg bg-bg/70 px-2 py-1.5 transition-shadow ${ring}`}>
      <span className="flex flex-col justify-center gap-1" aria-hidden>
        <i className="h-3 w-1 rounded-full bg-own" />
        <i className="h-3 w-1 rounded-full bg-opp" />
      </span>
      <span className="cond flex min-w-0 flex-1 flex-col justify-center text-[13px] leading-tight font-bold text-ink uppercase">
        <span className="truncate">{match.focus_team}</span>
        <span className="truncate text-ink-2">{match.other_team}</span>
      </span>
      <span className="flex flex-col items-end justify-center">
        <span className="cond text-base leading-none font-extrabold text-ink tabular-nums">{goals.length ? `${own}–${opp}` : "–"}</span>
        {date && <span className="mt-0.5 text-[10px] text-faint">{date}</span>}
      </span>
    </Link>
  );
}

function Sidebar() {
  const path = usePathname();
  const params = useSearchParams();
  const { matches, events } = useStore();
  const light = usePref("theme", "dark") === "light";
  const open = usePref("sidebar", "icons") === "full";
  const current = usePref("currentMatch", "");
  const match = matches.find((m) => m.match_id === current);
  const onMatch = path.startsWith("/partido") && !path.startsWith("/partidos");
  const modo = params.get("modo");
  const at = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  const toMatch = (m: string) => (match ? `/partido?id=${encodeURIComponent(match.match_id)}&modo=${m}` : "/partidos");

  const top: NavItem[] = [{ href: "/", label: "Inicio", icon: House, active: at("/") }];
  // The match being worked on: choose it in Resumen, then its three modes.
  const matchNav: NavItem[] = [
    { href: "/partidos", label: "Resumen", icon: ListDashes, active: at("/partidos") },
    ...(
      [
        ["captura", "Captura", Crosshair],
        ["estudio", "Estudio", FilmSlate],
        ["analisis", "Análisis", ChartBar],
      ] as const
    ).map(([m, label, icon]) => ({
      href: toMatch(m),
      label,
      icon,
      active: onMatch && modo === m,
      disabled: match ? undefined : "elige un partido en Resumen",
    })),
  ];
  const team: NavItem[] = !TEAM_SECTIONS ? [] : [
    { href: "/jugadoras", label: "Jugadoras", icon: UsersThree, active: at("/jugadoras") },
    { href: "/entrenamientos", label: "Sesiones", icon: Barbell, active: at("/entrenamientos") },
    { href: "/planificacion", label: "Calendario", icon: CalendarDots, locked: "en desarrollo", active: at("/planificacion") },
  ];
  const end: NavItem[] = [
    { href: "/datos", label: "Datos", icon: Database, active: at("/datos") },
    { href: "/configuracion", label: "Configuración", icon: GearSix, active: at("/configuracion") },
  ];

  return (
    <aside
      className={`sticky top-0 z-20 shrink-0 border-b border-line bg-bg transition-[width] duration-200 ease-out md:h-screen md:border-r md:border-b-0 print:hidden ${
        open ? "md:w-56" : "md:w-14"
      }`}
    >
      <nav aria-label="Secciones" className={`flex h-full items-center gap-1 overflow-x-auto px-2 py-1.5 md:flex-col md:overflow-visible md:py-3 ${open ? "md:items-stretch md:px-3" : "md:px-0"}`}>
        <Link href="/" aria-label="Rendimiento · inicio" className={`mr-2 flex h-9 shrink-0 items-center gap-2.5 md:mr-0 md:mb-3 ${open ? "px-2" : "w-9 justify-center"}`}>
          <svg width="24" height="18" viewBox="0 0 26 20" aria-hidden>
            <rect x="0" y="0" width="12" height="20" rx="2" fill="var(--color-own)" />
            <rect x="14" y="0" width="12" height="20" rx="2" fill="var(--color-ink)" />
          </svg>
          {open && <span className="cond text-lg font-extrabold tracking-wide text-ink uppercase">Rendimiento</span>}
        </Link>
        {top.map((n) => (
          <NavLink key={n.label} n={n} open={open} />
        ))}
        {/* The match section: one block, so its four entries read as one group. */}
        <div className={`flex gap-1 rounded-xl bg-surface p-1 md:my-2 md:flex-col ${open ? "" : "md:items-center"}`} role="group" aria-label="Partidos">
          {open && <div className="cond px-2 pt-1 text-xs font-bold text-faint uppercase">Partidos</div>}
          <NavLink n={matchNav[0]} open={open} />
          <CurrentMatch match={match} events={events} open={open} active={onMatch} />
          {matchNav.slice(1).map((n) => (
            <NavLink key={n.label} n={n} open={open} />
          ))}
        </div>
        {team.map((n) => (
          <NavLink key={n.label} n={n} open={open} />
        ))}
        <span className="flex-1" />
        {end.map((n) => (
          <NavLink key={n.label} n={n} open={open} />
        ))}
        <div className={`flex gap-1 ${open ? "md:flex-row" : "md:flex-col md:items-center"}`}>
          <button
            type="button"
            onClick={() => setPref("theme", light ? "dark" : "light")}
            aria-label={light ? "Tema oscuro" : "Tema claro"}
            title={light ? "Tema oscuro" : "Tema claro"}
            className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-faint transition-colors hover:bg-raised hover:text-ink"
          >
            {light ? <Moon size={19} /> : <Sun size={19} />}
          </button>
          <button
            type="button"
            onClick={() => setPref("sidebar", open ? "icons" : "full")}
            aria-label={open ? "Solo iconos" : "Mostrar nombres"}
            title={open ? "Solo iconos" : "Mostrar nombres"}
            className="hidden h-10 w-10 shrink-0 place-items-center rounded-lg text-faint transition-colors hover:bg-raised hover:text-ink md:grid"
          >
            {open ? <CaretDoubleLeft size={17} /> : <CaretDoubleRight size={17} />}
          </button>
        </div>
      </nav>
    </aside>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  useRosterFromFile();
  useThemeSync();
  const path = usePathname();
  const focus = useFocusMode();

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <EdgeReveal edge="left" enabled={focus}>
        <Suspense fallback={<aside className="shrink-0 border-r border-line md:h-screen md:w-14" />}>
          <Sidebar />
        </Suspense>
      </EdgeReveal>

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

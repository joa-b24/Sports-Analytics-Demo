"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  { href: "/", label: "Inicio", hint: "" },
  { href: "/rivales", label: "Rivales", hint: "Análisis previo" },
  { href: "/partidos", label: "Nuestros partidos", hint: "Post-partido" },
  { href: "/entrenamientos", label: "Entrenamientos", hint: "Sensores" },
  { href: "/calibracion", label: "Calibración", hint: "Cancha y tracking" },
  { href: "/datos", label: "Datos", hint: "Cargar y exportar" },
];

export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="shrink-0 bg-slate-900 text-slate-200 md:w-56 print:hidden">
        <div className="px-5 pt-5 pb-3">
          <div className="text-base font-semibold tracking-tight text-white">Sports Analytics</div>
          <div className="text-xs text-slate-400">Fútbol · MVP</div>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-2 pb-3 md:flex-col">
          {NAV.map((n) => {
            const active = n.href === "/" ? path === "/" : path.startsWith(n.href);
            return (
              <Link
                key={n.href}
                href={n.href}
                className={`rounded-md px-3 py-2 text-sm whitespace-nowrap transition-colors ${
                  active ? "bg-slate-700 text-white" : "text-slate-300 hover:bg-slate-800"
                }`}
              >
                <div className="font-medium">{n.label}</div>
                {n.hint && <div className="hidden text-xs text-slate-400 md:block">{n.hint}</div>}
              </Link>
            );
          })}
        </nav>
      </aside>
      <main className="min-w-0 flex-1 px-4 py-6 md:px-8 print:p-0">{children}</main>
    </div>
  );
}

export function PageHeader({ title, subtitle, children }: { title: string; subtitle?: string; children?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{title}</h1>
        {subtitle && <p className="mt-1 max-w-2xl text-sm text-slate-600">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

export function Card({ title, children, className = "" }: { title?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-slate-200 bg-white p-4 ${className}`}>
      {title && <h2 className="mb-3 text-sm font-semibold text-slate-900">{title}</h2>}
      {children}
    </section>
  );
}

export function DemoBadge() {
  return (
    <span className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-900">
      Datos de ejemplo
    </span>
  );
}

export const btn =
  "rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50";
export const btnPrimary =
  "rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50";
export const input =
  "rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 placeholder:text-slate-400";

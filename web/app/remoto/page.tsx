"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { PageHeader } from "@/components/Shell";
import { listLocal, readLocal } from "@/lib/local";

// Inicio del acceso remoto (celular o tableta): estado de la cola del balón que corre en la laptop y los tres trabajos.
// Solo lee la carpeta del repo (matches/<id>/tracking): ni ejecuta ni escribe nada.

type Row = { match: string; part: string; done: boolean; line: string };
const PART = /^tracks_(v\d+)_(\d+)_(\d+)\.json$/;

async function scan(): Promise<Row[]> {
  const rows: Row[] = [];
  for (const d of ((await listLocal("matches")) ?? []).filter((f) => f.dir)) {
    const files = (await listLocal(`matches/${d.name}/tracking`)) ?? [];
    const names = new Set(files.map((f) => f.name));
    for (const f of files) {
      const m = PART.exec(f.name);
      if (!m) continue;
      const stem = f.name.replace(/^tracks_/, "").replace(/\.json$/, "");
      const done = names.has(`ball_auto_${stem}.json`);
      let line = "";
      if (!done) {
        const log = await readLocal(`matches/${d.name}/tracking/revision/progreso_ball_${stem}.log`);
        line = log ? (log.trim().split("\n").pop() ?? "") : "";
      }
      rows.push({ match: d.name, part: stem, done, line });
    }
  }
  return rows;
}

const TASKS = [
  { href: "/revision", title: "Balón: verdad de los clips", hint: "Toca el balón en cada cuadro; botones grandes abajo." },
  { href: "/partidos", title: "Eventos y uniones", hint: "Abre un partido: pestañas Captura y Estudio." },
];

export default function Page() {
  const [rows, setRows] = useState<Row[] | null>(null);
  useEffect(() => {
    let live = true;
    const tick = () => void scan().then((r) => live && setRows(r));
    tick();
    const id = window.setInterval(tick, 15000);
    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, []);
  const running = rows?.find((r) => !r.done && r.line && !r.line.includes(" 100% "));
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <PageHeader title="Acceso remoto" />
      <div className="grid gap-3">
        {TASKS.map((t) => (
          <Link key={t.href} href={t.href} className="card block p-4">
            <div className="text-base font-semibold text-ink">{t.title}</div>
            <div className="text-sm text-muted">{t.hint}</div>
          </Link>
        ))}
      </div>
      <section className="card p-4">
        <h2 className="mb-2 text-base font-semibold text-ink">Detección de balón en la laptop</h2>
        {!rows ? (
          <p className="text-sm text-faint">Leyendo…</p>
        ) : (
          <>
            <p className="mb-2 text-sm text-ink-2">
              {rows.filter((r) => r.done).length} de {rows.length} partes listas.{running ? ` Ahora: ${running.part} — ${running.line}` : ""}
            </p>
            <ul className="space-y-1 text-sm">
              {rows.map((r) => (
                <li key={r.match + r.part} className="flex justify-between gap-3">
                  <span className="truncate text-ink-2">
                    {r.match.slice(0, 10)} {r.part}
                  </span>
                  <span className={r.done ? "text-accent" : "text-faint"}>{r.done ? "lista" : r.line ? "en curso" : "en cola"}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}

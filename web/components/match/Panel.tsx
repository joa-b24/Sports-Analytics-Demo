"use client";

import { DownloadSimple, FileText, PresentationChart } from "@phosphor-icons/react";
import { createContext, useContext, useRef, useState } from "react";
import { Card } from "@/components/Shell";
import { slidesOf, upsertChartSlide } from "@/lib/deck";
import { normalizeReport } from "@/lib/report";
import { withExtra } from "@/lib/reportSections";
import { mutate, uid, useStore } from "@/lib/store";

// The match the panels belong to: «A la presentación» and «Al informe» need it to know whose deck and report get the chart.
export const PanelMatch = createContext<string | null>(null);

const slug = (t: string) =>
  t
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "grafico";

type Sent = "deck" | "report" | null;

// The three tools of a chart: save it as an image (PNG, with the colours of the app), put it in the presentation and put it
// in the report. Sending the same chart again refreshes the slide (or section) it already made, never repeats it, and the
// button says it is already there.
// The tools as a hook: `box` is the element drawn into the image; `withReport` adds the «al informe» button (the report's own
// sections do not need it). Panel and the sections of the report share it.
export function usePanelTools(title: string, box: React.RefObject<HTMLElement | null>, note?: React.ReactNode, withReport = true) {
  const id = slug(title);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<Sent>(null);
  const matchId = useContext(PanelMatch);
  const state = useStore();
  const inDeck = !!matchId && slidesOf(state.decks, matchId).some((s) => s.source === id);
  const inReport = !!matchId && !!state.matches.find((m) => m.match_id === matchId)?.report?.extras?.some((x) => x.source === id);

  const draw = async () => {
    const { toPng } = await import("html-to-image");
    const bg = getComputedStyle(document.body).backgroundColor;
    return toPng(box.current as HTMLElement, { pixelRatio: 2, backgroundColor: bg, filter: (n) => !(n instanceof HTMLElement && n.dataset.noCapture !== undefined) });
  };
  const run = async (what: "save" | "deck" | "report") => {
    if (!box.current || busy) return;
    if ((what === "deck" || what === "report") && !matchId) return;
    setBusy(true);
    try {
      const image = await draw();
      if (what === "save") {
        const a = document.createElement("a");
        a.href = image;
        a.download = `${id}.png`;
        a.click();
        return;
      }
      if (what === "deck") {
        mutate((st) => ({ ...st, decks: upsertChartSlide(st.decks, matchId as string, { id: uid("sl"), title, note: "", image, source: id, at: Date.now() }) }));
      } else {
        mutate((st) => ({
          ...st,
          matches: st.matches.map((m) => (m.match_id === matchId ? { ...m, report: withExtra(normalizeReport(m.report), { id: uid("x"), title, image, source: id }) } : m)),
        }));
      }
      setFlash(what);
      setTimeout(() => setFlash(null), 1800);
    } catch {
      // A card that cannot be drawn (blocked fonts, huge SVG): nothing is saved and the button comes back.
    } finally {
      setBusy(false);
    }
  };

  const tools = (
    <span data-no-capture className="inline-flex items-center gap-1 align-middle">
      {note && <span className="mr-1">{note}</span>}
      {matchId && (
        <button
          type="button"
          className={`btn btn-ghost !p-1 ${inDeck ? "text-ok" : ""}`}
          aria-label={inDeck ? "Ya está en la presentación: actualizar" : "Añadir a la presentación"}
          title={flash === "deck" ? "Listo: en la presentación" : inDeck ? "Ya está en la presentación: clic para actualizar su imagen" : "Añadir a la presentación"}
          disabled={busy}
          onClick={() => void run("deck")}
        >
          <PresentationChart size={14} weight={inDeck ? "fill" : "regular"} />
        </button>
      )}
      {matchId && withReport && (
        <button
          type="button"
          className={`btn btn-ghost !p-1 ${inReport ? "text-ok" : ""}`}
          aria-label={inReport ? "Ya está en el informe: actualizar" : "Añadir al informe"}
          title={flash === "report" ? "Listo: en el informe" : inReport ? "Ya está en el informe: clic para actualizar su imagen" : "Añadir al informe como sección"}
          disabled={busy}
          onClick={() => void run("report")}
        >
          <FileText size={14} weight={inReport ? "fill" : "regular"} />
        </button>
      )}
      <button type="button" className="btn btn-ghost !p-1" aria-label="Guardar como imagen" title="Guardar como imagen" disabled={busy} onClick={() => void run("save")}>
        <DownloadSimple size={14} />
      </button>
    </span>
  );

  return tools;
}

export function Panel({ title, note, children, className = "", delay = 0 }: { title: string; note?: React.ReactNode; children: React.ReactNode; className?: string; delay?: number; defaultWide?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const tools = usePanelTools(title, box, note);
  return (
    <div ref={box} className={`min-w-0 ${className}`}>
      <Card title={title} note={tools} delay={delay} className="h-full">
        {children}
      </Card>
    </div>
  );
}

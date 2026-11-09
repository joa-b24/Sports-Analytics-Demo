"use client";

import { ArrowsInSimple, ArrowsOutSimple, DownloadSimple, PresentationChart } from "@phosphor-icons/react";
import { createContext, useContext, useRef, useState } from "react";
import { Card } from "@/components/Shell";
import { addSlide } from "@/lib/deck";
import { mutate, setPref, uid, usePref } from "@/lib/store";

// The match the panels belong to: «A la presentación» needs it to know whose deck gets the slide.
export const PanelMatch = createContext<string | null>(null);

const slug = (t: string) =>
  t
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "grafico";

// A card of the analysis dashboard: the same card, plus two tools the analyst uses before showing it — make it as wide as
// the row (remembered per card in this browser) and save it as an image (PNG, with the colours of the app).
export function Panel({ title, note, children, className = "", delay = 0, defaultWide = false }: { title: string; note?: React.ReactNode; children: React.ReactNode; className?: string; delay?: number; defaultWide?: boolean }) {
  const id = slug(title);
  const wide = usePref(`analysis:size:${id}`, defaultWide ? "wide" : "normal") === "wide";
  const box = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState(false);
  const matchId = useContext(PanelMatch);

  const draw = async () => {
    const { toPng } = await import("html-to-image");
    const bg = getComputedStyle(document.body).backgroundColor;
    return toPng(box.current as HTMLElement, { pixelRatio: 2, backgroundColor: bg, filter: (n) => !(n instanceof HTMLElement && n.dataset.noCapture !== undefined) });
  };
  const save = async () => {
    if (!box.current || busy) return;
    setBusy(true);
    try {
      const a = document.createElement("a");
      a.href = await draw();
      a.download = `${id}.png`;
      a.click();
    } catch {
      // A card that cannot be drawn (blocked fonts, huge SVG): nothing is saved and the button comes back.
    } finally {
      setBusy(false);
    }
  };
  const toDeck = async () => {
    if (!box.current || busy || !matchId) return;
    setBusy(true);
    try {
      const image = await draw();
      mutate((st) => ({ ...st, decks: addSlide(st.decks, matchId, { id: uid("sl"), title, note: "", image, at: Date.now() }) }));
      setAdded(true);
      setTimeout(() => setAdded(false), 2000);
    } catch {
      // See save().
    } finally {
      setBusy(false);
    }
  };

  const tools = (
    <span data-no-capture className="inline-flex items-center gap-1 align-middle">
      {note && <span className="mr-1">{note}</span>}
      <button type="button" className="btn btn-ghost !p-1" aria-label={wide ? "Tamaño normal" : "Ocupar todo el ancho"} title={wide ? "Tamaño normal" : "Ocupar todo el ancho"} onClick={() => setPref(`analysis:size:${id}`, wide ? "normal" : "wide")}>
        {wide ? <ArrowsInSimple size={14} /> : <ArrowsOutSimple size={14} />}
      </button>
      {matchId && (
        <button type="button" className="btn btn-ghost !p-1" aria-label="Añadir a la presentación" title={added ? "Añadida a la presentación" : "Añadir a la presentación"} disabled={busy} onClick={() => void toDeck()}>
          <PresentationChart size={14} weight={added ? "fill" : "regular"} />
        </button>
      )}
      <button type="button" className="btn btn-ghost !p-1" aria-label="Guardar como imagen" title="Guardar como imagen" disabled={busy} onClick={() => void save()}>
        <DownloadSimple size={14} />
      </button>
    </span>
  );

  return (
    <div ref={box} className={`min-w-0 ${wide ? "col-span-full" : ""} ${className}`}>
      <Card title={title} note={tools} delay={delay} className="h-full">
        {children}
      </Card>
    </div>
  );
}

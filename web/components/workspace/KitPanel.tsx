"use client";

import { Eyedropper, FloppyDisk } from "@phosphor-icons/react";
import { useState } from "react";
import { COLORS } from "@/components/Pitch";
import { readLocal, writeLocal } from "@/lib/local";
import { mutate, useStore } from "@/lib/store";
import { hexToLab, type JerseyColors, type JerseyKey } from "@/lib/tracks";

// The colours of the shirts of a match (jersey_colors in match.yaml): the processing uses them to put each person in
// her team. Chosen before processing, with a click on a shirt in the video of the calibration.

export const KIT_LABELS: Record<JerseyKey, string> = { own: "Analizado", own_gk: "Su portera", opp: "Contrario", opp_gk: "Su portera", ref: "Árbitra" };
export const KIT_ORDER: JerseyKey[] = ["own", "own_gk", "opp", "opp_gk", "ref"];
const KIT_COLOR: Record<JerseyKey, string> = { own: COLORS.own, own_gk: COLORS.own, opp: COLORS.opp, opp_gk: COLORS.opp, ref: "var(--color-warn)" };
const NO_COLORS: JerseyColors = { own: "", opp: "", ref: "", own_gk: "", opp_gk: "" };

// Median colour of a 9 x 9 patch of the video under a click, or null (and why) when it is grass rather than a shirt.
export function sampleShirt(v: HTMLVideoElement, clientX: number, clientY: number): { hex: string } | { error: string } {
  const r = v.getBoundingClientRect();
  const x = Math.round(((clientX - r.left) / r.width) * v.videoWidth);
  const y = Math.round(((clientY - r.top) / r.height) * v.videoHeight);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 9;
  const ctx = canvas.getContext("2d");
  if (!ctx) return { error: "Este navegador no deja leer el video." };
  ctx.drawImage(v, x - 4, y - 4, 9, 9, 0, 0, 9, 9);
  const px = ctx.getImageData(0, 0, 9, 9).data;
  const med = [0, 1, 2].map((c) => Array.from({ length: 81 }, (_, i) => px[i * 4 + c]).sort((a, b) => a - b)[40]);
  const hex = `#${med.map((n) => n.toString(16).padStart(2, "0")).join("")}`;
  const lab = hexToLab(hex);
  if (lab && lab[1] < 120 && lab[2] > 132) return { error: "Ese punto parece césped, no una camiseta: clic en el centro del torso." };
  return { hex };
}

export function useKits(matchId: string | undefined) {
  const state = useStore();
  const mid = matchId ?? "";
  const colors = state.jerseys[mid] || NO_COLORS;
  const setColors = (next: JerseyColors) => mid && mutate((s) => ({ ...s, jerseys: { ...s.jerseys, [mid]: next } }));
  const yamlLine = `jersey_colors: {${KIT_ORDER.filter((k) => colors[k]).map((k) => `${k}: "${colors[k]}"`).join(", ")}}`;
  // The line replaces the jersey_colors already there (inside the video, if that is where it was).
  const write = async (): Promise<string> => {
    const path = `matches/${mid}/match.yaml`;
    const text = await readLocal(path);
    if (text === null) return "Sin acceso a la carpeta: copia la línea en match.yaml.";
    const line = /^([ \t]*)jersey_colors:.*$/m;
    const next = line.test(text)
      ? text.replace(line, (_all, indent: string) => indent + yamlLine)
      : `${text.replace(/\s*$/, "")}\n\n# Colores de camiseta para asignar equipos en el tracking (elegidos en la app)\n${yamlLine}\n`;
    return (await writeLocal(path, next)) ? "Guardados en match.yaml" : "No se pudo escribir match.yaml";
  };
  return { colors, setColors, yamlLine, write };
}

type Props = {
  kits: ReturnType<typeof useKits>;
  // The kit whose colour the next click on the video takes.
  picking: JerseyKey | null;
  onPick: (k: JerseyKey | null) => void;
};

export function KitPanel({ kits, picking, onPick }: Props) {
  const [msg, setMsg] = useState<string | null>(null);
  const { colors, setColors } = kits;
  return (
    <section className="rounded-[10px] bg-surface p-4">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-[15px] text-ink">Uniformes</h2>
        {picking ? <span className="text-xs text-own">clic en su camiseta · Esc cancela</span> : <span className="text-xs text-faint">antes de procesar</span>}
      </div>
      <ul className="space-y-1">
        {KIT_ORDER.map((k) => (
          <li key={k} className={`flex items-center gap-2 ${k.endsWith("_gk") ? "pl-4" : ""}`}>
            <input
              type="color"
              aria-label={`Color de ${KIT_LABELS[k]}`}
              className="h-7 w-8 shrink-0 cursor-pointer rounded-md bg-transparent"
              value={colors[k] || "#808080"}
              onChange={(e) => setColors({ ...colors, [k]: e.target.value })}
            />
            <span className="flex-1 text-sm" style={{ color: KIT_COLOR[k] }}>
              {KIT_LABELS[k]}
            </span>
            {!colors[k] && <span className="text-xs text-faint">sin elegir</span>}
            <button
              type="button"
              className={`grid h-8 w-8 place-items-center rounded-md transition-colors ${picking === k ? "bg-own text-[var(--on-own)]" : "text-muted hover:bg-raised hover:text-ink"}`}
              aria-pressed={picking === k}
              aria-label={`Tomar el color de ${KIT_LABELS[k]} del video`}
              title="Tomar el color con un clic sobre su camiseta en el video (pausa antes)"
              onClick={() => onPick(picking === k ? null : k)}
            >
              <Eyedropper size={15} />
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" className="btn" disabled={KIT_ORDER.every((k) => !colors[k])} onClick={() => void kits.write().then(setMsg)}>
          <FloppyDisk size={15} />
          Guardar en match.yaml
        </button>
        {msg && <span className="text-xs text-faint">{msg}</span>}
      </div>
    </section>
  );
}

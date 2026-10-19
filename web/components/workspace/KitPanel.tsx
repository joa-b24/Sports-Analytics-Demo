"use client";

import { Check, Eyedropper, FloppyDisk } from "@phosphor-icons/react";
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
  // Names of the two teams of the match.
  teams?: { own: string; opp: string };
};

// One circle: the colour chosen (or an empty dashed ring). A click arms the eyedropper: the next click on the video
// takes the colour of that shirt.
function Swatch({ k, color, picking, onPick, label }: { k: JerseyKey; color: string; picking: boolean; onPick: () => void; label: string }) {
  return (
    <button
      type="button"
      aria-pressed={picking}
      aria-label={`${label}: ${color || "sin elegir"}. Clic y luego clic en su camiseta en el video`}
      title={`${label}${color ? ` · ${color}` : " · sin elegir"} — clic y luego clic en su camiseta en el video`}
      onClick={onPick}
      className="group flex flex-col items-center gap-1"
    >
      <span
        className={`grid h-8 w-8 place-items-center rounded-full transition-[box-shadow,transform] duration-150 group-hover:scale-105 ${
          picking ? "animate-pulse shadow-[0_0_0_2px_var(--color-bg),0_0_0_4px_var(--color-own)]" : color ? "shadow-[0_0_0_1px_var(--color-line-strong)]" : "border border-dashed border-line-strong"
        }`}
        style={color ? { background: color } : undefined}
      >
        {(picking || !color) && <Eyedropper size={13} className={color ? "text-white mix-blend-difference" : "text-faint"} />}
      </span>
      <span className="text-[10px] text-faint">{k.endsWith("_gk") ? "Portera" : k === "ref" ? "Árbitra" : "Jugadoras"}</span>
    </button>
  );
}

export function KitPanel({ kits, picking, onPick, teams }: Props) {
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [msg, setMsg] = useState("");
  const { colors } = kits;
  const rows: { name: string; color: string; keys: JerseyKey[] }[] = [
    { name: teams?.own || KIT_LABELS.own, color: KIT_COLOR.own, keys: ["own", "own_gk"] },
    { name: teams?.opp || KIT_LABELS.opp, color: KIT_COLOR.opp, keys: ["opp", "opp_gk"] },
  ];
  const pick = (k: JerseyKey) => onPick(picking === k ? null : k);
  const save = () => {
    setState("saving");
    void kits.write().then((m) => {
      const ok = m.startsWith("Guardados");
      setState(ok ? "saved" : "error");
      setMsg(ok ? "" : m);
      window.setTimeout(() => setState("idle"), 1800);
    });
  };
  return (
    <section className="rounded-[10px] bg-surface p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-[15px] text-ink">Uniformes</h2>
        <button
          type="button"
          className={`btn !px-2.5 !py-1 text-xs transition-colors ${state === "saved" ? "!border-ok !bg-ok !text-bg" : state === "error" ? "!border-danger !text-danger" : ""}`}
          disabled={KIT_ORDER.every((k) => !colors[k]) || state === "saving"}
          title="Escribe los colores en match.yaml (los usa el tracking para separar equipos)"
          onClick={save}
        >
          {state === "saved" ? <Check size={13} weight="bold" /> : <FloppyDisk size={13} />}
          {state === "saved" ? "Guardado" : "Guardar"}
        </button>
      </div>
      <div className="flex items-start gap-4">
        {rows.map((r) => (
          <div key={r.name} className="min-w-0 flex-1">
            <div className="mb-2 flex items-center gap-1.5 text-xs text-ink-2">
              <i className="h-3 w-1 shrink-0 rounded-full" style={{ background: r.color }} />
              <span className="truncate">{r.name}</span>
            </div>
            <div className="flex gap-3">
              {r.keys.map((k) => (
                <Swatch key={k} k={k} color={colors[k] ?? ""} picking={picking === k} onPick={() => pick(k)} label={`${r.name} · ${k.endsWith("_gk") ? "portera" : "jugadoras"}`} />
              ))}
            </div>
          </div>
        ))}
        <div className="shrink-0 border-l border-line-soft pl-4">
          <div className="mb-2 text-xs text-ink-2">Árbitra</div>
          <Swatch k="ref" color={colors.ref ?? ""} picking={picking === "ref"} onPick={() => pick("ref")} label="Árbitra" />
        </div>
      </div>
      {picking && <p className="mt-3 text-xs text-own">Clic en su camiseta en el video · Esc cancela</p>}
      {msg && <p className="mt-2 text-xs text-danger">{msg}</p>}
    </section>
  );
}

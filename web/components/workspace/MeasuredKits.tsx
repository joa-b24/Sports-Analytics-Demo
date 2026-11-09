"use client";

import { Check, FloppyDisk, Warning } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { KIT_LABELS, KIT_ORDER, useKits } from "@/components/workspace/KitPanel";
import { measuredKits, rowsOfTracks, unclaimed, type MeasuredKit } from "@/lib/kitColors";
import { readLocal } from "@/lib/local";
import type { JerseyKey } from "@/lib/tracks";

// The colours the processing measured on the shirts in a tracks file (the test of 30 s, for instance), each with a
// button to take it as a kit. What the tracking compares against is this measure, not the colour seen on screen, so a
// colour picked with the eyedropper can sit too far from it and leave that kit without a team.

const HEX = /^#[0-9a-f]{6}$/i;
const name = (k: JerseyKey, teams?: { own: string; opp: string }) =>
  k === "own" ? `${teams?.own || KIT_LABELS.own} · jugadoras` : k === "own_gk" ? `${teams?.own || KIT_LABELS.own} · portera` : k === "opp" ? `${teams?.opp || KIT_LABELS.opp} · jugadoras` : k === "opp_gk" ? `${teams?.opp || KIT_LABELS.opp} · portera` : "Árbitra";

export function MeasuredKits({ folder, file, teams }: { folder: string; file: string; teams?: { own: string; opp: string } }) {
  const kits = useKits(folder);
  const [rows, setRows] = useState<ReturnType<typeof rowsOfTracks> | null>(null);
  const [msg, setMsg] = useState("");
  const [saving, setSaving] = useState(false);
  const [hexKey, setHexKey] = useState<JerseyKey>("opp_gk");
  const [hex, setHex] = useState("");
  useEffect(() => {
    let live = true;
    void readLocal(`matches/${folder}/tracking/${file}`).then((t) => {
      if (!live) return;
      try {
        // Measured once from the file; the claims against the references are worked out below as they change.
        setRows(rowsOfTracks(JSON.parse(t ?? "")));
      } catch {
        setRows(null);
      }
    });
    return () => {
      live = false;
    };
  }, [folder, file]);
  const groups: MeasuredKit[] | null = useMemo(() => (rows ? measuredKits(rows, kits.colors) : null), [rows, kits.colors]);

  if (!groups) return null;
  const set = (k: JerseyKey, color: string) => {
    kits.setColors({ ...kits.colors, [k]: color });
    setMsg(`${name(k, teams)} → ${color}. Guarda para que el tracking lo use.`);
  };
  const save = async () => {
    setSaving(true);
    setMsg(await kits.write());
    setSaving(false);
  };
  return (
    <div className="mt-3 rounded-lg bg-bg/60 p-3 text-xs">
      <div className="flex items-center gap-2">
        <h3 className="text-[13px] text-ink">Colores medidos en la prueba</h3>
        <button type="button" className="btn ml-auto !px-2.5 !py-1 text-xs" disabled={saving} onClick={() => void save()} title="Escribe los colores en match.yaml (los usa el tracking para separar equipos)">
          <FloppyDisk size={13} /> Guardar
        </button>
      </div>
      <p className="mt-1 text-pretty text-faint">
        Es lo que el tracking compara con tus uniformes: la mediana del torso de cada persona, más apagada que el color que ves en pantalla. Un grupo sin equipo («lejos de todos») se queda sin identificar.
      </p>
      {groups.length === 0 ? (
        <p className="mt-2 text-faint">No hay grupos de color con suficientes cajas en la cancha.</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {groups.map((g) => {
            const lost = unclaimed(g);
            return (
              <li key={g.hex} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="h-6 w-6 shrink-0 rounded-full shadow-[0_0_0_1px_var(--color-line-strong)]" style={{ background: g.hex }} />
                <span className="tc w-16 text-ink-2">{g.hex}</span>
                <span className="tc text-faint">
                  {g.tracks} trozo(s) · {g.boxes} cajas
                </span>
                <span className={`min-w-0 flex-1 ${lost ? "text-warn" : "text-faint"}`}>
                  {g.kit ? (
                    <>
                      <Check size={12} className="mr-1 inline text-ok" />
                      ya es {name(g.kit, teams)}
                    </>
                  ) : g.nearest ? (
                    <>
                      {lost && <Warning size={12} className="mr-1 inline" />}
                      {lost ? "sin equipo: lejos de todos" : "sin margen entre equipos"} (el más cercano, {name(g.nearest.key, teams)}, a {g.nearest.d.toFixed(0)}; límite 40)
                    </>
                  ) : (
                    "sin uniformes elegidos"
                  )}
                </span>
                <select
                  className="rounded-md bg-raised px-1.5 py-0.5 text-xs text-ink-2"
                  aria-label={`Usar ${g.hex} como…`}
                  value=""
                  onChange={(e) => e.target.value && set(e.target.value as JerseyKey, g.hex)}
                >
                  <option value="">Usar como…</option>
                  {KIT_ORDER.map((k) => (
                    <option key={k} value={k}>
                      {name(k, teams)}
                    </option>
                  ))}
                </select>
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line-soft pt-2">
        <span className="text-faint">O escribe un color:</span>
        <select className="rounded-md bg-raised px-1.5 py-0.5 text-xs text-ink-2" aria-label="Uniforme" value={hexKey} onChange={(e) => setHexKey(e.target.value as JerseyKey)}>
          {KIT_ORDER.map((k) => (
            <option key={k} value={k}>
              {name(k, teams)}
            </option>
          ))}
        </select>
        <input className="tc w-24 rounded-md bg-raised px-1.5 py-0.5 text-xs text-ink" placeholder="#rrggbb" value={hex} onChange={(e) => setHex(e.target.value.trim())} aria-invalid={hex !== "" && !HEX.test(hex)} />
        <button
          type="button"
          className="btn !px-2.5 !py-0.5 text-xs"
          disabled={!HEX.test(hex)}
          onClick={() => {
            set(hexKey, hex.toLowerCase());
            setHex("");
          }}
        >
          Usar
        </button>
        {KIT_ORDER.filter((k) => kits.colors[k]).map((k) => (
          <span key={k} className="inline-flex items-center gap-1 text-faint" title={`${name(k, teams)}: ${kits.colors[k]}`}>
            <i className="h-3 w-3 rounded-full shadow-[0_0_0_1px_var(--color-line-strong)]" style={{ background: kits.colors[k] }} />
          </span>
        ))}
      </div>
      {msg && <p className="mt-2 text-faint">{msg}</p>}
    </div>
  );
}

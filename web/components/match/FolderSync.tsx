"use client";

import { ArrowsClockwise, CheckCircle, PencilSimpleLine, WarningCircle } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { btn, btnPrimary, input } from "@/components/Shell";
import { isFolderName, readLocal, suggestFolder, writeLocal } from "@/lib/local";
import { readYamlMeta, writeYamlMeta, yamlDiff, type YamlMeta } from "@/lib/matchYaml";
import { applyRename } from "@/lib/renames";
import type { Match } from "@/lib/types";
import type { Venue } from "@/lib/venue";

// The match data in its folder: kept in step with match.yaml (kind, date, teams and venue name are written by
// themselves; the venue size, which changes the scale Python measures in, only with a button), and renaming the folder
// with everything that carries its name, in the repository and in this browser.

export type YamlSync = {
  status: "none" | "saving" | "saved" | "error";
  // Venue size in match.yaml when it differs from the venue chosen in the app.
  size: { yaml: [number, number]; app: [number, number] } | null;
  applySize: () => void;
};

const metaOf = (match: Match, venue: Venue | undefined): YamlMeta => ({
  kind: match.kind,
  date: match.date || undefined,
  own_team_name: match.focus_team || undefined,
  other_team_name: match.other_team || undefined,
  venue: venue ? { name: venue.name } : undefined,
});

// Writes the match data into match.yaml a moment after they change (only the lines that differ).
export function useYamlSync(match: Match | undefined, venue: Venue | undefined): YamlSync {
  const [status, setStatus] = useState<YamlSync["status"]>("none");
  const [size, setSize] = useState<YamlSync["size"]>(null);
  const [tick, setTick] = useState(0);
  const folder = match?.folder;
  const meta = match ? metaOf(match, venue) : {};
  const key = JSON.stringify([folder, meta, venue?.length_m, venue?.width_m, tick]);
  useEffect(() => {
    if (!folder) return;
    let live = true;
    const path = `matches/${folder}/match.yaml`;
    const t = setTimeout(async () => {
      const text = await readLocal(path);
      if (!live) return;
      if (text === null) return setStatus("none");
      const cur = readYamlMeta(text).venue;
      const yl = cur?.pitch_length_m;
      const yw = cur?.pitch_width_m;
      setSize(venue && yl !== undefined && yw !== undefined && (yl !== venue.length_m || yw !== venue.width_m) ? { yaml: [yl, yw], app: [venue.length_m, venue.width_m] } : null);
      if (yamlDiff(text, meta).length === 0) return setStatus("saved");
      setStatus("saving");
      const ok = await writeLocal(path, writeYamlMeta(text, meta));
      if (live) setStatus(ok ? "saved" : "error");
    }, 900);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // `key` holds everything the effect reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const applySize = () => {
    if (!folder || !venue) return;
    const path = `matches/${folder}/match.yaml`;
    void readLocal(path).then(async (text) => {
      if (text === null) return;
      await writeLocal(path, writeYamlMeta(text, { venue: { pitch_length_m: venue.length_m, pitch_width_m: venue.width_m } }));
      setTick((n) => n + 1);
    });
  };
  return { status, size, applySize };
}

const migrate = (from: string, to: string) => applyRename({ from, to });

export function FolderTools({ match, sync }: { match: Match; sync: YamlSync }) {
  const folder = match.folder ?? "";
  const suggested = suggestFolder(match.date, match.focus_team, match.other_team);
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState("");
  const [plan, setPlan] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (!folder) return null;

  const call = async (dryRun: boolean) => {
    setBusy(true);
    try {
      const r = await fetch("/api/rename", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: folder, to, dryRun }) });
      if (r.status === 404) return { ok: false, lines: ["Solo funciona con la app en la laptop. En la terminal: python -m sportsan.ingest.rename_match " + folder + " " + to] };
      return (await r.json()) as { ok: boolean; lines: string[] };
    } catch {
      return { ok: false, lines: ["No se pudo contactar a la app."] };
    } finally {
      setBusy(false);
    }
  };
  const preview = async () => {
    setMsg(null);
    const r = await call(true);
    if (r.ok) setPlan(r.lines.slice(1));
    else setMsg({ ok: false, text: r.lines.join(" ") });
  };
  const confirm = async () => {
    const r = await call(false);
    if (!r.ok) return setMsg({ ok: false, text: r.lines.slice(-2).join(" ") });
    migrate(folder, to);
    setPlan(null);
    setOpen(false);
    const csv = r.lines.some((l) => l.includes("videos.csv"));
    setMsg({ ok: true, text: `Carpeta renombrada a ${to}: sus archivos${csv ? ", videos.csv" : ""}, y en este navegador las correcciones, las anclas y las preferencias.` });
  };

  const stat =
    sync.status === "saved"
      ? { icon: <CheckCircle size={13} weight="fill" className="text-ok" />, text: "match.yaml al día (fecha, equipos, tipo y sede)" }
      : sync.status === "saving"
        ? { icon: <ArrowsClockwise size={13} className="animate-spin text-faint" />, text: "Guardando en match.yaml…" }
        : sync.status === "error"
          ? { icon: <WarningCircle size={13} weight="fill" className="text-warn" />, text: "No se pudo escribir match.yaml" }
          : { icon: <WarningCircle size={13} className="text-faint" />, text: "Sin acceso a match.yaml (solo con la app en la laptop)" };

  return (
    <div className="ml-[7.25rem] space-y-2">
      <p className="m-0 flex items-center gap-1.5 text-[11px] text-faint">
        {stat.icon}
        {stat.text}
      </p>
      {sync.size && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-warn-900/40 px-2.5 py-1.5 text-[11px] text-pretty text-ink-2">
          <span className="min-w-0 flex-1">
            match.yaml mide {sync.size.yaml[0]} × {sync.size.yaml[1]} m y la sede {sync.size.app[0]} × {sync.size.app[1]} m. La escala del tracking sale de
            match.yaml: cámbiala solo si la sede es la buena.
          </span>
          <button type="button" className={`${btn} !py-1 text-[11px]`} onClick={sync.applySize}>
            Usar las de la sede
          </button>
        </div>
      )}
      {!open ? (
        <button
          type="button"
          className="link inline-flex items-center gap-1 text-[11px]"
          onClick={() => {
            setOpen(true);
            setTo(isFolderName(folder) ? folder : suggested || folder);
            setPlan(null);
            setMsg(null);
          }}
        >
          <PencilSimpleLine size={12} />
          Renombrar la carpeta{!isFolderName(folder) && suggested ? ` (sugerida: ${suggested})` : ""}
        </button>
      ) : (
        <div className="space-y-2 rounded-lg bg-bg/60 p-2.5">
          <input
            className={`${input} tc w-full text-xs`}
            value={to}
            aria-label="Nombre nuevo de la carpeta"
            onChange={(e) => {
              setTo(e.target.value.trim());
              setPlan(null);
            }}
          />
          {!isFolderName(to) && <p className="m-0 text-[11px] text-warn">aaaa_mm_dd_local_vs_visitante, en minúsculas y sin acentos.</p>}
          {plan && (
            <p className="m-0 text-[11px] text-pretty text-ink-2">
              Cambia la carpeta y {plan.length - 1} cosa(s) dentro ({plan.filter((l) => l.includes("->") && !l.startsWith("carpeta")).length} archivo(s) de nombre
              {plan.some((l) => l.startsWith("videos.csv")) ? ", videos.csv" : ""}
              {plan.some((l) => l.startsWith("config/")) ? ", el partido por defecto" : ""}). En este navegador pasan al nombre nuevo las correcciones,
              las anclas y las preferencias. El video no se toca; ciérralo en otros programas antes.
            </p>
          )}
          <div className="flex justify-end gap-1.5">
            <button type="button" className={`${btn} !py-1 text-xs`} onClick={() => setOpen(false)}>
              Cancelar
            </button>
            {plan ? (
              <button type="button" className={`${btnPrimary} !py-1 text-xs`} disabled={busy} onClick={confirm}>
                Renombrar
              </button>
            ) : (
              <button type="button" className={`${btn} !py-1 text-xs`} disabled={busy || !isFolderName(to) || to === folder} onClick={preview}>
                Ver qué cambia
              </button>
            )}
          </div>
        </div>
      )}
      {msg && <p className={`m-0 text-[11px] text-pretty ${msg.ok ? "text-ok" : "text-warn"}`}>{msg.text}</p>}
    </div>
  );
}

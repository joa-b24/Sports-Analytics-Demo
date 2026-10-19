"use client";

import { ArrowRight, CalendarBlank, CheckCircle, Folder, MapPin, Plus, Trash, WarningCircle, YoutubeLogo } from "@phosphor-icons/react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { MODES, STEP_ICONS, ScoreBug } from "@/components/match/MatchHeader";
import { Modal } from "@/components/Modal";
import { Reveal } from "@/components/motion";
import { Select } from "@/components/Select";
import { DemoBadge, PageHeader, btn, btnPrimary, input } from "@/components/Shell";
import { parseYouTubeId } from "@/lib/format";
import { FOLDER_RULE, isFolderName, readFolderFiles, suggestFolder } from "@/lib/local";
import { segmentsFromMarks } from "@/lib/segments";
import { matchSteps, type FolderFiles, type StepId } from "@/lib/steps";
import { mutate, setPref, uid, useStore } from "@/lib/store";
import { matchSummary } from "@/lib/summary";
import { EMPTY_REPORT, type Match, type MatchEvent, type MatchKind, type State } from "@/lib/types";
import { allVenues } from "@/lib/venue";
import { matchVideos, videoOf } from "@/lib/videos";

const COPY: Record<MatchKind, { title: string; add: string; focus: string; other: string; empty: string }> = {
  own: { title: "Nuestros partidos", add: "Nuevo partido propio", focus: "Nuestro equipo", other: "Rival", empty: "Aún no hay partidos propios." },
  rival: { title: "Rivales", add: "Nuevo partido de un rival", focus: "Rival que analizamos", other: "Su contrario", empty: "Aún no hay partidos de rivales." },
  reference: { title: "Videos de referencia", add: "Nuevo video de referencia", focus: "Equipo que analizamos", other: "Su contrario", empty: "Aún no hay videos de referencia." },
};
const ORDER: MatchKind[] = ["own", "rival", "reference"];
const KIND_LABEL: Record<MatchKind, string> = { own: "Nuestro", rival: "Rival", reference: "Referencia" };

// The steps a match can finish by itself, in the order of its modes (the board is not tied to one match).
const STEP_ORDER = MODES.flatMap((m) => m.steps.map(([id, label]) => [id, label] as [StepId, string])).filter(([id]) => id !== "board");

const fmtDate = (d: string) =>
  d ? new Date(`${d}T12:00:00`).toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" }) : "Sin fecha";

// One match: the score, a short summary (the report's first sentence and a few comparisons) and its finished steps.
function MatchRow({ m, events, state, files }: { m: Match; events: MatchEvent[]; state: State; files: FolderFiles | null }) {
  const s = matchSummary(m, events);
  const vids = matchVideos(m).map((v) => v.video_id);
  const marks = state.segments.filter((g) => g.match_id === m.match_id);
  const steps = matchSteps({
    videoIds: vids,
    folder: m.folder,
    venueId: m.venue_id,
    segmentsByVideo: Object.fromEntries(vids.map((v) => [v, segmentsFromMarks(marks.filter((g) => videoOf(g) === v))])),
    events,
    plays: state.plays.filter((p) => p.match_id === m.match_id),
    trackEdits: state.trackEdits,
    files: m.folder ? files : null,
  });
  const done = STEP_ORDER.filter(([id]) => steps[id].state === "done");
  return (
    <Link
      href={`/partido?id=${m.match_id}`}
      className="card group grid min-w-0 flex-1 items-center gap-x-8 gap-y-3 transition-shadow hover:shadow-[inset_0_0_0_1px_var(--color-line-strong)] md:grid-cols-[minmax(0,22rem)_1fr_auto]"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-xs text-faint">
          <span className="cond font-bold uppercase">{fmtDate(m.date)}</span>
          {!m.youtube_id && !m.folder && <span>· sin video</span>}
          {m.is_demo && <DemoBadge />}
        </div>
        <div className="mt-1.5 overflow-hidden">
          <ScoreBug match={m} events={events} />
        </div>
      </div>
      <div className="min-w-0">
        {s.lead && <p className="m-0 line-clamp-2 text-sm text-pretty text-ink-2">{s.lead}</p>}
        {s.comparisons.length > 0 && (
          <dl className={`m-0 flex flex-wrap gap-x-5 gap-y-1 ${s.lead ? "mt-1.5" : ""}`}>
            {s.comparisons.map((c) => (
              <div key={c.label} className="flex items-baseline gap-1.5">
                <dt className="text-xs text-faint">{c.label}</dt>
                <dd className="m-0 text-sm font-semibold text-ink tabular-nums">
                  {`${c.own}${c.unit ?? ""}–${c.opp}${c.unit ?? ""}`}
                </dd>
              </div>
            ))}
          </dl>
        )}
        {!s.lead && s.comparisons.length === 0 && <p className="m-0 text-sm text-faint">El resumen aparece al etiquetar eventos.</p>}
        {s.status.state === "review" && (
          <p className="m-0 mt-1.5 flex items-center gap-1.5 text-xs text-muted">
            <i className="h-1.5 w-1.5 rounded-full bg-warn" aria-hidden />
            {s.status.text}
          </p>
        )}
      </div>
      <div className="flex items-center justify-between gap-4 md:justify-end">
        {done.length > 0 ? (
          <ul className="m-0 flex items-center gap-1.5 rounded-full bg-bg/60 px-2.5 py-1.5" aria-label={`Pasos completos: ${done.map(([, l]) => l).join(", ")}`}>
            {done.map(([id, label]) => {
              const I = STEP_ICONS[id];
              return (
                <li key={id} title={`${label} · ${steps[id].text}`} className="grid place-items-center text-ok">
                  <I size={15} weight="fill" aria-hidden />
                </li>
              );
            })}
          </ul>
        ) : (
          <span className="text-xs text-faint">Sin pasos completos</span>
        )}
        <ArrowRight size={18} className="text-faint transition-[transform,color] group-hover:translate-x-1 group-hover:text-accent-300" />
      </div>
    </Link>
  );
}

// The dialog to create a match, in the style of the match data panel (engrane): the two teams face to face, then one
// row per field with its icon. The folder follows the date and the teams until it is edited by hand.
function NewMatch({ initial, onClose }: { initial: MatchKind; onClose: () => void }) {
  const state = useStore();
  const [kind, setKind] = useState<MatchKind>(initial);
  const [focus, setFocus] = useState("");
  const [other, setOther] = useState("");
  const [date, setDate] = useState("");
  const [venue, setVenue] = useState<string | null>(null);
  const [folderDraft, setFolderDraft] = useState<string | null>(null);
  const [yt, setYt] = useState("");
  const c = COPY[kind];
  const ytId = parseYouTubeId(yt);
  const folder = folderDraft ?? suggestFolder(date, focus, other);
  const folderOk = folder ? isFolderName(folder) : null;

  const create = () => {
    if (!focus.trim()) return;
    mutate((s) => ({
      ...s,
      matches: [
        ...s.matches,
        {
          match_id: uid("m"),
          name: `${focus.trim()} vs ${other.trim() || "?"}`,
          kind,
          date,
          focus_team: focus.trim(),
          other_team: other.trim() || "Contrario",
          youtube_id: ytId,
          ...(folder ? { folder } : {}),
          ...(venue ? { venue_id: venue } : {}),
          report: { ...EMPTY_REPORT },
        },
      ],
    }));
    onClose();
  };

  // One row: an icon and a short label on the left, the control on the right.
  const row = (icon: React.ReactNode, label: string, control: React.ReactNode, hint?: string) => (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-3" title={hint}>
      <span className="flex items-center gap-2 text-xs text-faint">
        {icon}
        {label}
      </span>
      {control}
    </div>
  );
  const mark = (ok: boolean, okText: string, badText: string) => (
    <span className={`absolute top-1/2 right-2.5 -translate-y-1/2 ${ok ? "text-ok" : "text-warn"}`} title={ok ? okText : badText}>
      {ok ? <CheckCircle size={15} weight="fill" /> : <WarningCircle size={15} weight="fill" />}
    </span>
  );

  return (
    <Modal title={c.add} onClose={onClose}>
      <div className="seg mb-4 w-full" role="group" aria-label="Tipo de video">
        {ORDER.map((k) => (
          <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)} className="seg-opt flex-1 text-center text-xs">
            {KIND_LABEL[k]}
          </button>
        ))}
      </div>

      {/* The two teams face to face, as in the match data. */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
        {(
          [
            [c.focus, focus, setFocus, "bg-own"],
            [c.other, other, setOther, "bg-opp"],
          ] as const
        ).map(([label, value, set, dot], n) => (
          <div key={n} className={`flex min-w-0 items-center gap-2 rounded-xl bg-bg/60 px-3 py-2 ${n === 1 ? "order-3" : ""}`}>
            <i className={`h-7 w-1 shrink-0 rounded-full ${dot}`} aria-hidden />
            <label className="min-w-0 flex-1">
              <span className="block truncate text-[10px] tracking-wide text-faint uppercase">{label}</span>
              <input
                className="cond w-full bg-transparent text-sm font-bold text-ink uppercase placeholder:font-normal placeholder:normal-case placeholder:text-faint/70 focus:outline-none"
                placeholder={n === 0 ? "obligatorio" : "opcional"}
                autoFocus={n === 0}
                value={value}
                onChange={(e) => set(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && create()}
              />
            </label>
          </div>
        ))}
        <span className="cond order-2 text-[11px] font-bold text-faint">VS</span>
      </div>

      <div className="mt-4 space-y-2.5">
        {row(<CalendarBlank size={14} />, "Fecha", <input className={`${input} w-full`} type="date" value={date} onChange={(e) => setDate(e.target.value)} />)}
        {row(
          <MapPin size={14} />,
          "Sede",
          <span className="flex min-w-0 gap-1.5">
            <Select
              variant="field"
              label="Sede del partido"
              className="min-w-0 flex-1 justify-between"
              clearable
              placeholder="Sin sede (se elige después)"
              value={venue}
              onChange={setVenue}
              options={allVenues(state.venues).map((v) => ({ value: v.venue_id, label: `${v.name} · ${v.length_m} × ${v.width_m} m` }))}
            />
            <Link
              href="/configuracion"
              className="btn h-9 w-9 shrink-0 !p-0"
              title="Añadir o editar sedes (Configuración › Sedes)"
              aria-label="Añadir sede"
              onClick={() => setPref("config:tab", "venues")}
            >
              <Plus size={14} />
            </Link>
          </span>,
          "La sede da las medidas y los puntos para calibrar",
        )}
        {row(
          <YoutubeLogo size={14} />,
          "YouTube",
          <span className="relative flex min-w-0">
            <input className={`${input} w-full pr-8`} placeholder="https://youtube.com/… (opcional)" value={yt} onChange={(e) => setYt(e.target.value)} />
            {yt.trim() !== "" && mark(!!ytId, `Video ${ytId}`, "No reconozco ese enlace: pega la URL completa")}
          </span>,
        )}
        {row(
          <Folder size={14} />,
          "Carpeta",
          <span className="relative flex min-w-0">
            <input
              className={`${input} tc w-full pr-8 text-xs`}
              placeholder="aaaa_mm_dd_local_vs_visita"
              value={folder}
              onChange={(e) => setFolderDraft(e.target.value.trim())}
            />
            {folderOk !== null && mark(folderOk, "Sigue la convención", `No sigue la convención ${FOLDER_RULE}`)}
          </span>,
          "matches/<carpeta> en el repositorio: ahí viven el video, los tramos y el tracking",
        )}
        <p className="ml-[7.25rem] text-xs text-pretty text-faint">
          {folderDraft === null && folder ? "Sugerida con la fecha y los equipos, local primero: cámbiala si fuimos visitantes. " : ""}
          Más videos (uno por tiempo o por parte) se añaden después en el engrane del partido.
        </p>
      </div>

      <div className="mt-6 flex justify-end gap-2">
        <button type="button" className={btn} onClick={onClose}>
          Cancelar
        </button>
        <button type="button" className={btnPrimary} disabled={!focus.trim()} onClick={create}>
          <Plus size={15} />
          Crear
        </button>
      </div>
    </Modal>
  );
}

// Every match with video, in three groups: ours, rivals and reference videos. Each group has its own «Añadir».
export function MatchList() {
  const state = useStore();
  const { matches, events, plays } = state;
  // A match about to be deleted, waiting for the confirmation.
  const [toDelete, setToDelete] = useState<Match | null>(null);
  const remove = (id: string) => {
    mutate((s) => ({
      ...s,
      matches: s.matches.filter((m) => m.match_id !== id),
      events: s.events.filter((e) => e.match_id !== id),
      plays: s.plays.filter((p) => p.match_id !== id),
      segments: s.segments.filter((g) => g.match_id !== id),
    }));
    setToDelete(null);
  };
  // The kind of the match being created (the dialog is open), or null.
  const [adding, setAdding] = useState<MatchKind | null>(null);

  // What each match folder holds, for its finished steps (only when the app runs next to the repository).
  const [files, setFiles] = useState<Record<string, FolderFiles | null>>({});
  const folders = [...new Set(matches.map((m) => m.folder).filter((f): f is string => !!f))].sort().join("|");
  useEffect(() => {
    if (!folders) return;
    let live = true;
    void Promise.all(folders.split("|").map(async (f) => [f, await readFolderFiles(f)] as const)).then((rows) => {
      if (live) setFiles(Object.fromEntries(rows));
    });
    return () => {
      live = false;
    };
  }, [folders]);

  return (
    <>
      <PageHeader title="Partidos" />
      <div className="space-y-10">
        {ORDER.map((k) => {
          const list = matches.filter((m) => m.kind === k).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
          return (
            <section key={k} aria-labelledby={`sec-${k}`}>
              <div className="mb-3 flex items-center gap-3">
                <h2 id={`sec-${k}`} className="cond m-0 text-sm font-bold tracking-wide text-muted uppercase">
                  {COPY[k].title}
                </h2>
                <span className="tc text-xs text-faint">{list.length}</span>
                <span className="h-px flex-1 bg-line-soft" aria-hidden />
                <button
                  type="button"
                  onClick={() => setAdding(k)}
                  className="inline-flex h-7 items-center gap-1.5 rounded-full bg-surface pr-3 pl-2 text-xs font-medium text-ink-2 transition-colors hover:bg-own hover:text-[var(--on-own)]"
                >
                  <Plus size={13} weight="bold" />
                  Añadir
                </button>
              </div>
              {list.length === 0 ? (
                <button
                  type="button"
                  onClick={() => setAdding(k)}
                  className="flex w-full items-center justify-center gap-2 rounded-[10px] border border-dashed border-line px-4 py-5 text-sm text-faint transition-colors hover:border-line-strong hover:text-ink-2"
                >
                  <Plus size={14} />
                  {COPY[k].empty} {COPY[k].add}
                </button>
              ) : (
                <ul className="space-y-2">
                  {list.map((m, n) => (
                    <Reveal as="li" key={m.match_id} delay={Math.min(n, 6) * 60} className="group/item flex items-center gap-1">
                      <MatchRow m={m} events={events.filter((e) => e.match_id === m.match_id)} state={state} files={m.folder ? (files[m.folder] ?? null) : null} />
                      <button
                        type="button"
                        className="grid h-9 w-9 shrink-0 place-items-center rounded-md text-faint transition-[opacity,color,background-color] group-hover/item:opacity-100 hover:bg-danger/15 hover:text-danger focus-visible:opacity-100 md:opacity-0"
                        aria-label={`Borrar ${m.name}`}
                        title="Borrar el partido"
                        onClick={() => setToDelete(m)}
                      >
                        <Trash size={16} />
                      </button>
                    </Reveal>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>

      {toDelete && (
        <Modal title="Borrar partido" onClose={() => setToDelete(null)}>
          <p className="text-sm text-pretty text-muted">
            ¿Borrar <strong className="text-ink">{toDelete.name}</strong> con sus {events.filter((e) => e.match_id === toDelete.match_id).length} eventos y{" "}
            {plays.filter((p) => p.match_id === toDelete.match_id).length} jugadas? Solo se borra de este navegador: la carpeta del partido y sus archivos no se
            tocan. No se puede deshacer (salvo con un respaldo de Datos).
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" className={btn} onClick={() => setToDelete(null)}>
              Cancelar
            </button>
            <button type="button" className="btn !border-danger !bg-danger text-white" onClick={() => remove(toDelete.match_id)}>
              <Trash size={15} />
              Borrar
            </button>
          </div>
        </Modal>
      )}
      {adding && <NewMatch initial={adding} onClose={() => setAdding(null)} />}
    </>
  );
}

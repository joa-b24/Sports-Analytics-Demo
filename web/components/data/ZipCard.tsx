"use client";

import { FileZip } from "@phosphor-icons/react";
import { useState } from "react";
import { Card, btn, btnPrimary, input } from "@/components/Shell";
import { Select } from "@/components/Select";
import { applyZip, dropZip, inspectZip, isFolderName, type ZipInspection } from "@/lib/local";
import { mutate, uid, useStore } from "@/lib/store";
import { formatBytes, matchFromYaml, parseMatchYaml, type MatchYaml } from "@/lib/uploads";
import { Confirm, DropZone, NoticeLine, Progress, type Notice } from "./DropZone";

const NEW = "__new";
const KIND_LABEL: Record<string, string> = { video: "videos", tracking: "archivos de tracking", match: "match.yaml / segments.csv", edits: "ediciones de clips", report: "informe y clips" };

// A .zip with a whole match folder or a reference video: sent once, shown, then unpacked into matches/<folder>/ after
// the analyst picks where. With a match.yaml it also creates (or completes) the match in this browser.
export function ZipCard({ local, folders, onFolders }: { local: boolean | null; folders: string[]; onFolders: () => void }) {
  const state = useStore();
  const [sending, setSending] = useState<{ name: string; sent: number; total: number; abort: AbortController } | null>(null);
  const [zip, setZip] = useState<(ZipInspection & { name: string; meta: MatchYaml | null }) | null>(null);
  const [dest, setDest] = useState<string>("");
  const [folderDraft, setFolderDraft] = useState("");
  const [conflicts, setConflicts] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const withFolder = state.matches.filter((m) => m.folder);
  const target = dest === NEW || !dest ? null : (state.matches.find((m) => m.match_id === dest) ?? null);
  const folder = target ? (target.folder ?? folderDraft) : folderDraft;
  const folderOk = isFolderName(folder) || folders.includes(folder);
  const canNew = !!zip?.meta;

  const reset = () => {
    if (zip) void dropZip(zip.token);
    setZip(null);
    setConflicts(null);
  };

  const take = async (file: File) => {
    if (!/\.zip$/i.test(file.name)) return setNotice({ tone: "bad", text: "Ese archivo no es un .zip." });
    reset();
    setNotice(null);
    const abort = new AbortController();
    setSending({ name: file.name, sent: 0, total: file.size, abort });
    const r = await inspectZip(file, (sent, total) => setSending((s) => (s ? { ...s, sent, total } : s)), abort.signal);
    setSending(null);
    if (!r.ok) return setNotice({ tone: "bad", text: r.error ?? "No se pudo leer el zip." });
    const z = r.json as ZipInspection;
    if (!z.entries.some((e) => e.inner)) {
      void dropZip(z.token);
      return setNotice({ tone: "bad", text: "El zip no trae nada de la carpeta de un partido (match.yaml, segments.csv, video/, tracking/, edits/)." });
    }
    const meta = z.yaml ? parseMatchYaml(z.yaml) : null;
    // Where it goes: the match whose folder the zip names, otherwise a new one (with match.yaml) or the first match.
    const named = (meta?.match_id ?? z.top?.replace(/\/$/, "").split("/").pop() ?? "").trim();
    const same = state.matches.find((m) => m.folder && m.folder === named);
    setZip({ ...z, name: file.name, meta });
    setFolderDraft(named);
    setDest(same ? same.match_id : meta ? NEW : (withFolder[0]?.match_id ?? NEW));
  };

  const unpack = async (overwrite: boolean) => {
    if (!zip || !folderOk) return;
    setBusy(true);
    const r = await applyZip(zip.token, folder, overwrite);
    setBusy(false);
    if (r.exists) return setConflicts((r.json as { conflicts: string[] }).conflicts);
    setConflicts(null);
    if (!r.ok) {
      if (r.status === 410) setZip(null);
      return setNotice({ tone: "bad", text: r.error ?? "No se pudo descomprimir." });
    }
    const out = r.json as { written: { inner: string; size: number }[]; failed: { inner: string; error: string }[]; skipped: { name: string }[] };
    let what = "";
    if (zip.meta) {
      const existing = target ?? state.matches.find((m) => m.folder === folder);
      const m = matchFromYaml(zip.meta, folder, existing, uid("m"));
      mutate((s) => ({ ...s, matches: existing ? s.matches.map((x) => (x.match_id === existing.match_id ? m : x)) : [...s.matches, m] }));
      what = existing ? ` Se completó «${m.name}» con su match.yaml.` : ` Se creó el partido «${m.name}».`;
    } else if (target && !target.folder) {
      mutate((s) => ({ ...s, matches: s.matches.map((x) => (x.match_id === target.match_id ? { ...x, folder } : x)) }));
    }
    setZip(null);
    onFolders();
    setNotice({
      tone: out.failed.length ? "warn" : "ok",
      text: `${out.written.length} archivos en matches/${folder}/.${what}${out.failed.length ? ` Fallaron: ${out.failed.map((f) => `${f.inner} (${f.error})`).join("; ")}.` : ""}${
        out.skipped.length ? ` ${out.skipped.length} se ignoraron por no ser de la carpeta de un partido.` : ""
      }`,
    });
  };

  const accepted = zip?.entries.filter((e) => e.inner) ?? [];
  const skipped = zip?.entries.filter((e) => !e.inner) ?? [];
  const groups = Object.entries(
    accepted.reduce<Record<string, { n: number; size: number }>>((acc, e) => {
      const g = (acc[e.kind ?? ""] ??= { n: 0, size: 0 });
      g.n++;
      g.size += e.size;
      return acc;
    }, {}),
  );

  return (
    <Card title="Partido o video de referencia completo · .zip" note="la carpeta de matches/<partido> comprimida">
      {sending ? (
        <Progress name={sending.name} sent={sending.sent} total={sending.total} onCancel={() => sending.abort.abort()} />
      ) : !zip ? (
        <DropZone accept=".zip,application/zip" label="Arrastra aquí el .zip" hint="match.yaml, segments.csv, video/, tracking/, edits/ · nada se escribe hasta que lo confirmes" disabled={!local} onFiles={(f) => void take(f[0])} />
      ) : (
        <div className="enter grid gap-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="inline-flex items-center gap-2 text-sm text-ink">
              <FileZip size={16} className="text-faint" />
              {zip.name}
            </span>
            {zip.meta && (
              <span className="text-xs text-muted">
                {zip.meta.own_team_name ?? "—"} vs {zip.meta.other_team_name ?? "—"}
                {zip.meta.date ? ` · ${zip.meta.date}` : ""}
                {zip.meta.kind ? ` · ${zip.meta.kind}` : ""}
              </span>
            )}
          </div>
          <ul className="grid gap-1 text-xs">
            {groups.map(([kind, g]) => (
              <li key={kind} className="flex justify-between gap-3 border-b border-line-soft pb-1">
                <span className="text-ink-2">
                  <span className="num">{g.n}</span> {KIND_LABEL[kind] ?? kind}
                </span>
                <span className="num text-faint">{formatBytes(g.size)}</span>
              </li>
            ))}
            {skipped.length > 0 && (
              <li className="text-faint" title={skipped.map((e) => e.name).join("\n")}>
                {skipped.length} archivos se ignoran (no son de la carpeta de un partido): {skipped.slice(0, 4).map((e) => e.name).join(", ")}
                {skipped.length > 4 ? "…" : ""}
              </li>
            )}
            {!zip.meta && <li className="text-warn">Sin match.yaml: elige un partido que ya exista en la app.</li>}
          </ul>

          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <Select<string>
              variant="field"
              label="Destino"
              value={dest || null}
              options={[
                ...state.matches.map((m) => ({ value: m.match_id, label: m.folder ? `${m.name} · ${m.folder}` : `${m.name} · sin carpeta` })),
                ...(canNew ? [{ value: NEW, label: "Partido nuevo (desde match.yaml)" }] : []),
              ]}
              placeholder="Elige el partido"
              onChange={(v) => v && setDest(v)}
            />
            {target?.folder ? (
              <span className="self-center font-mono text-xs text-ink-2">matches/{target.folder}/</span>
            ) : (
              <input className={`${input} font-mono text-xs`} aria-label="Carpeta en matches/" list="sportsan-folders" placeholder="aaaa_mm_dd_local_vs_visitante" value={folderDraft} onChange={(e) => setFolderDraft(e.target.value.trim())} />
            )}
          </div>
          {!folderOk && folder && <p className="text-xs text-warn">La carpeta debe seguir aaaa_mm_dd_local_vs_visitante o ser una que ya existe en matches/.</p>}

          {conflicts ? (
            <Confirm yes={`Reemplazar ${conflicts.length} y descomprimir`} onYes={() => void unpack(true)} onNo={() => setConflicts(null)}>
              {conflicts.length === 1 ? "Ya existe un archivo" : `Ya existen ${conflicts.length} archivos`} en matches/{folder}/:{" "}
              <code>
                {conflicts.slice(0, 6).join(", ")}
                {conflicts.length > 6 ? "…" : ""}
              </code>
              . Si continúas se reemplazan; el resto de la carpeta no se toca.
            </Confirm>
          ) : (
            <div className="flex flex-wrap gap-2">
              <button type="button" className={btnPrimary} disabled={busy || !folderOk || (!dest || (dest === NEW && !canNew))} onClick={() => void unpack(false)}>
                {busy ? "Descomprimiendo…" : `Descomprimir en matches/${folder || "…"}/`}
              </button>
              <button type="button" className={btn} disabled={busy} onClick={reset}>
                Descartar
              </button>
            </div>
          )}
        </div>
      )}
      <NoticeLine notice={notice} />
    </Card>
  );
}

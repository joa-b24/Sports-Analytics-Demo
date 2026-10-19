"use client";

import { UploadSimple, X } from "@phosphor-icons/react";
import { useState } from "react";
import { formatBytes } from "@/lib/uploads";

type DropProps = {
  accept: string;
  label: string;
  hint?: React.ReactNode;
  multiple?: boolean;
  disabled?: boolean;
  onFiles: (files: File[]) => void;
};

// File picker that also takes dropped files. What happens with them is up to the caller.
export function DropZone({ accept, label, hint, multiple = false, disabled = false, onFiles }: DropProps) {
  const [over, setOver] = useState(false);
  const take = (list: FileList | null | undefined) => {
    const files = Array.from(list ?? []);
    if (!disabled && files.length) onFiles(multiple ? files : files.slice(0, 1));
  };
  return (
    <label
      aria-disabled={disabled}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        take(e.dataTransfer.files);
      }}
      className={`group relative flex flex-col items-center gap-1 rounded-xl border border-dashed px-4 py-5 text-center transition-[border-color,background-color] duration-200 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent-400 ${
        disabled
          ? "cursor-not-allowed border-line opacity-50"
          : over
            ? "cursor-pointer border-accent bg-accent/15"
            : "cursor-pointer border-line-strong hover:border-accent-400 hover:bg-accent/5"
      }`}
    >
      <UploadSimple size={20} className="text-accent-300 transition-transform duration-300 group-hover:-translate-y-0.5" />
      <span className="text-sm font-medium text-ink">{label}</span>
      {hint && <span className="text-xs text-faint">{hint}</span>}
      <input
        type="file"
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        className="sr-only"
        onChange={(e) => {
          const files = e.target.files;
          take(files);
          e.target.value = "";
        }}
      />
    </label>
  );
}

// Bytes sent of a file that is going up, with a way to stop it.
export function Progress({ name, sent, total, onCancel }: { name: string; sent: number; total: number; onCancel?: () => void }) {
  const pct = total > 0 ? Math.min(100, (sent / total) * 100) : 0;
  return (
    <div className="rounded-xl border border-line bg-raised/60 px-3 py-2.5" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={`Subiendo ${name}`}>
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="min-w-0 truncate text-ink-2">{name}</span>
        <span className="num shrink-0 text-faint">
          {formatBytes(sent)} / {formatBytes(total)}
        </span>
        {onCancel && (
          <button type="button" className="shrink-0 text-faint transition-colors hover:text-danger" onClick={onCancel} aria-label="Cancelar subida" title="Cancelar">
            <X size={14} />
          </button>
        )}
      </div>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-line">
        <div className="h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export type Notice = { tone: "ok" | "warn" | "bad"; text: React.ReactNode } | null;

// The answer of the last action of a card, under it.
export function NoticeLine({ notice }: { notice: Notice }) {
  if (!notice) return null;
  const color = notice.tone === "ok" ? "text-ok" : notice.tone === "warn" ? "text-warn" : "text-danger";
  return (
    <p role="status" className={`enter mt-3 text-xs text-pretty ${color}`}>
      {notice.text}
    </p>
  );
}

// "¿Reemplazar?" asked in place, before anything is overwritten.
export function Confirm({ children, yes, onYes, onNo, danger = false }: { children: React.ReactNode; yes: string; onYes: () => void; onNo: () => void; danger?: boolean }) {
  return (
    <div className="enter mt-3 rounded-xl border border-warn/50 bg-warn-900/60 px-3 py-3 text-xs text-ink-2">
      <div className="text-pretty">{children}</div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className={danger ? "btn border-danger text-danger" : "btn btn-primary"} onClick={onYes}>
          {yes}
        </button>
        <button type="button" className="btn" onClick={onNo}>
          Cancelar
        </button>
      </div>
    </div>
  );
}

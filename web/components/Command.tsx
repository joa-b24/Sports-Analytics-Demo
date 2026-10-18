"use client";

import { Check, Copy } from "@phosphor-icons/react";
import { useEffect, useState } from "react";

// A button that copies a text; for a moment it turns into a tick that pops in.
export function CopyButton({ text, label = "Copiar" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      title={copied ? "Copiado" : label}
      aria-label={copied ? "Copiado" : label}
      onClick={() =>
        void navigator.clipboard
          ?.writeText(text)
          .then(() => setCopied(true))
          .catch(() => undefined)
      }
      className={`inline-grid h-7 w-7 shrink-0 place-items-center rounded-lg transition-colors ${
        copied ? "bg-ok/15 text-ok" : "text-muted hover:bg-raised hover:text-ink"
      }`}
    >
      {copied ? <Check key="ok" size={14} weight="bold" className="[animation:pop_0.45s_var(--ease-out-soft)_both]" /> : <Copy key="copy" size={14} />}
    </button>
  );
}

// A terminal command (one or several lines) with its copy button.
export function Command({ children, className = "" }: { children: string; className?: string }) {
  return (
    <div className={`relative ${className}`}>
      <pre className="tc overflow-x-auto rounded-xl bg-bg/70 p-3 pr-11 text-[11px] text-ink-2">{children}</pre>
      <span className="absolute top-1.5 right-1.5">
        <CopyButton text={children} label="Copiar el comando" />
      </span>
    </div>
  );
}

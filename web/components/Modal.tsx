"use client";

import { X } from "@phosphor-icons/react";
import { useEffect } from "react";

// A dialog over the page: closes with Esc, with the X, or clicking outside it.
export function Modal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-bg/70 p-4 backdrop-blur-sm" role="presentation" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`enter max-h-[90vh] w-full overflow-y-auto rounded-3xl bg-raised p-6 shadow-[0_0_0_1px_var(--color-line-strong),0_30px_60px_-20px_rgba(0,0,0,.8)] ${
          wide ? "max-w-3xl" : "max-w-lg"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between gap-4">
          <h2 className="font-display text-2xl text-ink">{title}</h2>
          <button type="button" className="btn h-8 w-8 !p-0" aria-label="Cerrar" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// A small square button with an icon only; the text goes in title and aria-label.
export function IconButton({
  label,
  onClick,
  children,
  tone = "default",
  disabled = false,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  tone?: "default" | "danger" | "accent";
  disabled?: boolean;
}) {
  const color = tone === "danger" ? "hover:text-danger" : tone === "accent" ? "text-accent-300 hover:text-accent-100" : "hover:text-ink";
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`inline-grid h-7 w-7 place-items-center rounded-lg text-muted transition-colors hover:bg-raised disabled:opacity-30 ${color}`}
    >
      {children}
    </button>
  );
}

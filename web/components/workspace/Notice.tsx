"use client";

// One mould for every notice of the correction table under the video (impossible jump, double box, candidate, mode):
// a fixed height, one line of text cut with an ellipsis (the whole text in the tooltip) and the buttons and the
// counter always in the same place, so the notice never grows nor moves the video.

const TONES = {
  danger: "bg-danger/10 text-ink-2 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-danger)_40%,transparent)]",
  warn: "bg-warn-900/80 text-warn shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-warn)_45%,transparent)]",
  accent: "bg-accent-900/70 text-accent-100 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-accent)_50%,transparent)]",
} as const;

export function Notice({
  tone,
  icon,
  title,
  children,
  actions,
}: {
  tone: keyof typeof TONES;
  icon?: React.ReactNode;
  // The whole text, shown on hover (the line may be cut).
  title: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div
      className={`enter flex h-11 flex-nowrap items-center gap-2 overflow-hidden rounded-xl px-3 text-sm [&_.btn]:!h-8 [&_.btn]:!py-0 [&_.btn]:text-xs [&_.btn]:whitespace-nowrap ${TONES[tone]}`}
      role="status"
    >
      {icon && <span className="shrink-0">{icon}</span>}
      <span className="min-w-0 flex-1 truncate" title={title}>
        {children}
      </span>
      {actions && <span className="flex shrink-0 items-center gap-1">{actions}</span>}
    </div>
  );
}

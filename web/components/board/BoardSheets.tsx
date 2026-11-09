"use client";

import { Printer } from "@phosphor-icons/react";
import { BoardView } from "@/components/board/BoardView";
import { btnPrimary } from "@/components/Shell";
import { keyframePositions, resolveAll } from "@/lib/annotations";
import { sheetLayout, sheetPages } from "@/lib/boards";
import { printWith } from "@/lib/print";
import { setPref, usePref } from "@/lib/store";
import { BOARD_CATEGORY_LABELS, BOARD_SIDE_LABELS, type Board } from "@/lib/types";

// One sheet per step, with its drawings and its note, ready to print on white paper (or save as PDF from the print dialog).
export function BoardSheets({ board }: { board: Board }) {
  const perPage = usePref("board:perPage", "4");
  // As large as the steps of one page allow on A4 or letter (lib/boards.ts sheetLayout).
  const layout = sheetLayout(Number(perPage), board.framing);
  const ctx = keyframePositions(board.keyframes);
  const steps = board.keyframes.map((k, i) => ({ k, i }));
  const pages = sheetPages(steps, Number(perPage));
  const kind = `${BOARD_CATEGORY_LABELS[board.category]} ${BOARD_SIDE_LABELS[board.side].toLowerCase()}`;

  return (
    <div className="print-sheet space-y-5">
      <div className="flex flex-wrap items-center gap-3 print:hidden">
        <div className="seg" aria-label="Pasos por página">
          {["2", "3", "4"].map((n) => (
            <button key={n} type="button" className="seg-opt" aria-pressed={perPage === n} onClick={() => setPref("board:perPage", n)}>
              {n} por página
            </button>
          ))}
        </div>
        <button type="button" className={btnPrimary} onClick={() => printWith("white")}>
          <Printer size={15} />
          Imprimir o guardar PDF
        </button>
        <span className="text-xs text-faint">
          {pages.length} {pages.length === 1 ? "página" : "páginas"}
        </span>
      </div>
      {pages.map((pg, pi) => (
        <section key={pi} className={`rounded-2xl border border-line-soft p-5 print:rounded-none print:border-0 print:p-0 ${pi > 0 ? "print:break-before-page" : ""}`}>
          <header className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line-soft pb-2">
            <h3 className="text-lg text-ink">{board.title}</h3>
            <span className="text-xs text-muted">
              {kind} · página {pi + 1} de {pages.length}
            </span>
          </header>
          {pi === 0 && board.notes && <p className="mb-3 line-clamp-3 text-sm whitespace-pre-wrap text-ink-2">{board.notes}</p>}
          <div className="grid gap-x-5 gap-y-4" style={{ gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))` }}>
            {pg.map(({ k, i }) => (
              <figure key={i} className="mx-auto break-inside-avoid" style={{ width: `${layout.itemPct}%` }}>
                <figcaption className="mb-1 text-xs font-semibold text-ink">Paso {i + 1}</figcaption>
                <BoardView framing={board.framing} tokens={board.tokens} positions={k.pos} drawings={resolveAll(board.annotations, k.t, ctx)} />
                {k.note && <p className="mt-1 text-xs text-ink-2">{k.note}</p>}
              </figure>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

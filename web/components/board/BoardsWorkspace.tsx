"use client";

import { Copy, FilmStrip, Plus, Strategy, Trash } from "@phosphor-icons/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useRef, useState } from "react";
import { BoardEditor } from "@/components/board/BoardEditor";
import { BoardPlayer } from "@/components/board/BoardPlayer";
import { BoardSheets } from "@/components/board/BoardSheets";
import { IconButton } from "@/components/Modal";
import { PageHeader, btn, input } from "@/components/Shell";
import { PanelTitle, SidePanel, StudioFrame, useFillHeight, type FrameLayout } from "@/components/studio/Studio";
import { addStep, boardsOf, filterBoards, newBoard } from "@/lib/boards";
import { downloadText, fmtT } from "@/lib/format";
import { writeLocal } from "@/lib/local";
import { mutate, setPref, uid, useHydrated, usePref, useStore } from "@/lib/store";
import {
  BOARD_CATEGORIES,
  BOARD_CATEGORY_LABELS,
  BOARD_FRAMING_LABELS,
  BOARD_SIDE_LABELS,
  type Board,
  type BoardCategory,
  type BoardFraming,
  type BoardSide,
} from "@/lib/types";

type Mode = "edit" | "play" | "sheets";
const MODES: [Mode, string][] = [
  ["edit", "Editar"],
  ["play", "Animación"],
  ["sheets", "Láminas"],
];

// The board: plays drawn on the pitch, by category. On its own page the chosen play is in the URL (?id=); inside a
// match (Estudio) it is kept here, so it does not clash with the match's own ?id=. Same frame as the clip editor
// (components/studio/Studio.tsx): bar on top, tool rail, pitch, steps under it and a side panel.
export function BoardsWorkspace({ embedded = false }: { embedded?: boolean }) {
  const state = useStore();
  const hydrated = useHydrated();
  const router = useRouter();
  const params = useSearchParams();
  const boards = boardsOf(state);
  const category = usePref("board:category", "all") as BoardCategory | "all";
  const side = usePref("board:side", "all") as BoardSide | "all";
  const [mode, setMode] = useState<Mode>("edit");
  const list = filterBoards(boards, { category, side });
  const [localId, setLocalId] = useState<string | null>(null);
  const selId = embedded ? localId : params.get("id");
  const board = boards.find((b) => b.board_id === selId) ?? list[0] ?? null;
  const frameRef = useRef<HTMLDivElement>(null);
  const fillH = useFillHeight(frameRef, hydrated && mode !== "sheets");

  const open = (id: string) => (embedded ? setLocalId(id) : router.replace(`/pizarron?id=${id}`, { scroll: false }));
  const save = (b: Board) => mutate((s) => ({ ...s, boards: (s.boards ?? []).map((x) => (x.board_id === b.board_id ? b : x)) }));
  const insert = (b: Board) => {
    mutate((s) => ({ ...s, boards: [...(s.boards ?? []), b] }));
    open(b.board_id);
    setMode("edit");
  };
  const create = () => {
    const c: BoardCategory = category === "all" ? "corner" : category;
    const sd: BoardSide = side === "all" ? "for" : side;
    const n = boards.filter((b) => b.category === c && b.side === sd).length + 1;
    insert(newBoard(uid("b"), c, sd, `${BOARD_CATEGORY_LABELS[c]} ${BOARD_SIDE_LABELS[sd].toLowerCase()} ${n}`));
  };

  // The board as a file for the render (python -m sportsan.clips.render --board <id>): into data/boards/ when the app
  // runs on this computer, otherwise downloaded.
  const [exported, setExported] = useState<{ id: string; text: string } | null>(null);
  const exportBoard = async (b: Board) => {
    const name = `board_${b.board_id}.json`;
    const text = JSON.stringify(b);
    if (await writeLocal(`data/boards/${name}`, text)) setExported({ id: b.board_id, text: `Guardada en data/boards/${name}. Para el video: python -m sportsan.clips.render --board ${b.board_id}` });
    else {
      downloadText(name, text, "application/json");
      setExported({ id: b.board_id, text: `Descargada como ${name}: guárdala en data/boards/ del repositorio para exportarla a video.` });
    }
  };

  const origin = board?.match_id ? state.matches.find((m) => m.match_id === board.match_id) : undefined;
  const play = board?.play_id ? state.plays.find((p) => p.play_id === board.play_id) : undefined;

  if (!hydrated) return null;

  const layout: FrameLayout = {
    fixed: fillH !== null,
    frameRef,
    className: fillH !== null ? "xl:-mb-12" : "",
    style: fillH !== null ? { height: fillH } : undefined,
  };

  // Tab «Jugadas» of the side panel: the filter, the list and a new play.
  const listPanel = (
    <div className="space-y-3">
      <PanelTitle
        right={
          <button type="button" className={`${btn} !px-2.5 !py-1 text-xs`} onClick={create}>
            <Plus size={13} />
            Nueva
          </button>
        }
      >
        Jugadas del pizarrón
      </PanelTitle>
      <select className={`${input} w-full text-sm`} value={category} aria-label="Categoría" onChange={(e) => setPref("board:category", e.target.value)}>
        <option value="all">Todas las categorías</option>
        {BOARD_CATEGORIES.map((c) => (
          <option key={c} value={c}>
            {BOARD_CATEGORY_LABELS[c]}
          </option>
        ))}
      </select>
      <div className="seg flex" aria-label="A favor o en contra">
        {(["all", "for", "against"] as const).map((s) => (
          <button key={s} type="button" className="seg-opt flex-1" aria-pressed={side === s} onClick={() => setPref("board:side", s)}>
            {s === "all" ? "Todas" : BOARD_SIDE_LABELS[s]}
          </button>
        ))}
      </div>
      {list.length === 0 ? (
        <p className="text-xs text-faint">
          {boards.length === 0
            ? "Todavía no hay jugadas. «Nueva» crea una de la categoría elegida con las fichas colocadas; desde Jugadas, «Pasar al pizarrón» copia una jugada aquí."
            : "Ninguna jugada con este filtro."}
        </p>
      ) : (
        <ul className="space-y-1">
          {list.map((b) => (
            <li key={b.board_id}>
              <button
                type="button"
                onClick={() => open(b.board_id)}
                aria-pressed={b.board_id === board?.board_id}
                className={`w-full rounded-lg px-3 py-2 text-left transition-colors ${
                  b.board_id === board?.board_id ? "bg-accent-900 text-ink ring-1 ring-accent/60" : "text-ink-2 hover:bg-raised"
                }`}
              >
                <div className="truncate text-sm font-medium">{b.title}</div>
                <div className="text-[11px] text-faint">
                  {BOARD_CATEGORY_LABELS[b.category]} · {BOARD_SIDE_LABELS[b.side].toLowerCase()} · {b.keyframes.length} {b.keyframes.length === 1 ? "paso" : "pasos"}
                  {b.match_id ? " · de un partido" : ""}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  // Bar on top: the play's name and what applies to all of it, the view and the actions.
  const header = board && (
    <>
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-surface text-muted" aria-hidden>
        <Strategy size={18} />
      </span>
      <input className={`${input} min-w-48 flex-1 font-medium`} value={board.title} aria-label="Título" onChange={(e) => save({ ...board, title: e.target.value })} />
      <select className={`${input} text-sm`} value={board.category} aria-label="Categoría" onChange={(e) => save({ ...board, category: e.target.value as BoardCategory })}>
        {BOARD_CATEGORIES.map((c) => (
          <option key={c} value={c}>
            {BOARD_CATEGORY_LABELS[c]}
          </option>
        ))}
      </select>
      <div className="seg" aria-label="A favor o en contra">
        {(["for", "against"] as const).map((s) => (
          <button key={s} type="button" className="seg-opt" aria-pressed={board.side === s} onClick={() => save({ ...board, side: s })}>
            {BOARD_SIDE_LABELS[s]}
          </button>
        ))}
      </div>
      <select className={`${input} text-sm`} value={board.framing ?? "full"} aria-label="Encuadre" onChange={(e) => save({ ...board, framing: e.target.value as BoardFraming })}>
        {(Object.keys(BOARD_FRAMING_LABELS) as BoardFraming[]).map((f) => (
          <option key={f} value={f}>
            {BOARD_FRAMING_LABELS[f]}
          </option>
        ))}
      </select>
      <div className="seg" role="tablist" aria-label="Vista">
        {MODES.map(([m, label]) => (
          <button key={m} type="button" role="tab" className="seg-opt" aria-selected={mode === m} onClick={() => setMode(m)}>
            {label}
          </button>
        ))}
      </div>
      <span className="flex items-center">
        <IconButton label="Exportar para video (MP4 con python -m sportsan.clips.render --board)" onClick={() => void exportBoard(board)}>
          <FilmStrip size={16} />
        </IconButton>
        <IconButton label="Duplicar la jugada" onClick={() => insert({ ...structuredClone(board), board_id: uid("b"), title: `${board.title} (copia)` })}>
          <Copy size={16} />
        </IconButton>
        <IconButton
          label="Borrar la jugada del pizarrón"
          tone="danger"
          onClick={() => {
            if (!window.confirm(`¿Borrar «${board.title}» del pizarrón?`)) return;
            mutate((s) => ({ ...s, boards: (s.boards ?? []).filter((x) => x.board_id !== board.board_id) }));
            if (embedded) setLocalId(null);
            else router.replace("/pizarron", { scroll: false });
          }}
        >
          <Trash size={16} />
        </IconButton>
      </span>
      {exported?.id === board.board_id && <p className="m-0 basis-full text-xs text-ink-2">{exported.text}</p>}
    </>
  );

  // Tab «Jugada» of the editor: the notes of the whole play and where it comes from.
  const boardPanel = board && (
    <div>
      <PanelTitle>Notas de la jugada</PanelTitle>
      <textarea
        className={`${input} w-full text-sm`}
        rows={3}
        placeholder="Salen en la primera lámina"
        value={board.notes}
        onChange={(e) => save({ ...board, notes: e.target.value })}
      />
      {board.match_id && (
        <p className="mt-2 text-xs text-muted">
          Copiada de{" "}
          {origin ? (
            <Link className="link" href={`/partido?id=${origin.match_id}${play ? `&video=${play.video_id ?? "v1"}&t=${play.t_start}` : ""}`}>
              {play ? `«${play.title}» (${fmtT(play.t_start)})` : "una jugada"} de {origin.name}
            </Link>
          ) : (
            "una jugada de un partido que ya no está en este navegador"
          )}
          . La jugada original no cambia al editar aquí.
        </p>
      )}
    </div>
  );

  // Without a play, or with one without steps: the same frame with the reason in the canvas.
  const emptyFrame = (message: React.ReactNode) => (
    <StudioFrame
      {...layout}
      header={header || undefined}
      canvas={<div className="grid h-full min-h-60 place-items-center p-6 text-center text-sm text-muted">{message}</div>}
      side={
        <SidePanel tabs={[["list", "Jugadas"]]} value="list" onChange={() => undefined}>
          {listPanel}
        </SidePanel>
      }
    />
  );

  return (
    <>
      {!embedded && (
        <div className={mode === "sheets" ? "print:hidden" : ""}>
          <PageHeader title="Pizarrón">
            <button type="button" className={btn} onClick={create}>
              <Plus size={14} />
              Nueva jugada
            </button>
          </PageHeader>
        </div>
      )}

      {!board ? (
        emptyFrame(
          <div className="space-y-3">
            <Strategy size={40} className="mx-auto text-faint" aria-hidden />
            <p className="m-0">Crea una jugada con «Nueva»: elige antes la categoría y si es a favor o en contra en la lista.</p>
            <button type="button" className={btn} onClick={create}>
              <Plus size={14} />
              Nueva jugada
            </button>
          </div>,
        )
      ) : board.keyframes.length === 0 ? (
        emptyFrame(
          <div className="space-y-3">
            <p className="m-0">Esta jugada no tiene pasos: la jugada de la que salió no tenía posiciones.</p>
            <button type="button" className={btn} onClick={() => save(addStep(board))}>
              <Plus size={14} />
              Empezar con las fichas colocadas
            </button>
          </div>,
        )
      ) : mode === "edit" ? (
        <BoardEditor key={board.board_id} board={board} save={save} header={header} boardPanel={boardPanel} listPanel={listPanel} layout={layout} />
      ) : mode === "play" ? (
        <BoardPlayer key={board.board_id} board={board} header={header} listPanel={listPanel} layout={layout} />
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 print:hidden">{header}</div>
          <div className="rounded-xl bg-surface p-4 print:bg-transparent print:p-0">
            <BoardSheets board={board} />
          </div>
        </div>
      )}
    </>
  );
}

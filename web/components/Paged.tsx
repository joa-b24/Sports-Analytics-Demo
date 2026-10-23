"use client";

import { CaretLeft, CaretRight } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { IconButton } from "@/components/Modal";

// A list that fills the room it has and is split in pages instead of scrolling inside (rows of a fixed height).
// `follow`: index of the row to keep in view (the current one); the page jumps to it when it changes.
export function usePaged<T>(items: T[], rowH: number, follow: number | null = null, min = 3) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [per, setPer] = useState(8);
  const [page, setPage] = useState(0);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setPer(Math.max(min, Math.floor(e.contentRect.height / rowH))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [rowH, min]);
  // When the row to follow (or the rows per page) changes, go to its page (adjusted while rendering, not in an effect).
  const [seen, setSeen] = useState<[number | null, number]>([null, 0]);
  if (seen[0] !== follow || seen[1] !== per) {
    setSeen([follow, per]);
    if (follow !== null && follow >= 0) setPage(Math.floor(follow / per));
  }
  const pages = Math.max(1, Math.ceil(items.length / per));
  const p = Math.min(page, pages - 1);
  return { boxRef, rows: items.slice(p * per, p * per + per), page: p, pages, setPage, offset: p * per };
}

export function Pager({ page, pages, setPage }: { page: number; pages: number; setPage: (p: number) => void }) {
  if (pages <= 1) return null;
  return (
    <div className="mt-2 flex shrink-0 items-center justify-center gap-2 text-xs text-faint">
      <IconButton label="Página anterior" disabled={page === 0} onClick={() => setPage(page - 1)}>
        <CaretLeft size={13} />
      </IconButton>
      <span className="tc">
        {page + 1} / {pages}
      </span>
      <IconButton label="Página siguiente" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>
        <CaretRight size={13} />
      </IconButton>
    </div>
  );
}

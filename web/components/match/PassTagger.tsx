"use client";

import { ArrowCounterClockwise, ArrowRight, Trash, X } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type RefObject } from "react";
import { IconButton } from "@/components/Modal";
import { COLORS } from "@/components/Pitch";
import { Card, input } from "@/components/Shell";
import type { PlayerHandle } from "@/components/VideoPlayer";
import { fmtT, isTyping } from "@/lib/format";
import { lost, touch, type Holder } from "@/lib/passes";
import { mutate, uid, useStore } from "@/lib/store";
import type { Match, PassRow } from "@/lib/types";

// Pass 4 of the tagging: the pass network, by hand. With the video running, type the number of each player who gets
// the ball, in order: two in a row of the same team are a pass. X: the team lost it. Esc: the chain stops without a
// pass (the ball went out, a foul...). Only the touches are tagged, never the whole match frame by frame.

// Typed digits are taken as a number after this pause (ms), or at once with Enter.
const COMMIT_MS = 650;

export function PassTagger({
  match,
  videoId,
  period,
  time,
  playerRef,
}: {
  match: Match;
  videoId: string;
  period: 1 | 2;
  time: number;
  playerRef: RefObject<PlayerHandle | null>;
}) {
  const { roster, passes: allPasses = [] } = useStore();
  const [team, setTeam] = useState<"own" | "opp">("own");
  const [lag, setLag] = useState(1);
  const [holder, setHolder] = useState<Holder | null>(null);
  const [typed, setTyped] = useState("");
  const [msg, setMsg] = useState("");
  // What each action did, to take it back with Ctrl + Z: the pass it wrote (if any) and the holder before it.
  const [history, setHistory] = useState<{ passId: string | null; before: Holder | null }[]>([]);

  const squad = match.kind === "own" ? [...(roster ?? [])].sort((a, b) => (a.number ?? 999) - (b.number ?? 999)) : [];
  const passes = allPasses.filter((p) => p.match_id === match.match_id && (p.video_id ?? "v1") === videoId);
  const nameOf = (id: string) => {
    const r = squad.find((p) => p.player_id === id);
    return r?.number != null ? `${r.number} ${id}` : id;
  };
  // A number -> who: in our matches, the squad (names); otherwise, or if nobody has it, "#n".
  const playerFor = (n: number) => (team === "own" ? squad.find((p) => p.number === n)?.player_id : undefined) ?? `#${n}`;
  const base = { match_id: match.match_id, video_id: videoId, period, team };
  const now = () => Math.max(0, Math.round(((playerRef.current?.getTime() ?? time) - lag) * 10) / 10);

  const give = (player_id: string) => {
    const r = touch(holder, player_id, now(), base, uid("ps"));
    if (r.pass) {
      const pass = r.pass;
      mutate((s) => ({ ...s, passes: [...(s.passes ?? []), pass] }));
    }
    setHistory((h) => [...h, { passId: r.pass?.pass_id ?? null, before: holder }]);
    setHolder(r.holder);
    setMsg("");
  };
  const lose = () => {
    if (!holder) return setMsg("Nadie tiene el balón: escribe primero el número de quien lo tiene.");
    const p = lost(holder, base, uid("ps"));
    mutate((s) => ({ ...s, passes: [...(s.passes ?? []), p] }));
    setHistory((h) => [...h, { passId: p.pass_id, before: holder }]);
    setHolder(null);
  };
  const stop = () => {
    setHistory((h) => [...h, { passId: null, before: holder }]);
    setHolder(null);
    setTyped("");
  };
  const undo = () => {
    const last = history[history.length - 1];
    if (!last) return;
    if (last.passId) mutate((s) => ({ ...s, passes: (s.passes ?? []).filter((p) => p.pass_id !== last.passId) }));
    setHolder(last.before);
    setHistory((h) => h.slice(0, -1));
  };
  const commit = (digits: string) => {
    setTyped("");
    const n = Number(digits);
    if (digits && Number.isFinite(n)) give(playerFor(n));
  };

  // Digits wait a moment for a second one.
  useEffect(() => {
    if (!typed) return;
    const t = setTimeout(() => commit(typed), COMMIT_MS);
    return () => clearTimeout(t);
  });

  const keys = useRef<(e: KeyboardEvent) => void>(() => undefined);
  useEffect(() => {
    keys.current = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (isTyping(el)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        return undo();
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (/^\d$/.test(k)) {
        e.preventDefault();
        setTyped((t) => (t + k).slice(-2));
      } else if (k === "enter") {
        e.preventDefault();
        commit(typed);
      } else if (k === "x") lose();
      else if (k === "escape") stop();
      else if (k === "a" || k === "s") {
        setTeam(k === "a" ? "own" : "opp");
        setHolder(null);
      }
    };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const mine = passes.filter((p) => p.team === team);
  const done = mine.filter((p) => p.outcome === "complete").length;
  const count = new Map<string, number>();
  for (const p of mine) {
    count.set(p.from_id, (count.get(p.from_id) ?? 0) + 1);
    if (p.to_id) count.set(p.to_id, (count.get(p.to_id) ?? 0) + 1);
  }
  const recent = [...passes].sort((a, b) => b.t_video - a.t_video).slice(0, 10);

  return (
    <Card title="Pases" note={<span className="tc">Ahora {fmtT(time)}</span>}>
      <div className="flex gap-2">
        {(["own", "opp"] as const).map((t) => (
          <button
            key={t}
            type="button"
            aria-pressed={team === t}
            onClick={() => {
              setTeam(t);
              setHolder(null);
            }}
            className={`flex flex-1 items-center justify-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition-colors ${
              team === t ? "border-accent bg-accent/20 text-accent-100" : "border-line text-ink-2 hover:border-line-strong"
            }`}
          >
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: t === "own" ? COLORS.own : COLORS.opp }} />
            <span className="truncate">{t === "own" ? match.focus_team : match.other_team}</span>
            <kbd className="kbd">{t === "own" ? "A" : "S"}</kbd>
          </button>
        ))}
      </div>

      {/* Who has the ball now, big: the next number typed closes her pass. */}
      <div className="mt-3 flex items-center gap-3 rounded-2xl bg-bg/60 px-4 py-3">
        <span className="text-xs text-muted">Tiene el balón</span>
        <span className="num text-2xl text-ink">{holder ? nameOf(holder.player_id) : "—"}</span>
        <ArrowRight size={16} className="text-faint" />
        <span className={`num text-2xl ${typed ? "text-accent-200" : "text-faint"}`}>{typed || "?"}</span>
        <span className="ml-auto flex items-center gap-1">
          <IconButton label="Deshacer (Ctrl + Z)" disabled={history.length === 0} onClick={undo}>
            <ArrowCounterClockwise size={15} />
          </IconButton>
        </span>
      </div>
      {msg && <p className="mt-2 text-xs text-warn">{msg}</p>}

      {squad.length > 0 && team === "own" && (
        <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-1.5">
          {squad.map((p) => (
            <button
              key={p.player_id}
              type="button"
              onClick={() => give(p.player_id)}
              className={`flex items-center gap-2 rounded-xl border px-2 py-1 text-left text-xs transition-colors hover:border-accent ${
                holder?.player_id === p.player_id ? "border-accent bg-accent/20 text-accent-100" : "border-line text-ink-2"
              }`}
            >
              <span className="tc w-5 text-right text-faint">{p.number ?? "–"}</span>
              <span className="min-w-0 flex-1 truncate">{p.player_id}</span>
              {count.get(p.player_id) ? <span className="tc text-[10px] text-faint">{count.get(p.player_id)}</span> : null}
            </button>
          ))}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" className="btn" onClick={lose}>
          <X size={14} /> La perdimos <kbd className="kbd">X</kbd>
        </button>
        <button type="button" className="btn" onClick={stop}>
          Cortar sin pase <kbd className="kbd">Esc</kbd>
        </button>
        <label className="ml-auto flex items-center gap-1.5 text-xs text-muted" title="Segundos que se restan al momento en que escribes el número">
          Restar
          <select className={input} value={lag} onChange={(e) => setLag(Number(e.target.value))}>
            {[0, 1, 2].map((v) => (
              <option key={v} value={v}>
                {v} s
              </option>
            ))}
          </select>
        </label>
      </div>

      <p className="mt-3 text-[11px] text-pretty text-faint">
        Con el video corriendo, escribe el número de cada jugadora que recibe el balón, en orden (dos cifras seguidas, o Enter). Dos
        seguidas del mismo equipo son un pase. <kbd className="kbd">X</kbd> la perdimos, <kbd className="kbd">Esc</kbd> se corta sin pase
        (salió, falta), <kbd className="kbd">A</kbd>/<kbd className="kbd">S</kbd> cambia de equipo, <kbd className="kbd">Ctrl + Z</kbd>{" "}
        deshace. En este video: {mine.length} pases de {team === "own" ? match.focus_team : match.other_team}, {done} completos.
      </p>

      {recent.length > 0 && (
        <ul className="mt-3 space-y-0.5 border-t border-line-soft pt-3 text-xs">
          {recent.map((p: PassRow) => (
            <li key={p.pass_id} className="flex items-center gap-2 text-ink-2">
              <button type="button" className="tc w-12 text-left text-faint hover:text-ink" onClick={() => playerRef.current?.seek(Math.max(0, p.t_video - 2), true)}>
                {fmtT(p.t_video)}
              </button>
              <span className="h-2 w-2 rounded-full" style={{ background: p.team === "own" ? COLORS.own : COLORS.opp }} />
              <span className="min-w-0 flex-1 truncate">
                {nameOf(p.from_id)} → {p.to_id ? nameOf(p.to_id) : <span className="text-warn">perdido</span>}
              </span>
              <IconButton label="Borrar este pase" tone="danger" onClick={() => mutate((s) => ({ ...s, passes: (s.passes ?? []).filter((x) => x.pass_id !== p.pass_id) }))}>
                <Trash size={13} />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

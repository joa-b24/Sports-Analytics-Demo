import type { PointerEvent as RPointerEvent, Ref } from "react";
import { COLORS, Pitch } from "@/components/Pitch";
import { arrowHead, curvePath, labelPoint, type Pt, type Resolved } from "@/lib/annotations";
import { framingBox } from "@/lib/boards";
import { useDrawColor } from "@/components/studio/palette";
import type { BoardFraming, BoardToken } from "@/lib/types";

// Drawing colours come from the palette of Estudio (lib/palette.ts, components/studio/palette.tsx).

const TOKEN_R = 1.9;
const BALL_R = 1.1;

// One drawing in pitch meters (a text in screen coordinates is placed over the pitch box). Zones and lines go under
// the pieces, the rest over them. A drawing that appears is drawn in (arrows and lines) or fades in.
function Drawing({ r, selected, onPick }: { r: Resolved; selected: boolean; onPick?: (id: string) => void }) {
  const color = useDrawColor()(r.style.color);
  const pts: Pt[] = r.space === "screen" ? r.points.map(([x, y]) => [x * 105, y * 68]) : r.points;
  const dash = r.style.dashed ? "1.4 0.9" : undefined;
  const width = selected ? 0.75 : 0.5;
  const pick = onPick
    ? (e: RPointerEvent) => {
        e.stopPropagation();
        onPick(r.id);
      }
    : undefined;
  const label = r.style.label && r.kind !== "text" && (
    <text {...pointAttrs(labelPoint({ kind: r.kind, points: pts }), r.kind === "highlight" ? -3.6 : -1.2)} textAnchor="middle" fontSize={2.3} fontWeight={600} fill={color} stroke="var(--pitch-fill)" strokeWidth={0.6} paintOrder="stroke" pointerEvents="none">
      {r.style.label}
    </text>
  );
  const hit = onPick ? { onPointerDown: pick, className: "cursor-pointer" } : { pointerEvents: "none" as const };
  if (r.kind === "highlight") {
    const [x, y] = pts[0];
    return (
      <g className="ann-in">
        <circle cx={x} cy={y} r={3} fill="none" stroke={color} strokeWidth={width} strokeDasharray={dash} {...hit} />
        <circle cx={x} cy={y} r={3} fill={color} opacity={0.14} pointerEvents="none" />
        {label}
      </g>
    );
  }
  if (r.kind === "zone") {
    return (
      <g className="ann-in">
        <polygon points={pts.map((p) => p.join(",")).join(" ")} fill={color} fillOpacity={0.16} stroke={color} strokeWidth={width} strokeDasharray={dash} strokeLinejoin="round" {...hit} />
        {label}
      </g>
    );
  }
  if (r.kind === "text") {
    return (
      <text {...pointAttrs(pts[0], 0)} className="ann-in" textAnchor="middle" fontSize={2.8} fontWeight={600} fill={color} stroke="var(--pitch-fill)" strokeWidth={0.7} paintOrder="stroke" {...hit}>
        {r.style.label || "Texto"}
      </text>
    );
  }
  const head = r.kind === "arrow" ? arrowHead(pts, 2.2) : null;
  // The line stops at the base of the head so a thick stroke does not poke through its tip.
  const body = head ? [...pts.slice(0, -1), [(head[1][0] + head[2][0]) / 2, (head[1][1] + head[2][1]) / 2] as Pt] : pts;
  const d = r.kind === "arrow" ? curvePath(body) : `M${pts.map((p) => p.join(" ")).join("L")}`;
  return (
    <g>
      {/* Wide invisible stroke: easier to click than the drawn line. */}
      {onPick && <path d={d} fill="none" stroke="transparent" strokeWidth={2.4} {...hit} />}
      <path d={d} fill="none" stroke={color} strokeWidth={width} strokeDasharray={dash} strokeLinecap="round" strokeLinejoin="round" pathLength={dash ? undefined : 1} className={dash ? "ann-in" : "ann-draw"} pointerEvents="none" />
      {head && <polygon points={head.map((p) => p.join(",")).join(" ")} fill={color} className="ann-in" pointerEvents="none" />}
      {r.kind === "line" && pts.map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r={0.5} fill={color} pointerEvents="none" />)}
      {label}
    </g>
  );
}

const pointAttrs = (p: Pt, dy: number) => ({ x: p[0], y: p[1] + dy });

type Props = {
  tokens: BoardToken[];
  positions: Record<string, [number, number]> | null;
  drawings: Resolved[];
  selected?: string | null;
  framing?: BoardFraming;
  // Token being dragged, drawn where the pointer is.
  drag?: { id: string; x: number; y: number } | null;
  onToken?: (id: string, e: RPointerEvent) => void;
  onPickDrawing?: (id: string) => void;
  svgRef?: Ref<SVGSVGElement>;
  className?: string;
  // Inside a box that already sizes it (Estudio): no width cap for a half.
  fit?: boolean;
  // Drawn over everything: handles of the selected drawing, the drawing being made.
  children?: React.ReactNode;
} & Omit<React.SVGProps<SVGSVGElement>, "ref" | "children">;

// The board at one moment: pitch, drawings and pieces. Static unless handlers are given.
export function BoardView({ tokens, positions, drawings, selected = null, framing = "full", drag = null, onToken, onPickDrawing, svgRef, className = "", fit = false, children, ...rest }: Props) {
  const under = drawings.filter((d) => d.kind === "zone" || d.kind === "line");
  const over = drawings.filter((d) => d.kind !== "zone" && d.kind !== "line");
  return (
    // A half is taller than wide: on screen it is kept narrower so it fits in the window.
    <Pitch svgRef={svgRef} className={`${framing === "full" || fit ? "" : "mx-auto max-w-xl print:max-w-none"} ${className}`} showDirection={framing === "full"} viewBox={framingBox(framing).join(" ")} {...rest}>
      {under.map((d) => (
        <Drawing key={d.id} r={d} selected={d.id === selected} onPick={onPickDrawing} />
      ))}
      {positions &&
        tokens.map((tk) => {
          const base = positions[tk.id];
          if (!base) return null;
          const [x, y] = drag?.id === tk.id ? [drag.x, drag.y] : base;
          const ball = tk.team === "ball";
          return (
            <g key={tk.id} transform={`translate(${x} ${y})`} className={onToken ? "cursor-pointer" : ""} onPointerDown={onToken ? (e) => onToken(tk.id, e) : undefined}>
              <circle r={ball ? BALL_R : TOKEN_R} fill={ball ? COLORS.ball : tk.team === "own" ? COLORS.own : COLORS.opp} stroke="var(--color-bg)" strokeWidth={0.4} />
              {!ball && tk.label && (
                <text y={tk.label.length > 2 ? 0.7 : 0.85} textAnchor="middle" fontSize={tk.label.length > 2 ? 1.6 : 2.2} fontWeight={600} fill="var(--color-bg)" pointerEvents="none">
                  {tk.label}
                </text>
              )}
            </g>
          );
        })}
      {over.map((d) => (
        <Drawing key={d.id} r={d} selected={d.id === selected} onPick={onPickDrawing} />
      ))}
      {children}
    </Pitch>
  );
}

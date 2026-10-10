import type { Ref } from "react";
import { PITCH } from "@/lib/types";

export const COLORS = {
  own: "#2a78d6",
  opp: "#eb6834",
  ball: "#0b0b0b",
  grass: "#f1f5ee",
  line: "#a3b0a0",
};

const L = PITCH.length;
const W = PITCH.width;

export function toMeters(svg: SVGSVGElement, e: { clientX: number; clientY: number }): { x: number; y: number } {
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
  return { x: Math.min(L, Math.max(0, p.x)), y: Math.min(W, Math.max(0, p.y)) };
}

type Props = React.SVGProps<SVGSVGElement> & {
  svgRef?: Ref<SVGSVGElement>;
  // Shows the attack direction of the analysed team (always left to right).
  showDirection?: boolean;
};

// Pitch in meters (105 x 68), origin top-left, same convention as the data contract.
export function Pitch({ children, svgRef, showDirection = true, className = "", ...rest }: Props) {
  const line = { fill: "none", stroke: COLORS.line, strokeWidth: 0.35 };
  return (
    <svg ref={svgRef} viewBox={`-2 -2 ${L + 4} ${W + (showDirection ? 8 : 4)}`} className={`w-full select-none ${className}`} {...rest}>
      <rect x={0} y={0} width={L} height={W} fill={COLORS.grass} stroke={COLORS.line} strokeWidth={0.35} />
      <line x1={L / 2} y1={0} x2={L / 2} y2={W} {...line} />
      <circle cx={L / 2} cy={W / 2} r={9.15} {...line} />
      <rect x={0} y={W / 2 - 20.16} width={16.5} height={40.32} {...line} />
      <rect x={L - 16.5} y={W / 2 - 20.16} width={16.5} height={40.32} {...line} />
      <rect x={0} y={W / 2 - 9.16} width={5.5} height={18.32} {...line} />
      <rect x={L - 5.5} y={W / 2 - 9.16} width={5.5} height={18.32} {...line} />
      <rect x={-1.5} y={W / 2 - 3.66} width={1.5} height={7.32} {...line} />
      <rect x={L} y={W / 2 - 3.66} width={1.5} height={7.32} {...line} />
      <circle cx={11} cy={W / 2} r={0.4} fill={COLORS.line} />
      <circle cx={L - 11} cy={W / 2} r={0.4} fill={COLORS.line} />
      {showDirection && (
        <text x={L / 2} y={W + 4.2} textAnchor="middle" fontSize={2.6} fill="#52514e">
          Ataque del equipo analizado →
        </text>
      )}
      {children}
    </svg>
  );
}

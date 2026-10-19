"use client";

import { useId } from "react";

// How a tracked person is marked over the video. The box shows what the detector saw (its limits, who it took);
// the oval sits on the ground under her feet with the name along its edge (it hides the least of the play); the
// arrow floats over her head, like a video game marker.
export type LabelStyle = "box" | "oval" | "arrow";
export const LABEL_STYLES: { id: LabelStyle; label: string; key: string }[] = [
  { id: "box", label: "Caja", key: "B" },
  { id: "oval", label: "Óvalo", key: "O" },
  { id: "arrow", label: "Flecha", key: "V" },
];

type Props = {
  // [x1, y1, x2, y2] in video pixels; y2 is the feet.
  box: [number, number, number, number];
  color: string;
  label?: string;
  style: LabelStyle;
  // Base size of marks in video pixels (the overlay's dotR).
  unit: number;
  strong?: boolean;
  dashed?: boolean;
};

export function PlayerMark({ box, color, label, style, unit, strong = false, dashed = false }: Props) {
  const id = useId();
  const [x1, y1, x2, y2] = box;
  const cx = (x1 + x2) / 2;
  const w = x2 - x1;
  const stroke = strong ? unit / 2 : unit / 3.5;
  const dash = dashed ? `${unit} ${unit / 2}` : undefined;
  const font = unit * (strong ? 3.2 : 2.8);
  // Plain text in the mark's color; only a faint dark edge so it reads over grass and white lines.
  const text = {
    fill: color,
    fontSize: font,
    fontFamily: "var(--font-archivo), sans-serif",
    fontWeight: strong ? 700 : 600,
    stroke: "rgba(0,0,0,.45)",
    strokeWidth: unit / 7,
    paintOrder: "stroke" as const,
  };
  if (style === "box") {
    return (
      <g pointerEvents="none">
        <rect x={x1} y={y1} width={w} height={y2 - y1} fill="transparent" stroke={color} strokeWidth={stroke} strokeDasharray={dash} />
        {label && (
          <text x={cx} y={y1 - unit / 2} textAnchor="middle" style={text}>
            {label}
          </text>
        )}
      </g>
    );
  }
  if (style === "arrow") {
    const s = Math.max(unit * 1.6, w * 0.32);
    const top = y1 - unit * 0.8 - s;
    return (
      <g pointerEvents="none">
        <path d={`M${cx - s / 2} ${top} L${cx + s / 2} ${top} L${cx} ${top + s * 0.85} Z`} fill={color} opacity={strong ? 1 : 0.9} stroke={dash ? color : "none"} />
        {label && (
          <text x={cx} y={top - unit * 0.5} textAnchor="middle" style={text}>
            {label}
          </text>
        )}
      </g>
    );
  }
  // Oval: on the ground, a little wider than the body, flattened by the camera angle.
  const rx = Math.max(unit * 1.6, w * 0.75);
  const ry = rx * 0.32;
  const tx = rx + unit * 0.9;
  const ty = ry + font + unit * 0.3;
  return (
    <g pointerEvents="none">
      <ellipse cx={cx} cy={y2} rx={rx} ry={ry} fill={strong ? "rgba(255,255,255,.12)" : "rgba(0,0,0,.12)"} stroke={color} strokeWidth={stroke} strokeDasharray={dash} />
      {label && (
        <>
          <path id={id} d={`M${cx - tx} ${y2} A${tx} ${ty} 0 0 0 ${cx + tx} ${y2}`} fill="none" stroke="none" />
          <text style={text} textAnchor="middle">
            <textPath href={`#${id}`} startOffset="50%">
              {label}
            </textPath>
          </text>
        </>
      )}
    </g>
  );
}

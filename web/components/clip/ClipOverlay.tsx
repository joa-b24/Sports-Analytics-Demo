import { DRAW_COLOR_VAR } from "@/components/board/BoardView";
import { DRAW_PX, type Projected, type Pt } from "@/lib/annotations";

const pts = (ps: Pt[]) => ps.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");

// Drawings already projected on the frame, in pixels of the original video (the SVG has its size as viewBox and lies
// over the video, both fitted the same way in a 16:9 box).
// Drawings lie on the ground: they cast a soft shadow, and the players stand in front of them (`bodies`, boxes in
// video pixels estimated from each player's position, are cut out of the drawings).
export function ClipDrawings({
  items,
  image,
  selected = null,
  onPick,
  bodies = [],
}: {
  items: Projected[];
  image: { w: number; h: number };
  selected?: string | null;
  onPick?: (id: string) => void;
  bodies?: [number, number, number, number][];
}) {
  const k = image.h / 1080;
  return (
    <>
      <defs>
        <filter id="clip-shadow" x="-10%" y="-10%" width="120%" height="130%">
          <feDropShadow dx="0" dy={4 * k} stdDeviation={3 * k} floodColor="#000" floodOpacity="0.45" />
        </filter>
        <mask id="clip-bodies" maskUnits="userSpaceOnUse" x="0" y="0" width={image.w} height={image.h}>
          <rect x="0" y="0" width={image.w} height={image.h} fill="#fff" />
          {bodies.map(([x, y, w, h], i) => (
            <rect key={i} x={x} y={y} width={w} height={h} rx={w / 2} fill="#000" />
          ))}
        </mask>
      </defs>
      <g mask="url(#clip-bodies)" filter="url(#clip-shadow)">
      {items.map((d) => {
        const color = DRAW_COLOR_VAR[d.style.color] ?? DRAW_COLOR_VAR.accent;
        const width = DRAW_PX.stroke * k * (d.id === selected ? 1.6 : 1);
        const dash = d.style.dashed ? `${14 * k} ${10 * k}` : undefined;
        const hit = onPick
          ? {
              onPointerDown: (e: React.PointerEvent) => {
                e.stopPropagation();
                onPick(d.id);
              },
              className: "cursor-pointer",
            }
          : { pointerEvents: "none" as const };
        return (
          <g key={d.id} className="ann-in">
            {d.paths.map((p, i) =>
              d.closed ? (
                <polygon key={i} points={pts(p)} fill={color} fillOpacity={d.kind === "zone" ? 0.22 : 0.12} stroke={color} strokeWidth={width} strokeDasharray={dash} strokeLinejoin="round" {...hit} />
              ) : (
                <g key={i}>
                  {onPick && <polyline points={pts(p)} fill="none" stroke="transparent" strokeWidth={width * 5} {...hit} />}
                  <polyline points={pts(p)} fill="none" stroke={color} strokeWidth={width} strokeDasharray={dash} strokeLinecap="round" strokeLinejoin="round" pointerEvents="none" />
                </g>
              ),
            )}
            {d.head && <polygon points={pts(d.head)} fill={color} pointerEvents="none" />}
            {d.text && (
              <text
                x={d.text.at[0]}
                y={d.text.at[1]}
                textAnchor="middle"
                fontSize={(d.kind === "text" ? DRAW_PX.text : DRAW_PX.label) * k}
                fontWeight={700}
                fill={color}
                stroke="#000"
                strokeOpacity={0.75}
                strokeWidth={DRAW_PX.outline * k}
                paintOrder="stroke"
                {...(d.kind === "text" ? hit : { pointerEvents: "none" as const })}
              >
                {d.text.value}
              </text>
            )}
          </g>
        );
      })}
      </g>
    </>
  );
}

"use client";

import type { Pt } from "@/lib/homography";
import type { Venue } from "@/lib/venue";
import { REFERENCE_GROUPS, goalSegments, stripeBands } from "@/lib/venueFit";

// The venue model drawn through `map` (meters -> drawing units): the top-view diagram uses meters as they are, the
// image editor maps them into the fitted rectangle. `px` draws strokes in screen pixels (for a zoomable image);
// `unit` is one screen pixel in drawing units, for the size of the dots.

const GOAL_DEPTH_M = 1.5;

type Props = {
  venue: Venue;
  map: (p: Pt) => Pt;
  px: boolean;
  unit: number;
  // Reference group to highlight (lib/venueFit.ts REFERENCE_GROUPS).
  focus?: string | null;
};

export function ModelDrawing({ venue, map, px, unit, focus = null }: Props) {
  const L = venue.length_m;
  const W = venue.width_m;
  const spec = venue.spec;
  const pts = (list: Pt[]) => list.map((p) => map(p).map((v) => v.toFixed(3)).join(",")).join(" ");
  const stroke = (meters: number, pixels: number) => (px ? { strokeWidth: pixels, vectorEffect: "non-scaling-stroke" as const } : { strokeWidth: meters });
  const goals = goalSegments(L, W, spec.goal_width_m);
  const group = focus ? REFERENCE_GROUPS.find((g) => g.id === focus) : null;
  const focused = group ? venue.landmarks.filter((l) => group.ids(l.id, l.group)) : [];

  return (
    <g>
      {(spec.layers ?? []).map((layer) =>
        layer.kind === "stripes"
          ? stripeBands(layer, L, W).map(([x0, y0, x1, y1], n) => (
              <polygon
                key={`${layer.id}-${n}`}
                points={pts([
                  [x0, y0],
                  [x1, y0],
                  [x1, y1],
                  [x0, y1],
                ])}
                fill={layer.color}
                opacity={0.22}
              />
            ))
          : null,
      )}
      {venue.lines.map((l, n) => (
        <polyline
          key={n}
          points={pts(l.pts)}
          fill="none"
          stroke={l.group === "football" ? venue.colors.football : venue.colors.soccer}
          opacity={l.group === "football" ? 0.75 : 1}
          {...stroke(l.group === "football" ? 0.22 : 0.32, l.group === "football" ? 1.2 : 1.6)}
        />
      ))}
      {(spec.layers ?? []).map((layer) =>
        layer.kind === "line" ? <polyline key={layer.id} points={pts(layer.pts)} fill="none" stroke={layer.color} strokeDasharray={px ? "6 4" : "1 0.6"} {...stroke(0.25, 1.4)} /> : null,
      )}
      {goals?.map(([a, b], n) => {
        const back = n === 0 ? -GOAL_DEPTH_M : GOAL_DEPTH_M;
        return (
          <g key={n} fill="none" stroke={venue.colors.soccer}>
            <polyline
              points={pts([a, [a[0] + back, a[1]], [b[0] + back, b[1]], b])}
              opacity={0.55}
              {...stroke(0.15, 1)}
            />
            <polyline points={pts([a, b])} {...stroke(0.6, 3)} />
          </g>
        );
      })}
      {venue.landmarks
        .filter((l) => l.group === "hash")
        .map((l) => {
          const [u, v] = map([l.x, l.y]);
          return <circle key={l.id} cx={u} cy={v} r={unit * 1.6} fill={venue.colors.football} />;
        })}
      {focused.map((l) => {
        const [u, v] = map([l.x, l.y]);
        return (
          <g key={l.id}>
            <circle cx={u} cy={v} r={unit * 7} className="fill-accent/25 stroke-accent-300" strokeWidth={unit * 1.5} />
            <circle cx={u} cy={v} r={unit * 2} className="fill-accent-200" />
          </g>
        );
      })}
    </g>
  );
}

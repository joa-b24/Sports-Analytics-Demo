"use client";

// What the camera sees, on a pitch drawing (normalised 105 x 68): the view a little lighter, everything else in
// shadow, no outline. Whoever is in the shadow is not absent, only out of the picture.
export function ViewShade({ poly }: { poly: [number, number][] | null | undefined }) {
  if (!poly || poly.length < 3) return null;
  const inner = poly.map(([x, y]) => `${x},${y}`).join(" L");
  return (
    <g pointerEvents="none" aria-hidden>
      <path d={`M-2,-2 H107 V70 H-2 Z M${inner} Z`} fillRule="evenodd" fill="#000" opacity={0.45} />
      <path d={`M${inner} Z`} fill="#fff" opacity={0.07} />
    </g>
  );
}

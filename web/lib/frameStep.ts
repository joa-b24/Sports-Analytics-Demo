// Stepping a video by frames. The time of a frame is frame / fps of the video (t_video = start of the segment + frame / fps);
// stepping goes from frame to frame, never by a fixed fraction of a second. Pure functions.

// Frame rate used when the video's is not known (said on screen, never silently).
export const FALLBACK_FPS = 30;

export const frameOf = (t: number, fps: number) => Math.round(t * fps);
export const timeOfFrame = (frame: number, fps: number) => frame / fps;

// The time `frames` frames after (or before, negative) t, on the frame grid and inside [min, max].
export function stepTime(t: number, fps: number, frames: number, min = 0, max = Infinity): number {
  const f = Math.round(t * fps) + frames;
  const lo = Math.ceil(min * fps - 1e-6);
  const hi = Math.floor(max * fps + 1e-6);
  return Math.min(hi, Math.max(lo, f)) / fps;
}

// «cuadro 1234 (+12)»: the frame of the video, and the frames since the start of the clip.
export function frameLabel(t: number, fps: number, clipStart: number): string {
  const f = frameOf(t, fps);
  const d = f - frameOf(clipStart, fps);
  return `cuadro ${f} (${d >= 0 ? "+" : ""}${d})`;
}

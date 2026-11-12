// The frame range a tracking file name carries (tracks_..._<start>_<end>.json), and the rule that keeps the figures from counting
// a stretch twice. Pure: no file access.
export const range = (name: string): [number, number] => {
  const m = name.match(/_(\d+)_(\d+)\.json$/);
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
};

// Corrected parts of one video where one lies completely inside another (typically the pieces and the file that joins them,
// «exportar varias partes unidas»): the figures would count that stretch twice (distance, sprints, heat maps). The older of the
// two is left out: the newer one is the last word on that stretch. Partial overlaps are kept as they are.
export function withoutCovered<T extends { name: string; mtime?: number }>(entries: T[]): T[] {
  return entries.filter((e) => {
    const [a, b] = range(e.name);
    return !entries.some((o) => {
      if (o === e) return false;
      const [c, d] = range(o.name);
      // Inside the other one (a different file, so a wider or shifted range): it goes when the other is not older.
      return c <= a && b <= d && (o.mtime ?? 0) >= (e.mtime ?? 0);
    });
  });
}

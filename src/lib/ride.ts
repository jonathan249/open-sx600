/** Pure ride-timing helpers, kept free of browser APIs so they can be unit-tested. */

export type Clock = {
  startedAt: number;
  pausedMs: number; // total time spent paused so far
  pausedSince: number | null; // set while paused (manual or auto)
};

export function elapsedMs(c: Clock, now: number) {
  const pausedNow = c.pausedSince == null ? 0 : now - c.pausedSince;
  return Math.max(0, now - c.startedAt - c.pausedMs - pausedNow);
}

export function pause(c: Clock, now: number): Clock {
  return c.pausedSince == null ? { ...c, pausedSince: now } : c;
}

export function resume(c: Clock, now: number): Clock {
  return c.pausedSince == null ? c : { ...c, pausedMs: c.pausedMs + (now - c.pausedSince), pausedSince: null };
}

/** Averages consecutive points into at most `max` buckets (for long-ride charts). */
export function downsample<T extends { t: number }>(rows: T[], max: number): T[] {
  if (rows.length <= max) return rows;
  const size = Math.ceil(rows.length / max);
  const out: T[] = [];
  for (let i = 0; i < rows.length; i += size) {
    const bucket = rows.slice(i, i + size);
    const merged: Record<string, number | undefined> = { t: bucket[0].t };
    for (const key of Object.keys(bucket[0])) {
      if (key === "t") continue;
      const vals = bucket.map((r) => (r as Record<string, unknown>)[key]).filter((v): v is number => typeof v === "number");
      merged[key] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : undefined;
    }
    out.push(merged as T);
  }
  return out;
}

/** Seconds of power to integrate between two samples; caps gaps (e.g. after a dropout). */
export function integrationSeconds(prevMs: number, nowMs: number, capS = 5) {
  return Math.min(capS, Math.max(0, (nowMs - prevMs) / 1000));
}

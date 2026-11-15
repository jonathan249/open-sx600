/**
 * Pure helpers for the History view: weekly totals, date grouping and per-ride analysis.
 * Free of browser APIs so they can be unit-tested. Weeks start on Monday, in local time.
 */
import type { Ride, RideSample } from "./store";

/** Local midnight of the Monday of the week containing `t`. */
export function weekStart(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  const sinceMonday = (d.getDay() + 6) % 7; // Sunday → 6
  d.setDate(d.getDate() - sinceMonday);
  return d.getTime();
}

export type WeekTotal = { start: number; seconds: number; rides: number; workKj: number };

/** Riding time per week for the last `weeks` weeks, oldest first, including empty weeks. */
export function weeklyTotals(rides: Pick<Ride, "startedAt" | "durationS" | "stats">[], weeks: number, now: number): WeekTotal[] {
  const current = weekStart(now);
  const out: WeekTotal[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    // Step back by calendar days, not 7×24 h, so DST changes can't shift the boundary.
    const d = new Date(current);
    d.setDate(d.getDate() - 7 * i);
    out.push({ start: d.getTime(), seconds: 0, rides: 0, workKj: 0 });
  }
  const index = new Map(out.map((w, i) => [w.start, i]));
  for (const r of rides) {
    const i = index.get(weekStart(r.startedAt));
    if (i == null) continue;
    out[i].seconds += r.durationS;
    out[i].rides += 1;
    out[i].workKj += r.stats.workKj;
  }
  return out;
}

/**
 * Duration-weighted average heart rate, so a 5-minute spin doesn't count as much as an hour.
 * Rides without heart rate are left out entirely. Undefined when none has any.
 */
export function avgHeartRate(rides: Pick<Ride, "durationS" | "stats">[]): number | undefined {
  let sum = 0;
  let seconds = 0;
  for (const r of rides) {
    if (!r.stats.avgHeartRate || !(r.durationS > 0)) continue;
    sum += r.stats.avgHeartRate * r.durationS;
    seconds += r.durationS;
  }
  return seconds ? sum / seconds : undefined;
}

/** Groups rides (newest first) under "This week", "Last week", then month names. */
export function groupRides<T extends Pick<Ride, "startedAt">>(rides: T[], now: number): { label: string; rides: T[] }[] {
  const thisWeek = weekStart(now);
  const lastWeekDate = new Date(thisWeek);
  lastWeekDate.setDate(lastWeekDate.getDate() - 7);
  const lastWeek = lastWeekDate.getTime();
  const groups: { label: string; rides: T[] }[] = [];
  for (const r of rides) {
    const label =
      r.startedAt >= thisWeek
        ? "This week"
        : r.startedAt >= lastWeek
          ? "Last week"
          : new Date(r.startedAt).toLocaleDateString(undefined, { month: "long", year: "numeric" });
    const last = groups.at(-1);
    if (last?.label === label) last.rides.push(r);
    else groups.push({ label, rides: [r] });
  }
  return groups;
}

/** Seconds spent in each of the five zones. Each sample counts for the time since the previous one. */
export function timeInZones(samples: RideSample[], zones: readonly number[]): number[] {
  const out = [0, 0, 0, 0, 0];
  let prevT: number | undefined;
  for (const s of samples) {
    // Normally 1 s; longer when ticks were throttled, capped so a gap isn't counted as riding.
    const dt = prevT == null ? 1 : Math.min(10, Math.max(0, s.t - prevT));
    prevT = s.t;
    if (!s.hr) continue;
    let z = zones.findIndex((limit) => s.hr! <= limit);
    if (z === -1) z = 4;
    out[z] += dt;
  }
  return out;
}

export function maxOf(samples: RideSample[], key: "p" | "hr" | "c"): number | undefined {
  let max: number | undefined;
  for (const s of samples) {
    const v = s[key];
    if (v != null && (max == null || v > max)) max = v;
  }
  return max;
}

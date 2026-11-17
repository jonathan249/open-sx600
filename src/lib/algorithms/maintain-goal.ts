/**
 * Goal-driven resistance control: keeps heart rate inside a target band during a workout step.
 *
 * The ride engine calls `updateIntensity` once per check window (GOAL_CHECK_S) with the
 * window's average heart rate and cadence, the heart rate of the previous window (for the
 * trend) and the current resistance. It answers whether to hold, raise or lower resistance.
 *
 * Rules:
 * - No heart rate, or barely pedalling: hold (changing resistance can't help).
 * - Below the band: raise by 1 (2 when far below), but only at a decent cadence; at a low
 *   cadence the rider should spin faster first. Hold if HR is already climbing fast.
 * - Above the band: lower by 1, by 2 at a low cadence (grinding) or far above the band.
 *   At a high cadence the rider is asked to spin slower instead, unless HR is far above the
 *   band. Hold if HR is already falling fast.
 * - Inside the band: hold.
 */
import { clampResistance } from "../sx600/fitshow";

export type HrGoal = { low: number; high: number };

export type GoalInput = {
  hr: number | undefined; // average bpm over the last window
  prevHr?: number; // average bpm over the window before, for the trend
  rpm: number; // average cadence over the last window
  intensity: number; // current resistance level
  goal: HrGoal;
};

export type GoalAction = "hold" | "increase" | "decrease";
export type GoalDecision = { intensity: number; action: GoalAction; reason: string };

export const GOAL_CHECK_S = 60;

const MIN_RPM = 40; // below this the rider is barely pedalling
const RAISE_MIN_RPM = 85; // only add resistance when spinning at least this fast
const GRIND_RPM = 80; // above the band and slower than this: drop 2 levels
const SPIN_RPM = 90; // above the band and at least this fast: slow the cadence first
const FAR_BPM = 10; // this far outside the band counts as "far"
const TREND_BPM = 5; // change per window that already moves HR toward the band

export function updateIntensity({ hr, prevHr, rpm, intensity, goal }: GoalInput): GoalDecision {
  const hold = (reason: string): GoalDecision => ({ intensity, action: "hold", reason });
  const to = (next: number, reason: string): GoalDecision => {
    const level = clampResistance(next);
    if (level === intensity) return hold(`${reason} (already at the limit)`);
    return { intensity: level, action: level > intensity ? "increase" : "decrease", reason };
  };

  if (hr == null) return hold("no heart rate");
  if (rpm < MIN_RPM) return hold("not pedalling");
  const trend = prevHr == null ? 0 : hr - prevHr;

  if (hr < goal.low) {
    if (trend >= TREND_BPM) return hold("below goal but rising");
    if (rpm < RAISE_MIN_RPM) return hold("below goal · raise cadence");
    return to(intensity + (goal.low - hr > FAR_BPM ? 2 : 1), "below goal");
  }
  if (hr > goal.high) {
    const far = hr - goal.high > FAR_BPM;
    if (trend <= -TREND_BPM && !far) return hold("above goal but falling");
    if (rpm >= SPIN_RPM && !far) return hold("above goal · lower cadence");
    return to(intensity - (rpm < GRIND_RPM || far ? 2 : 1), "above goal");
  }
  return hold("in goal");
}

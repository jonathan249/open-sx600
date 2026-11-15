import { describe, expect, test } from "bun:test";
import { avgHeartRate, groupRides, maxOf, timeInZones, weeklyTotals, weekStart } from "./history";

// Local-time dates so the tests hold in any timezone.
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();
const ride = (t: number, durationS = 1800, workKj = 300) => ({ startedAt: t, durationS, stats: { workKj } as never });

describe("weekStart", () => {
  test("is the Monday at midnight", () => {
    expect(weekStart(at(2026, 11, 15))).toBe(new Date(2026, 10, 9).getTime()); // Sun → Mon 9 Nov
    expect(weekStart(at(2026, 11, 9, 0))).toBe(new Date(2026, 10, 9).getTime()); // Monday itself
    expect(weekStart(at(2026, 11, 10))).toBe(new Date(2026, 10, 9).getTime());
  });
});

describe("weeklyTotals", () => {
  const now = at(2026, 11, 15);
  test("returns every week, oldest first, with totals", () => {
    const weeks = weeklyTotals([ride(at(2026, 11, 14)), ride(at(2026, 11, 10), 600, 100), ride(at(2026, 11, 3))], 3, now);
    expect(weeks).toHaveLength(3);
    expect(weeks.map((w) => w.rides)).toEqual([0, 1, 2]);
    expect(weeks[2]).toMatchObject({ seconds: 2400, workKj: 400 });
  });

  test("ignores rides outside the window", () => {
    expect(weeklyTotals([ride(at(2025, 1, 1))], 4, now).every((w) => w.rides === 0)).toBe(true);
  });
});

describe("groupRides", () => {
  test("groups by this week, last week, then month", () => {
    const now = at(2026, 11, 15);
    const rides = [ride(at(2026, 11, 14)), ride(at(2026, 11, 12)), ride(at(2026, 11, 5)), ride(at(2026, 10, 20)), ride(at(2026, 10, 2))];
    const groups = groupRides(rides, now);
    expect(groups.map((g) => g.rides.length)).toEqual([2, 1, 2]);
    expect(groups[0].label).toBe("This week");
    expect(groups[1].label).toBe("Last week");
  });
});

describe("ride analysis", () => {
  const samples = [{ t: 1, hr: 110, p: 100 }, { t: 2, hr: 130, p: 250 }, { t: 3, hr: 180 }, { t: 4, p: 90 }, { t: 5, hr: 140 }];

  test("timeInZones counts seconds per zone, skipping missing HR", () => {
    expect(timeInZones(samples, [120, 140, 155, 170])).toEqual([1, 2, 0, 0, 1]);
  });

  test("timeInZones weights samples by the time since the previous one", () => {
    expect(timeInZones([{ t: 1, hr: 110 }, { t: 4, hr: 110 }, { t: 100, hr: 180 }], [120, 140, 155, 170])).toEqual([4, 0, 0, 0, 10]);
  });

  test("maxOf", () => {
    expect(maxOf(samples, "p")).toBe(250);
    expect(maxOf(samples, "hr")).toBe(180);
    expect(maxOf([], "c")).toBeUndefined();
  });
});

describe("avgHeartRate", () => {
  const r = (durationS: number, avgHeartRate?: number) => ({ durationS, stats: { avgHeartRate } as never });
  test("weights by duration and ignores rides without heart rate", () => {
    expect(avgHeartRate([r(3600, 120), r(600, 180), r(1800, 0), r(1800)])).toBeCloseTo((3600 * 120 + 600 * 180) / 4200);
  });
  test("is undefined without heart rate", () => {
    expect(avgHeartRate([r(1800, 0)])).toBeUndefined();
    expect(avgHeartRate([])).toBeUndefined();
  });
});

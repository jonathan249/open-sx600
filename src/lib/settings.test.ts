import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS, hrZone, normalizeSettings } from "./settings";

describe("normalizeSettings", () => {
  test("missing or broken input gives the defaults", () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings("nonsense")).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ hr: 5, ride: [] })).toEqual(DEFAULT_SETTINGS);
  });

  test("keeps valid values and fills gaps", () => {
    const s = normalizeSettings({ ride: { minSaveS: 120 }, quickLevels: [{ name: "Easy", level: 3 }] });
    expect(s.ride).toEqual({ ...DEFAULT_SETTINGS.ride, minSaveS: 120 });
    expect(s.quickLevels[0]).toEqual({ name: "Easy", level: 3 });
    expect(s.quickLevels[1]).toEqual(DEFAULT_SETTINGS.quickLevels[1]);
    expect(s.quickLevels).toHaveLength(4);
  });

  test("clamps out-of-range numbers", () => {
    const s = normalizeSettings({
      quickLevels: [{ name: "  ", level: 99 }],
      hr: { holdS: -4, intervalRounds: 1000 },
      ride: { autoPauseAfterS: 0 },
    });
    expect(s.quickLevels[0]).toEqual({ name: "Recovery", level: 32 });
    expect(s.hr.holdS).toBe(0);
    expect(s.hr.intervalRounds).toBe(50);
    expect(s.ride.autoPauseAfterS).toBe(2);
  });

  test("zone limits always ascend", () => {
    expect(normalizeSettings({ hr: { zones: [150, 140, 130, 120] } }).hr.zones).toEqual([150, 151, 152, 153]);
  });
});

describe("hrZone", () => {
  const zones = [120, 140, 155, 170] as [number, number, number, number];
  test.each([
    [100, 1],
    [120, 1],
    [121, 2],
    [140, 2],
    [155, 3],
    [170, 4],
    [171, 5],
  ])("%p bpm → zone %p", (bpm, zone) => {
    expect(hrZone(bpm, zones)).toBe(zone as 1);
  });
});

describe("normalizeSettings constraints", () => {
  test("recover-until stays below work-until", () => {
    const s = normalizeSettings({ hr: { intervalHigh: 130, intervalLow: 160 } });
    expect(s.hr.intervalLow).toBeLessThan(s.hr.intervalHigh);
  });

  test("zone limits stay strictly increasing even at the top of the range", () => {
    const { zones } = normalizeSettings({ hr: { zones: [230, 230, 230, 230] } }).hr;
    for (let i = 1; i < 4; i++) expect(zones[i]).toBeGreaterThan(zones[i - 1]);
    expect(zones[3]).toBeLessThanOrEqual(230);
  });
});

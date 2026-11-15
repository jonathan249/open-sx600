import { describe, expect, test } from "bun:test";
import {
  checksum,
  clampResistance,
  frame,
  INIT_FRAMES,
  MAX_RESISTANCE,
  parseFitshowData,
  resistanceFrame,
} from "./fitshow";
import { parseIndoorBikeData } from "./ftms";

const dv = (bytes: number[]) => new DataView(Uint8Array.from(bytes).buffer);

describe("fitshow frames", () => {
  test("every resistance frame is well-formed with a valid XOR checksum", () => {
    for (let level = 1; level <= MAX_RESISTANCE; level++) {
      const f = resistanceFrame(level);
      expect(f[0]).toBe(0x02);
      expect(f[f.length - 1]).toBe(0x03);
      expect(f[f.length - 2]).toBe(checksum(f.slice(1, -2)));
      expect(f.slice(1, 3)).toEqual(Uint8Array.from([0x44, 0x05]));
    }
  });

  test("init frames have valid checksums", () => {
    for (const f of INIT_FRAMES) expect(f[f.length - 2]).toBe(checksum(f.slice(1, -2)));
  });

  test("frame() builds the same bytes as the hard-coded ones", () => {
    expect(frame([0x44, 0x05, 0x10, 0x06])).toEqual(resistanceFrame(16));
  });

  test("resistance is clamped to 1..32", () => {
    expect(clampResistance(0)).toBe(1);
    expect(clampResistance(40)).toBe(32);
    expect(clampResistance(7.4)).toBe(7);
  });

  test("parses 15-byte fallback data frame", () => {
    const bytes = [0x02, 0x42, 0x02, 0, 0, 8, 85, 0, 0, 0xe8, 0x03, 0, 0, 0, 0x03];
    expect(parseFitshowData(dv(bytes))).toEqual({ resistance: 8, cadence: 85, power: 100 });
    expect(parseFitshowData(dv([0x02, 0x03]))).toBeNull();
  });
});

describe("FTMS indoor bike data", () => {
  test("parses speed, cadence, resistance, power and heart rate", () => {
    // flags: instCadence | resistance | instPower | heartRate = 0x0264, speed present (bit0 = 0)
    const bytes = [
      0x64, 0x02,
      0xc4, 0x09, // speed 2500 → 25.00 km/h
      0xb4, 0x00, // cadence 180 → 90 rpm
      0x50, 0x00, // resistance 80 → 8.0
      0x96, 0x00, // power 150 W
      0x82, // HR 130
    ];
    expect(parseIndoorBikeData(dv(bytes))).toEqual({
      speedKmh: 25,
      cadenceRpm: 90,
      resistance: 8,
      powerW: 150,
      heartRate: 130,
    });
  });

  test("skips speed when the more-data bit is set and tolerates short packets", () => {
    expect(parseIndoorBikeData(dv([0x01, 0x00]))).toEqual({});
    // flags announce speed + cadence + power, but only one data byte follows
    expect(parseIndoorBikeData(dv([0x44, 0x00, 0x10]))).toEqual({});
  });
});

describe("indoor bike data edge cases", () => {
  test("heart rate 0 (no grip contact) clears the reading instead of being dropped", () => {
    // flags: heartRate (bit 9), speed present; speed 0, HR 0
    const out = parseIndoorBikeData(dv([0x00, 0x02, 0x00, 0x00, 0x00]));
    expect("heartRate" in out).toBe(true);
    expect(out.heartRate).toBeUndefined();
  });

  test("a truncated packet stops parsing rather than misreading later fields", () => {
    // flags: distance (bit 4) + resistance (bit 5), speed present; only 2 bytes left after speed
    const out = parseIndoorBikeData(dv([0x30, 0x00, 0xe8, 0x03, 0x64, 0x00]));
    expect(out.speedKmh).toBe(10);
    expect(out.distanceM).toBeUndefined();
    expect(out.resistance).toBeUndefined();
  });
});

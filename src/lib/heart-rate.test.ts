import { describe, expect, test } from "bun:test";
import { parseHeartRate } from "./heart-rate";

const view = (bytes: number[]) => new DataView(Uint8Array.from(bytes).buffer);

describe("parseHeartRate", () => {
  test("8-bit bpm", () => {
    expect(parseHeartRate(view([0x00, 0x8c]))).toEqual({ bpm: 140 });
  });

  test("16-bit bpm with contact detected", () => {
    // flags: uint16 (0x01) | contact detected (0x02) | contact supported (0x04)
    expect(parseHeartRate(view([0x07, 0x2c, 0x01]))).toEqual({ bpm: 300, contact: true });
  });

  test("no skin contact", () => {
    expect(parseHeartRate(view([0x04, 0x48]))).toEqual({ bpm: 72, contact: false });
  });

  test("RR intervals after energy expended", () => {
    // flags: energy (0x08) | rr (0x10); bpm 60; energy 0x0010; rr 1024/1024 s = 1000 ms, 512 = 500 ms
    expect(parseHeartRate(view([0x18, 60, 0x10, 0x00, 0x00, 0x04, 0x00, 0x02]))).toEqual({ bpm: 60, rrMs: [1000, 500] });
  });

  test("too short", () => {
    expect(parseHeartRate(view([0x01, 0x50]))).toBeNull();
  });
});

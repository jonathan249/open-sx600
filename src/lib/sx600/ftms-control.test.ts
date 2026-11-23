import { describe, expect, test } from "bun:test";
import { parseIndoorBikeData } from "./ftms";
import {
  commands,
  parseControlResponse,
  parseResistanceRange,
  resistanceScale,
  setPowerCommand,
  setResistanceCommand,
  simulationResistanceCommand,
  simulationResistanceLevel,
} from "./ftms-control";

const dv = (bytes: number[]) => new DataView(Uint8Array.from(bytes).buffer);

describe("FTMS control point", () => {
  test("commands", () => {
    expect(commands.requestControl()).toEqual(Uint8Array.from([0x00]));
    expect(commands.start()).toEqual(Uint8Array.from([0x07]));
    expect(commands.pause()).toEqual(Uint8Array.from([0x08, 0x02]));
    expect(commands.stop()).toEqual(Uint8Array.from([0x08, 0x01]));
  });

  test("resistance command for whole-level and 0.1-resolution bikes", () => {
    expect(setResistanceCommand(8, 1)).toEqual(Uint8Array.from([0x04, 8]));
    expect(setResistanceCommand(32, 10)).toEqual(Uint8Array.from([0x04, 0x40, 0x01])); // 320
  });

  test("resistance via simulation parameters matches QZ for ZV- consoles", () => {
    const f = simulationResistanceCommand(8);
    expect(f).toEqual(Uint8Array.from([0x11, 0x00, 0x00, 80, 0x00, 0x28, 0x19]));
    expect(simulationResistanceLevel(f)).toBe(8);
    expect(simulationResistanceCommand(32)).toEqual(Uint8Array.from([0x11, 0x00, 0x00, 0x40, 0x01, 0x28, 0x19]));
  });

  test("power command is little-endian watts", () => {
    expect(setPowerCommand(250)).toEqual(Uint8Array.from([0x05, 0xfa, 0x00]));
    expect(setPowerCommand(-5)).toEqual(Uint8Array.from([0x05, 0, 0]));
  });

  test("parses response indications", () => {
    expect(parseControlResponse(dv([0x80, 0x07, 0x01]))).toEqual({ op: 0x07, result: 0x01 });
    expect(parseControlResponse(dv([0x07, 0x01, 0x01]))).toBeNull();
  });

  test("resistance scale follows the supported range", () => {
    expect(resistanceScale(parseResistanceRange(dv([1, 0, 32, 0, 1, 0])))).toBe(1);
    expect(resistanceScale(parseResistanceRange(dv([10, 0, 0x40, 0x01, 10, 0])))).toBe(10);
    expect(resistanceScale(null)).toBe(1);
  });

  test("indoor bike data resistance uses the given divisor", () => {
    const bytes = [0x21, 0x00, 0x08, 0x00]; // more-data (no speed) + resistance = 8
    expect(parseIndoorBikeData(dv(bytes), 1).resistance).toBe(8);
    expect(parseIndoorBikeData(dv(bytes)).resistance).toBe(0.8);
  });
});

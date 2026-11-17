import { describe, expect, test } from "bun:test";
import { updateIntensity } from "./maintain-goal";

const goal = { low: 130, high: 140 };
const run = (hr: number | undefined, rpm: number, intensity = 10, prevHr?: number) =>
  updateIntensity({ hr, prevHr, rpm, intensity, goal });

describe("updateIntensity", () => {
  test("holds inside the band", () => {
    expect(run(135, 90)).toMatchObject({ action: "hold", intensity: 10 });
  });

  test("holds without heart rate or when barely pedalling", () => {
    expect(run(undefined, 90).action).toBe("hold");
    expect(run(120, 20).action).toBe("hold");
  });

  test("below the band at a good cadence raises resistance (actually changes the value)", () => {
    expect(run(125, 90)).toMatchObject({ action: "increase", intensity: 11 });
    expect(run(110, 90)).toMatchObject({ action: "increase", intensity: 12 }); // far below
  });

  test("below the band at a low cadence asks for cadence first", () => {
    expect(run(125, 80)).toMatchObject({ action: "hold", reason: "below goal · raise cadence" });
  });

  test("below the band but climbing fast holds", () => {
    expect(run(125, 90, 10, 118).action).toBe("hold");
  });

  test("above the band lowers resistance, more when grinding", () => {
    expect(run(145, 85)).toMatchObject({ action: "decrease", intensity: 9 });
    expect(run(145, 70)).toMatchObject({ action: "decrease", intensity: 8 }); // < 80 rpm is reachable now
  });

  test("above the band at a high cadence asks for a lower cadence, unless far above", () => {
    expect(run(145, 95)).toMatchObject({ action: "hold", reason: "above goal · lower cadence" });
    expect(run(155, 95)).toMatchObject({ action: "decrease", intensity: 8 });
  });

  test("above the band but falling fast holds", () => {
    expect(run(145, 85, 10, 152).action).toBe("hold");
  });

  test("stays within the bike's resistance range", () => {
    expect(run(145, 70, 1)).toMatchObject({ action: "hold", intensity: 1 });
    expect(run(110, 90, 32)).toMatchObject({ action: "hold", intensity: 32 });
  });
});

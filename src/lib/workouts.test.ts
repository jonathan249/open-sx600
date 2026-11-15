import { describe, expect, test } from "bun:test";
import {
  advancePlan,
  expandPlan,
  fmtDuration,
  HR_HOLD_S,
  intervalSet,
  isRepeat,
  makeRepeat,
  makeStep,
  parseDurationText,
  type PlanState,
  planProgressS,
  repeatSpan,
  sampleWorkouts,
  totalDuration,
} from "./workouts";

const w = {
  steps: [
    makeStep({ durationS: 60, resistance: 4 }),
    makeStep({ durationS: 120, resistance: 8 }),
  ],
};

describe("workouts", () => {
  test("totalDuration sums step durations", () => {
    expect(totalDuration(w)).toBe(180);
  });

  test("makeStep clamps resistance and enforces a 10 s minimum", () => {
    expect(makeStep({ resistance: 99, durationS: 5 })).toMatchObject({ resistance: 32, durationS: 10 });
  });

  test("sample workouts are valid", () => {
    for (const s of sampleWorkouts()) {
      expect(s.steps.length).toBeGreaterThan(0);
      expect(s.steps.every((x) => isRepeat(x) || (x.resistance >= 1 && x.resistance <= 32))).toBe(true);
    }
  });

  test("fmtDuration", () => {
    expect(fmtDuration(65)).toBe("01:05");
    expect(fmtDuration(3725)).toBe("1:02:05");
  });
});

describe("repeats", () => {
  const warm = makeStep({ label: "Warm", durationS: 60 });
  const [work, rest, rep] = intervalSet(3) as [ReturnType<typeof makeStep>, ReturnType<typeof makeStep>, ReturnType<typeof makeRepeat>];
  const cool = makeStep({ label: "Cool", durationS: 60 });
  const w = { steps: [warm, work, rest, rep, cool] };

  test("expandPlan unrolls the block above a repeat", () => {
    const plan = expandPlan(w);
    expect(plan.map((s) => s.label)).toEqual(["Warm", "Work", "Recover", "Work", "Recover", "Work", "Recover", "Cool"]);
    expect(plan.map((s) => s.round?.n ?? 0)).toEqual([0, 1, 1, 2, 2, 3, 3, 0]);
    expect(new Set(plan.map((s) => s.key)).size).toBe(plan.length);
  });

  test("totalDuration counts every round (HR steps by their cap)", () => {
    expect(totalDuration(w)).toBe(60 + 3 * (300 + 180) + 60);
  });

  test("a repeat never reaches past an earlier repeat", () => {
    const a = makeStep({ label: "A" });
    const b = makeStep({ label: "B" });
    const steps = [a, makeRepeat({ steps: 1, times: 2 }), b, makeRepeat({ steps: 5, times: 2 })];
    expect(expandPlan({ steps }).map((s) => s.label)).toEqual(["A", "A", "B", "B"]);
    expect(repeatSpan(steps, 3)).toBe(1);
  });

  test("a repeat with nothing above it is ignored", () => {
    expect(expandPlan({ steps: [makeRepeat({ times: 4 }), warm] }).map((s) => s.label)).toEqual(["Warm"]);
  });
});

describe("advancePlan", () => {
  const plan = expandPlan({
    steps: [
      makeStep({ label: "Timed", durationS: 60 }),
      makeStep({ label: "Up", durationS: 300, end: { kind: "hr", dir: "above", bpm: 160 } }),
      makeStep({ label: "Down", durationS: 120, end: { kind: "hr", dir: "below", bpm: 130 } }),
    ],
  });
  const start: PlanState = { index: 0, startS: 0, hrMetSinceS: null };

  test("time steps end after their duration", () => {
    expect(advancePlan(plan, start, 59, 150).ended).toBeUndefined();
    const r = advancePlan(plan, start, 60, 150);
    expect(r.ended?.reason).toBe("time");
    expect(r.state).toEqual({ index: 1, startS: 60, hrMetSinceS: null });
    // A late tick doesn't push the next step back.
    expect(advancePlan(plan, start, 63, 150).state.startS).toBe(60);
  });

  test("HR steps end once the target holds for HR_HOLD_S", () => {
    let st: PlanState = { index: 1, startS: 60, hrMetSinceS: null };
    st = advancePlan(plan, st, 70, 161).state; // met
    expect(st.hrMetSinceS).toBe(70);
    expect(advancePlan(plan, st, 70 + HR_HOLD_S - 1, 162).ended).toBeUndefined();
    const r = advancePlan(plan, st, 70 + HR_HOLD_S, 163);
    expect(r.ended?.reason).toBe("hr");
    expect(r.state.index).toBe(2);
  });

  test("a dip below the target restarts the hold", () => {
    let st: PlanState = { index: 1, startS: 60, hrMetSinceS: null };
    st = advancePlan(plan, st, 70, 161).state;
    st = advancePlan(plan, st, 71, 158).state; // dropped out
    expect(st.hrMetSinceS).toBeNull();
    expect(advancePlan(plan, st, 72 + HR_HOLD_S - 1, 161).ended).toBeUndefined();
  });

  test("recovery steps end when HR drops to the target", () => {
    let st: PlanState = { index: 2, startS: 100, hrMetSinceS: null };
    st = advancePlan(plan, st, 110, 129).state;
    expect(advancePlan(plan, st, 110 + HR_HOLD_S, 128).ended?.reason).toBe("hr");
  });

  test("the cap ends an HR step that never reaches its target, also without HR", () => {
    const st: PlanState = { index: 1, startS: 60, hrMetSinceS: null };
    expect(advancePlan(plan, st, 359, undefined).ended).toBeUndefined();
    expect(advancePlan(plan, st, 360, undefined).ended?.reason).toBe("cap");
  });

  test("finished plans stay finished", () => {
    const done: PlanState = { index: 3, startS: 500, hrMetSinceS: null };
    expect(advancePlan(plan, done, 999, 120)).toEqual({ state: done });
  });

  test("planProgressS follows actual step starts, capped at each step's length", () => {
    expect(planProgressS(plan, { index: 1, startS: 60, hrMetSinceS: null }, 90)).toBe(90);
    expect(planProgressS(plan, { index: 1, startS: 60, hrMetSinceS: null }, 9999)).toBe(360);
    expect(planProgressS(plan, { index: 2, startS: 100, hrMetSinceS: null }, 100)).toBe(360);
  });
});

describe("parseDurationText", () => {
  test.each([
    ["1:30", 90],
    ["0:45", 45],
    ["90s", 90],
    ["45 sec", 45],
    ["5", 300],
    ["2.5", 150],
    ["2,5", 150],
    ["3 min", 180],
    [" 10m ", 600],
  ])("%p → %p s", (input, expected) => {
    expect(parseDurationText(input)).toBe(expected);
  });

  test.each(["", "abc", "1:75", "-5", "1:2:3"])("%p is rejected", (input) => {
    expect(parseDurationText(input)).toBeNull();
  });
});

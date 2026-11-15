import { clampResistance } from "./sx600/fitshow";

/**
 * How a step ends. "time" runs for durationS. "hr" ends once heart rate has risen to
 * (`above`) or dropped to (`below`) `bpm` and stayed there for HR_HOLD_S; durationS is then
 * a safety cap, so a step still ends if the target is never reached or HR drops out.
 */
export type StepEnd = { kind: "time" } | { kind: "hr"; dir: "above" | "below"; bpm: number };

export type WorkoutStep = {
  kind?: "step"; // absent on workouts saved before repeats existed
  id: string;
  label: string;
  durationS: number; // time-based length, or the cap for an HR-based step
  resistance: number; // 1–32, applied when the step starts
  cadence?: number; // optional target rpm, shown as a cue only
  end?: StepEnd; // absent means time-based
};

/** Plays the `steps` step rows above it again, so they run `times` times in total. */
export type RepeatItem = { kind: "repeat"; id: string; steps: number; times: number };

export type WorkoutItem = WorkoutStep | RepeatItem;

export type Workout = {
  id: string;
  name: string;
  steps: WorkoutItem[];
  updatedAt: number;
};

/** One step as it plays during a ride, with repeats unrolled. */
export type PlanStep = WorkoutStep & {
  key: string; // unique per played step
  round?: { n: number; of: number };
};

export const HR_HOLD_S = 3;
export const MIN_STEP_S = 10;

/** How many step rows directly above a repeat row it actually covers (stops at an earlier repeat). */
export function repeatSpan(rows: WorkoutItem[], index: number) {
  const r = rows[index];
  if (!r || r.kind !== "repeat") return 0;
  let n = 0;
  for (let j = index - 1; j >= 0 && n < r.steps && rows[j].kind !== "repeat"; j--) n++;
  return n;
}

export const isRepeat = (item: WorkoutItem): item is RepeatItem => item.kind === "repeat";
export const isHrStep = (s: WorkoutStep) => s.end?.kind === "hr";

export const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

/**
 * Unrolls repeat rows into the sequence of steps that actually plays. A repeat takes up to
 * `steps` step rows directly above it (stopping at an earlier repeat) and adds `times - 1`
 * more rounds of them. Steps inside a repeat are labelled with their round.
 */
export function expandPlan(w: Pick<Workout, "steps">): PlanStep[] {
  const out: PlanStep[] = [];
  const rows = w.steps;
  for (let i = 0; i < rows.length; i++) {
    const item = rows[i];
    if (!isRepeat(item)) {
      out.push({ ...item, key: item.id });
      continue;
    }
    const block: WorkoutStep[] = [];
    for (let j = i - 1; j >= 0 && block.length < item.steps; j--) {
      const prev = rows[j];
      if (isRepeat(prev)) break; // blocks never reach past an earlier repeat
      block.unshift(prev);
    }
    const times = Math.max(1, Math.round(item.times));
    if (!block.length || times < 2) continue;
    // Mark the first round (already in `out`) and append the others.
    const firstRound = out.slice(-block.length);
    firstRound.forEach((s, k) => (out[out.length - block.length + k] = { ...s, round: { n: 1, of: times } }));
    for (let n = 2; n <= times; n++) {
      for (const s of block) out.push({ ...s, key: `${s.id}#${item.id}#${n}`, round: { n, of: times } });
    }
  }
  return out;
}

/** Planned length: HR steps count with their cap, so this is the longest the workout can take. */
export function totalDuration(w: Pick<Workout, "steps">) {
  return expandPlan(w).reduce((s, x) => s + x.durationS, 0);
}

export function hasHrSteps(w: Pick<Workout, "steps">) {
  return w.steps.some((s) => !isRepeat(s) && isHrStep(s));
}

/** Where a running workout stands. Kept in the ride session. */
export type PlanState = {
  index: number; // step in the expanded plan; plan.length once finished
  startS: number; // ride elapsed seconds when this step started
  hrMetSinceS: number | null; // since when the HR target has been met continuously
};

export type StepEndReason = "time" | "hr" | "cap";

/**
 * Advances a running workout by one tick. Pure, so it is easy to test: give it the plan,
 * the current state, ride elapsed seconds, the latest heart rate (undefined if none) and how
 * long the HR target must hold.
 * Returns the new state and why the previous step ended, if it did.
 */
export function advancePlan(
  plan: PlanStep[],
  state: PlanState,
  elapsedS: number,
  heartRate: number | undefined,
  holdS = HR_HOLD_S,
): { state: PlanState; ended?: { step: PlanStep; reason: StepEndReason } } {
  const step = plan[state.index];
  if (!step) return { state };
  const inStep = elapsedS - state.startS;

  let hrMetSinceS = state.hrMetSinceS;
  let reason: StepEndReason | undefined;
  if (step.end?.kind === "hr") {
    const { dir, bpm } = step.end;
    const met = heartRate != null && (dir === "above" ? heartRate >= bpm : heartRate <= bpm);
    hrMetSinceS = met ? (hrMetSinceS ?? elapsedS) : null;
    if (hrMetSinceS != null && elapsedS - hrMetSinceS >= holdS) reason = "hr";
    else if (inStep >= step.durationS) reason = "cap";
  } else if (inStep >= step.durationS) {
    reason = "time";
  }

  // Same object when nothing changed, so callers can skip re-rendering.
  if (!reason) return { state: hrMetSinceS === state.hrMetSinceS ? state : { ...state, hrMetSinceS } };
  // Timed (and capped) steps end exactly on schedule, so late ticks don't push the plan back.
  const startS = reason === "hr" ? elapsedS : state.startS + step.durationS;
  return { state: { index: state.index + 1, startS, hrMetSinceS: null }, ended: { step, reason } };
}

/** Seconds of the plan's timeline covered so far, for progress markers (HR steps use their cap). */
export function planProgressS(plan: PlanStep[], state: PlanState, elapsedS: number) {
  let s = 0;
  for (let i = 0; i < Math.min(state.index, plan.length); i++) s += plan[i].durationS;
  const step = plan[state.index];
  return step ? s + Math.min(step.durationS, Math.max(0, elapsedS - state.startS)) : s;
}

export function describeEnd(step: WorkoutStep) {
  if (step.end?.kind !== "hr") return fmtDuration(step.durationS);
  return `until HR ${step.end.dir === "above" ? "≥" : "≤"} ${step.end.bpm} · max ${fmtDuration(step.durationS)}`;
}

export function makeStep(partial: Partial<WorkoutStep> = {}): WorkoutStep {
  return {
    kind: "step",
    id: newId(),
    label: partial.label ?? "Steady",
    durationS: Math.max(MIN_STEP_S, Math.round(partial.durationS ?? 300)),
    resistance: clampResistance(partial.resistance ?? 8),
    cadence: partial.cadence,
    end: partial.end,
  };
}

export function makeRepeat(partial: Partial<Omit<RepeatItem, "kind">> = {}): RepeatItem {
  return { kind: "repeat", id: newId(), steps: Math.max(1, partial.steps ?? 2), times: Math.max(2, partial.times ?? 6) };
}

/** Work until HR rises to `high`, recover until it drops to `low`, `times` times. */
export function intervalSet(times = 6, high = 160, low = 130): WorkoutItem[] {
  return [
    makeStep({ label: "Work", durationS: 300, resistance: 14, cadence: 90, end: { kind: "hr", dir: "above", bpm: high } }),
    makeStep({ label: "Recover", durationS: 180, resistance: 4, cadence: 80, end: { kind: "hr", dir: "below", bpm: low } }),
    makeRepeat({ steps: 2, times }),
  ];
}

export function duplicateWorkout(w: Workout): Workout {
  return {
    ...w,
    id: newId(),
    name: `${w.name} (copy)`,
    updatedAt: Date.now(),
    steps: w.steps.map((s) => ({ ...s, id: newId() })),
  };
}

export function blankWorkout(): Workout {
  return {
    id: newId(),
    name: "New workout",
    updatedAt: Date.now(),
    steps: [makeStep({ label: "Warm-up", durationS: 300, resistance: 4 }), makeStep({ label: "Main set", durationS: 1800 })],
  };
}

export function sampleWorkouts(): Workout[] {
  const now = Date.now();
  return [
    {
      id: newId(),
      name: "Zone 2 · 45 min",
      updatedAt: now,
      steps: [
        makeStep({ label: "Warm-up", durationS: 300, resistance: 4, cadence: 85 }),
        makeStep({ label: "Endurance", durationS: 2100, resistance: 7, cadence: 90 }),
        makeStep({ label: "Cool-down", durationS: 300, resistance: 3, cadence: 85 }),
      ],
    },
    {
      id: newId(),
      name: "HR intervals · 6×",
      updatedAt: now - 2,
      steps: [
        makeStep({ label: "Warm-up", durationS: 600, resistance: 5, cadence: 85 }),
        ...intervalSet(6, 160, 130),
        makeStep({ label: "Cool-down", durationS: 300, resistance: 3, cadence: 85 }),
      ],
    },
    {
      id: newId(),
      name: "Zone 2 build · 60 min",
      updatedAt: now - 1,
      steps: [
        makeStep({ label: "Warm-up", durationS: 600, resistance: 4, cadence: 85 }),
        makeStep({ label: "Endurance", durationS: 1200, resistance: 6, cadence: 90 }),
        makeStep({ label: "Endurance +", durationS: 1200, resistance: 7, cadence: 90 }),
        makeStep({ label: "Cool-down", durationS: 600, resistance: 3, cadence: 85 }),
      ],
    },
  ];
}

/** Duration as typed by a person: "1:30" → 90, "90s" → 90, "5" or "2.5" → minutes. Null when unreadable. */
export function parseDurationText(text: string): number | null {
  const t = text.trim().toLowerCase();
  let m: RegExpExecArray | null;
  if ((m = /^(\d+):([0-5]?\d)$/.exec(t))) return Number(m[1]) * 60 + Number(m[2]);
  if ((m = /^(\d+(?:[.,]\d+)?)\s*s(?:ec)?$/.exec(t))) return Math.round(Number(m[1].replace(",", ".")));
  if ((m = /^(\d+(?:[.,]\d+)?)\s*(?:m|min)?$/.exec(t))) return Math.round(Number(m[1].replace(",", ".")) * 60);
  return null;
}

export function fmtDuration(s: number) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

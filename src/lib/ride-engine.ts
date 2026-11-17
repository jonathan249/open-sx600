/**
 * Ride engine: owns the bike connection, live readings, the running ride and workout playback.
 * Plain TypeScript (no React) with two subscription channels so the UI can re-render cheaply:
 * - live: every Bluetooth packet (power, cadence, …)
 * - state: connection, ride session, stats, chart history (about once per second)
 *
 * Timing uses wall-clock time, not timer ticks, and work is driven by incoming Bluetooth
 * data, so a throttled background tab doesn't distort the ride.
 */
import { GOAL_CHECK_S, type GoalDecision, updateIntensity } from "./algorithms/maintain-goal";
import { debugLog, describeError } from "./debug-log";
import { getSettings } from "./settings";
import { type HeartRateReading, HeartRateSensor, type HrLinkState } from "./heart-rate";
import { type Clock, elapsedMs, integrationSeconds, pause, resume } from "./ride";
import { type Ride, type RideSample, type RideStats, store } from "./store";
import { type BikeData, type LinkState, Sx600 } from "./sx600/bike";
import { clampResistance } from "./sx600/fitshow";
import { advancePlan, expandPlan, newId, type PlanState, type PlanStep, type Workout } from "./workouts";

export type { RideStats };
export type Status = "idle" | "connecting" | "connected" | "reconnecting" | "error";
export type Sample = { t: number } & BikeData;

export type Session = {
  id: string;
  startedAt: number;
  clock: Clock;
  manualPaused: boolean;
  autoPaused: boolean;
  elapsedS: number;
  workout?: Workout;
  /** The workout with repeats unrolled; empty for a free ride. */
  plan: PlanStep[];
  planState: PlanState;
  stepIndex: number; // -1 when free riding or the workout has finished
  stepRemainingS: number; // time left, or left until the cap for an HR step
  finished: boolean;
  /** Heart-rate goal control for the current step; absent when the step has no goal. */
  goal?: GoalState;
};

export type GoalState = {
  stepKey: string; // the played step this belongs to
  checkS: number; // ride elapsed seconds of the last check (or the step start)
  prevHr?: number; // average HR of the previous window, for the trend
  last?: GoalDecision & { atS: number; hr?: number };
};

export type HrState = { status: Status; name?: string; error?: string };

export type EngineState = {
  status: Status;
  error?: string;
  name?: string;
  /** External heart-rate sensor (e.g. a Garmin watch broadcasting HR). Overrides the bike's HR. */
  hr: HrState;
  history: Sample[]; // last HISTORY_SECONDS of live data, 1 Hz
  targetResistance: number;
  session: Session | null;
  stats: RideStats;
};

export type EndResult =
  | { saved: Ride }
  | { saved: null; reason: "discarded" | "too-short" | "no-ride" }
  | { saved: null; reason: "error"; message: string };

/** Any sign of riding: some consoles omit cadence in some packets, so power/speed count too. */
const isMoving = (d: BikeData) => (d.cadenceRpm ?? 0) > 0 || (d.powerW ?? 0) > 0 || (d.speedKmh ?? 0) > 0;

const HISTORY_SECONDS = 180;
const TICK_MS = 1000;
const HR_STALE_MS = 5000;
const CHECKPOINT_EVERY_MS = 30_000;

const emptyStats: RideStats = { elapsedS: 0, avgPower: 0, avgCadence: 0, avgHeartRate: 0, workKj: 0 };
const emptySums = () => ({ n: 0, power: 0, cadence: 0, hr: 0, hrN: 0, joules: 0 });

type Listener = () => void;

export class RideEngine {
  private bike: Sx600 | null = null;
  private live: BikeData = {};
  private state: EngineState = { status: "idle", hr: { status: "idle" }, history: [], targetResistance: 8, session: null, stats: emptyStats };
  private liveListeners = new Set<Listener>();
  private stateListeners = new Set<Listener>();
  private timer?: ReturnType<typeof setInterval>;
  private lastHistoryAt = 0;
  private lastPedalAt = 0;
  private lastSampleAt = 0;
  private lastCheckpointAt = 0;
  private resistanceKnown = false; // target synced from the bike's first reading
  private sums = emptySums();
  private samples: RideSample[] = [];
  private wakeLock: WakeLockSentinel | null = null;
  private hrSensor: HeartRateSensor | null = null;
  private sensorHr?: number;
  private sensorHrAt = 0;

  // --- subscriptions (useSyncExternalStore-compatible) ---------------------
  subscribeLive = (l: Listener) => {
    this.liveListeners.add(l);
    return () => this.liveListeners.delete(l);
  };
  getLive = () => this.live;
  subscribeState = (l: Listener) => {
    this.stateListeners.add(l);
    return () => this.stateListeners.delete(l);
  };
  getState = () => this.state;

  private setState(patch: Partial<EngineState>) {
    this.state = { ...this.state, ...patch };
    this.stateListeners.forEach((l) => l());
  }

  private setLive(next: BikeData) {
    this.live = next;
    this.liveListeners.forEach((l) => l());
  }

  // --- connection -----------------------------------------------------------
  async connect() {
    this.setState({ status: "connecting", error: undefined });
    const bike = new Sx600();
    bike.onData(this.handleData);
    bike.onLinkChange = this.handleLink;
    try {
      await bike.connect();
      this.bike = bike;
      this.resistanceKnown = false;
      this.lastHistoryAt = 0;
      this.setState({ status: "connected", name: bike.name, history: [] });
      this.timer ??= setInterval(() => this.tick(Date.now()), TICK_MS);
    } catch (e) {
      const err = e as Error;
      // User closed the device picker: not an error worth showing.
      if (err.name === "NotFoundError") this.setState({ status: "idle" });
      else {
        debugLog.add({ source: "app", kind: "error", text: `bike connect: ${describeError(err)}` });
        this.setState({ status: "error", error: err.message });
      }
    }
  }

  // --- external heart-rate sensor ------------------------------------------
  async connectHr() {
    this.setState({ hr: { status: "connecting" } });
    const sensor = new HeartRateSensor();
    sensor.onReading = this.handleHr;
    sensor.onLinkChange = this.handleHrLink;
    try {
      await sensor.connect();
      this.hrSensor = sensor;
      this.setState({ hr: { status: "connected", name: sensor.name } });
      this.timer ??= setInterval(() => this.tick(Date.now()), TICK_MS);
    } catch (e) {
      const err = e as Error;
      if (err.name === "NotFoundError") this.setState({ hr: { status: "idle" } });
      else this.setState({ hr: { status: "error", error: err.message } });
    }
  }

  disconnectHr() {
    this.hrSensor?.disconnect();
    this.hrSensor = null;
  }

  private handleHr = (r: HeartRateReading) => {
    const now = Date.now();
    this.sensorHr = r.bpm;
    this.sensorHrAt = now;
    this.setLive({ ...this.live, heartRate: r.bpm });
    this.tick(now);
  };

  private handleHrLink = (link: HrLinkState) => {
    const name = this.state.hr.name;
    if (link === "connected") return this.setState({ hr: { status: "connected", name } });
    this.dropSensorHr();
    this.setState({ hr: { status: link === "reconnecting" ? "reconnecting" : "idle", name } });
    if (link === "disconnected") this.hrSensor = null;
  };

  private dropSensorHr() {
    if (this.sensorHr == null) return;
    this.sensorHr = undefined;
    this.setLive({ ...this.live, heartRate: undefined });
  }

  disconnect() {
    this.bike?.disconnect();
    this.bike = null;
  }

  private handleLink = (link: LinkState) => {
    if (link === "connected") {
      this.setState({ status: "connected" });
      // After a reconnect, resume the console session and re-apply the resistance we want.
      const s = this.state.session;
      if (s && !s.manualPaused) void this.bike?.start();
      if (this.resistanceKnown) void this.bike?.setResistance(this.state.targetResistance);
      return;
    }
    // Stale readings must not keep a ride "pedalling" while the link is down.
    this.setLive(this.sensorHr == null ? {} : { heartRate: this.sensorHr });
    this.setState({ status: link === "reconnecting" ? "reconnecting" : "idle" });
    if (link === "disconnected") this.bike = null;
  };

  private handleData = (data: BikeData) => {
    const now = Date.now();
    // A connected HR sensor wins over the bike's own (hand-grip) heart rate.
    this.setLive(this.sensorHr == null ? { ...this.live, ...data } : { ...this.live, ...data, heartRate: this.sensorHr });
    if (isMoving(data)) this.lastPedalAt = now;
    if (!this.resistanceKnown && data.resistance != null && !this.state.session?.workout) {
      this.resistanceKnown = true;
      this.setState({ targetResistance: clampResistance(data.resistance) });
    }
    this.tick(now);
  };

  // --- resistance -----------------------------------------------------------
  setResistance(level: number) {
    const l = clampResistance(level);
    this.resistanceKnown = true;
    if (l !== this.state.targetResistance) this.setState({ targetResistance: l });
    void this.bike?.setResistance(l);
  }

  // --- ride session ---------------------------------------------------------
  startRide(workout?: Workout) {
    const now = Date.now();
    this.sums = emptySums();
    this.samples = [];
    this.lastSampleAt = now;
    this.lastCheckpointAt = now;
    this.lastPedalAt = isMoving(this.live) ? now : 0;
    // Start the session on the console first; FTMS bikes ignore resistance until started.
    void this.bike?.start();
    const plan = workout ? expandPlan(workout) : [];
    const first = plan[0];
    if (first) this.setResistance(first.resistance);
    this.setState({
      stats: emptyStats,
      session: {
        id: newId(),
        startedAt: now,
        clock: { startedAt: now, pausedMs: 0, pausedSince: null },
        manualPaused: false,
        autoPaused: false,
        elapsedS: 0,
        workout,
        plan,
        planState: { index: 0, startS: 0, hrMetSinceS: null },
        stepIndex: first ? 0 : -1,
        stepRemainingS: first?.durationS ?? 0,
        finished: false,
      },
    });
    this.guardPage(true);
  }

  togglePause() {
    const s = this.state.session;
    if (!s) return;
    const now = Date.now();
    const manualPaused = !s.manualPaused;
    const paused = manualPaused || s.autoPaused;
    void (manualPaused ? this.bike?.pause() : this.bike?.start());
    this.setState({
      session: { ...s, manualPaused, clock: paused ? pause(s.clock, now) : resume(s.clock, now) },
    });
    this.lastSampleAt = now;
  }

  async endRide(discard = false): Promise<EndResult> {
    const s = this.state.session;
    if (!s) return { saved: null, reason: "no-ride" };
    // Bring the clock and stats up to date before deciding anything.
    this.tick(Date.now());
    const current = this.state.session ?? s;

    if (discard || current.elapsedS < getSettings().ride.minSaveS) {
      this.closeSession();
      await store.remove("rides", current.id).catch(() => {}); // drop any checkpoint
      console.info(`[ride] ended without saving (${discard ? "discarded" : `${current.elapsedS}s moving time`})`);
      return { saved: null, reason: discard ? "discarded" : "too-short" };
    }

    // Save first; only end the session once the ride is safely stored.
    const ride = this.buildRide(current, false);
    try {
      await store.put("rides", ride);
    } catch (err) {
      console.error("[ride] saving failed", err);
      return { saved: null, reason: "error", message: (err as Error).message || "Saving failed" };
    }
    this.closeSession();
    console.info(`[ride] saved ${ride.samples.length} samples, ${ride.durationS}s`);
    return { saved: ride };
  }

  private closeSession() {
    this.setState({ session: null });
    this.guardPage(false);
    void this.bike?.stop(); // end the session on the console too (FTMS stop)
  }

  private buildRide(s: Session, partial: boolean): Ride {
    return {
      id: s.id,
      startedAt: s.startedAt,
      durationS: s.elapsedS,
      workoutName: s.workout?.name,
      stats: { ...this.state.stats, elapsedS: s.elapsedS },
      samples: [...this.samples],
      partial: partial || undefined,
    };
  }

  // --- the loop -------------------------------------------------------------
  private tick(now: number) {
    if (this.sensorHr != null && now - this.sensorHrAt > HR_STALE_MS) this.dropSensorHr();
    if (this.state.status === "connected" && now - this.lastHistoryAt >= TICK_MS) {
      this.lastHistoryAt = now;
      const history = [...this.state.history.slice(-(HISTORY_SECONDS - 1)), { t: now, ...this.live }];
      this.setState({ history });
    }

    let s = this.state.session;
    if (!s) return;

    // Auto-pause when not pedalling (also covers a Bluetooth dropout).
    // Off in settings: never auto-pause (the clock also keeps running through a dropout).
    const { autoPause, autoPauseAfterS, minSaveS } = getSettings().ride;
    const pedalling = !autoPause || now - this.lastPedalAt < autoPauseAfterS * 1000;
    if (!pedalling && !s.autoPaused) {
      // Pause from when pedalling stopped, so the idle wait isn't counted as moving time.
      s = { ...s, autoPaused: true, clock: pause(s.clock, Math.min(now, Math.max(this.lastPedalAt, s.clock.startedAt))) };
    } else if (pedalling && s.autoPaused) {
      s = { ...s, autoPaused: false, clock: s.manualPaused ? s.clock : resume(s.clock, now) };
      this.lastSampleAt = now;
    }
    const running = !s.manualPaused && !s.autoPaused;
    const elapsedS = Math.floor(elapsedMs(s.clock, now) / 1000);

    if (running && elapsedS > (this.samples.at(-1)?.t ?? 0)) {
      const d = this.live;
      const acc = this.sums;
      acc.n += 1;
      acc.power += d.powerW ?? 0;
      acc.cadence += d.cadenceRpm ?? 0;
      acc.joules += (d.powerW ?? 0) * integrationSeconds(this.lastSampleAt, now);
      if (d.heartRate) {
        acc.hr += d.heartRate;
        acc.hrN += 1;
      }
      this.lastSampleAt = now;
      this.samples.push({ t: elapsedS, p: d.powerW, c: d.cadenceRpm, hr: d.heartRate, r: d.resistance, v: d.speedKmh });
    }

    // Workout playback. Only advances while the clock runs, so pauses never skip a step.
    let { stepIndex, stepRemainingS, finished, planState } = s;
    if (s.plan.length && !finished && running) {
      const { state, ended } = advancePlan(s.plan, planState, elapsedS, this.live.heartRate, getSettings().hr.holdS);
      planState = state;
      if (ended) {
        const why = ended.reason === "hr" ? `HR target reached (${this.live.heartRate} bpm)` : ended.reason === "cap" ? "HR target not reached, max time" : "time";
        debugLog.add({ source: "app", kind: "info", text: `step "${ended.step.label}" ended: ${why} at ${elapsedS}s` });
        const next = s.plan[planState.index];
        if (next) this.setResistance(next.resistance);
      }
    }
    const goal = this.runGoal(s, planState, elapsedS, running);
    if (s.plan.length && !finished) {
      const step = s.plan[planState.index];
      if (!step) {
        finished = true;
        stepIndex = -1;
        stepRemainingS = 0;
      } else {
        stepIndex = planState.index;
        stepRemainingS = Math.max(0, step.durationS - (elapsedS - planState.startS));
      }
    }

    const acc = this.sums;
    const changed =
      s !== this.state.session ||
      planState !== s.planState ||
      goal !== s.goal ||
      elapsedS !== s.elapsedS ||
      stepIndex !== s.stepIndex ||
      stepRemainingS !== s.stepRemainingS ||
      finished !== s.finished;
    if (changed) {
      this.setState({
        session: { ...s, elapsedS, planState, stepIndex, stepRemainingS, finished, goal },
        stats: {
          elapsedS,
          avgPower: acc.n ? acc.power / acc.n : 0,
          avgCadence: acc.n ? acc.cadence / acc.n : 0,
          avgHeartRate: acc.hrN ? acc.hr / acc.hrN : 0,
          workKj: acc.joules / 1000,
        },
      });
    }

    if (now - this.lastCheckpointAt >= CHECKPOINT_EVERY_MS && elapsedS >= Math.max(minSaveS, 1)) {
      this.lastCheckpointAt = now;
      void store.put("rides", this.buildRide(this.state.session!, true), { silent: true }).catch(() => {});
    }
  }

  /**
   * Heart-rate goal: every GOAL_CHECK_S of riding in a step with a goal band, average the
   * window's heart rate and cadence and let the algorithm hold, raise or lower resistance.
   * Returns the same object when nothing changed.
   */
  private runGoal(s: Session, planState: PlanState, elapsedS: number, running: boolean): GoalState | undefined {
    const step = s.finished ? undefined : s.plan[planState.index];
    if (!step?.hrGoal) return undefined;
    let goal = s.goal?.stepKey === step.key ? s.goal : { stepKey: step.key, checkS: planState.startS };
    if (!running || elapsedS - goal.checkS < GOAL_CHECK_S) return goal;

    let hrSum = 0, hrN = 0, rpmSum = 0, n = 0;
    for (let i = this.samples.length - 1; i >= 0 && this.samples[i].t > goal.checkS; i--) {
      const x = this.samples[i];
      n++;
      rpmSum += x.c ?? 0;
      if (x.hr) {
        hrSum += x.hr;
        hrN++;
      }
    }
    const hr = hrN ? Math.round(hrSum / hrN) : undefined;
    const rpm = n ? rpmSum / n : 0;
    const current = this.state.targetResistance;
    const d = updateIntensity({ hr, prevHr: goal.prevHr, rpm, intensity: current, goal: step.hrGoal });
    if (d.intensity !== current) this.setResistance(d.intensity);
    debugLog.add({
      source: "app",
      kind: "info",
      text: `HR goal ${step.hrGoal.low}–${step.hrGoal.high}: avg HR ${hr ?? "—"}, ${Math.round(rpm)} rpm → ${d.action} (${d.reason}), level ${current}→${d.intensity}`,
    });
    goal = { stepKey: step.key, checkS: elapsedS, prevHr: hr, last: { ...d, atS: elapsedS, hr } };
    return goal;
  }

  // --- keep the page alive while riding -------------------------------------
  private guardPage(on: boolean) {
    if (typeof window === "undefined") return;
    if (on) {
      window.addEventListener("beforeunload", this.onBeforeUnload);
      document.addEventListener("visibilitychange", this.onVisibility);
      void this.acquireWakeLock();
    } else {
      window.removeEventListener("beforeunload", this.onBeforeUnload);
      document.removeEventListener("visibilitychange", this.onVisibility);
      void this.wakeLock?.release().catch(() => {});
      this.wakeLock = null;
    }
  }

  private onBeforeUnload = (e: BeforeUnloadEvent) => {
    e.preventDefault();
  };

  // The browser drops the wake lock when the tab is hidden; take it again on return.
  private onVisibility = () => {
    if (document.visibilityState === "visible" && this.state.session) void this.acquireWakeLock();
  };

  private async acquireWakeLock() {
    try {
      this.wakeLock = (await navigator.wakeLock?.request("screen")) ?? null;
    } catch {
      // not supported or denied (e.g. low battery): the ride still works
    }
  }
}

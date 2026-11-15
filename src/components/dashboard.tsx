"use client";

import { Minus, Plus } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useState } from "react";
import { useBikeState, useEngine, useLive } from "@/components/bike-provider";
import { useBluetoothSupported } from "@/components/connectivity";
import { Btn, ConfirmBtn, IconBtn, Label, num, Readout, Section, StatGrid } from "@/components/kit";
import { Trace } from "@/components/trace";
import { Slider } from "@/components/ui/slider";
import { WorkoutProfile } from "@/components/workout-profile";
import { hrZone, useSettings } from "@/lib/settings";
import { useCollection } from "@/lib/store";
import { MAX_RESISTANCE, MIN_RESISTANCE } from "@/lib/sx600/fitshow";
import { cn } from "@/lib/utils";
import {
  describeEnd,
  expandPlan,
  fmtDuration,
  hasHrSteps,
  type PlanStep,
  planProgressS,
  totalDuration,
  type Workout,
} from "@/lib/workouts";

const clock = (t: number) => new Date(t).toLocaleTimeString();

/** Re-renders on every Bluetooth packet; keep it small. */
function LiveOutput() {
  const live = useLive();
  const hrFromSensor = useBikeState().hr.status === "connected";
  const { zones } = useSettings().hr;
  const zone = live.heartRate ? `Z${hrZone(live.heartRate, zones)}` : undefined;
  const power = num(live.powerW);
  return (
    <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1.2fr_1fr] lg:items-end">
      <div>
        <div className="flex items-baseline gap-4">
          <span className="type-hero font-light tabular-nums tracking-tighter sm:type-hero-lg">
            {/* An em dash is 1em wide, so at hero size it became a solid bar. Keep the line height,
                show a small muted dash like the tiles beside it. */}
            {power === "—" ? <span className="text-5xl text-muted-foreground/50">—</span> : power}
          </span>
          <span className="text-lg text-muted-foreground">W</span>
        </div>
        <Label className="mt-3">Instantaneous power · console estimate</Label>
      </div>
      <div className="grid grid-cols-3 gap-2 [&>*]:min-w-0">
        <Readout label="Cadence" unit="rpm" value={num(live.cadenceRpm)} />
        <Readout
          label={hrFromSensor ? "Heart rate · sensor" : "Heart rate"}
          unit={zone ? `bpm · ${zone}` : "bpm"}
          value={num(live.heartRate)}
        />
        <Readout label="Speed" unit="km/h" value={num(live.speedKmh, 1)} />
      </div>
    </div>
  );
}

/** "45:00", or "up to 52:00" when HR steps can end early. */
function fmtPlanLength(w: Workout) {
  return `${hasHrSteps(w) ? "up to " : ""}${fmtDuration(totalDuration(w))}`;
}

function planSummary(w?: Workout) {
  if (!w) return "no time limit, you set the resistance";
  const plan = expandPlan(w);
  const levels = plan.map((s) => s.resistance);
  const lo = Math.min(...levels);
  const hi = Math.max(...levels);
  const hr = plan.filter((s) => s.end?.kind === "hr").map((s) => (s.end as { bpm: number }).bpm);
  const hrText = hr.length ? ` · HR ${Math.min(...hr)}–${Math.max(...hr)}` : "";
  return `${fmtPlanLength(w)} · ${lo === hi ? `level ${lo}` : `levels ${lo}–${hi}`}${hrText}`;
}

/** Live heart rate against the step's target. Re-renders per packet, so kept small. */
function HrTarget({ step }: { step: PlanStep }) {
  const live = useLive();
  if (step.end?.kind !== "hr") return null;
  const { dir, bpm } = step.end;
  const hr = live.heartRate;
  const met = hr != null && (dir === "above" ? hr >= bpm : hr <= bpm);
  return (
    <span className={cn("tabular-nums", met ? "text-success" : "text-muted-foreground")}>
      {dir === "above" ? "Ride until" : "Recover until"} HR {dir === "above" ? "≥" : "≤"} {bpm} · now {hr ?? "—"}
      {hr == null && " (no HR signal)"}
    </span>
  );
}

function PlanTile({
  name,
  meta,
  selected,
  onSelect,
  preview,
}: {
  name: string;
  meta: string;
  selected: boolean;
  onSelect: () => void;
  preview: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        // One outline only: the selection ring doubles as the focus indicator.
        "flex min-h-28 min-w-0 flex-col gap-3 rounded-xl p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-spot",
        selected ? "bg-spot/10 ring-1 ring-spot/70" : "bg-card hover:bg-card/70",
      )}
    >
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{name}</div>
        <div className="truncate type-label text-muted-foreground">{meta}</div>
      </div>
      <div className="mt-auto flex h-10 w-full">{preview}</div>
    </button>
  );
}

/** The main action works in every state: it connects the bike first, then starts the ride. */
function StartButton({ onStart }: { onStart: () => void }) {
  const engine = useEngine();
  const { status } = useBikeState();
  const supported = useBluetoothSupported();
  if (status === "connected") {
    return (
      <Btn variant="solid" className="shrink-0 px-5" onClick={onStart}>
        Start ride
      </Btn>
    );
  }
  const busy = status === "connecting" || status === "reconnecting";
  return (
    <Btn variant="solid" className="shrink-0 px-5" disabled={busy || !supported} onClick={() => engine.connect()}>
      {!supported ? "Bluetooth unavailable" : status === "connecting" ? "Connecting…" : status === "reconnecting" ? "Reconnecting…" : "Connect bike"}
    </Btn>
  );
}

function RideControl() {
  const engine = useEngine();
  const { session, status } = useBikeState();
  const workouts = useCollection("workouts", (a, b) => b.updatedAt - a.updatedAt);
  const [selected, setSelected] = useState<string>("free");
  const [notice, setNotice] = useState<string>();
  const [finishing, setFinishing] = useState(false);
  const { minSaveS } = useSettings().ride;

  if (!session) {
    const workout = workouts?.find((w) => w.id === selected);
    return (
      <div className="flex flex-1 flex-col gap-5">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 2xl:grid-cols-4">
          <PlanTile
            name="Free ride"
            meta="No time limit"
            selected={!workout}
            onSelect={() => setSelected("free")}
            preview={
              // A level line: you set the resistance yourself.
              <div className={cn("h-[30%] w-full self-end rounded-t-[5px] rounded-b-[2px]", !workout ? "bg-spot" : "bg-spot-soft")} />
            }
          />
          {workouts?.map((w) => (
            <PlanTile
              key={w.id}
              name={w.name}
              meta={`${fmtPlanLength(w)} · ${expandPlan(w).length} steps`}
              selected={workout?.id === w.id}
              onSelect={() => setSelected(w.id)}
              preview={<WorkoutProfile steps={w.steps} fit tone={workout?.id === w.id ? "strong" : "soft"} className="h-full" />}
            />
          ))}
          <Link
            href="/workouts"
            className="flex min-h-28 flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-foreground/15 p-3 text-sm text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
          >
            <Plus className="size-4" strokeWidth={1.5} />
            New plan
          </Link>
        </div>

        {notice && (
          <Label className="text-foreground" role="status">
            {notice}
          </Label>
        )}

        <div className="mt-auto flex items-center gap-4 rounded-xl bg-card py-2 pr-2 pl-4">
          {/* One line that truncates, so the button never wraps below it. */}
          <div className="min-w-0 flex-1 truncate text-sm" title={`${workout?.name ?? "Free ride"} · ${planSummary(workout)}`}>
            <span className="font-medium">{workout?.name ?? "Free ride"}</span>
            <span className="text-muted-foreground"> · {planSummary(workout)}</span>
          </div>
          <StartButton
            onStart={() => {
              setNotice(undefined);
              engine.startRide(workout);
            }}
          />
        </div>
      </div>
    );
  }

  const w = session.workout;
  const step = w && session.stepIndex >= 0 ? session.plan[session.stepIndex] : undefined;
  const next = w && session.stepIndex >= 0 ? session.plan[session.stepIndex + 1] : undefined;
  const roundText = (s: PlanStep) => (s.round ? ` ${s.round.n}/${s.round.of}` : "");
  const stateLabel = session.manualPaused
    ? "Paused"
    : session.autoPaused
      ? status === "connected"
        ? "Auto-paused · start pedalling"
        : "Auto-paused · bike disconnected"
      : "Elapsed";

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-6 md:grid-cols-[1fr_auto] md:items-end">
        <div className="flex flex-wrap items-end gap-x-10 gap-y-4">
          <div>
            <Label className={cn((session.manualPaused || session.autoPaused) && "text-spot")}>{stateLabel}</Label>
            <div className="text-5xl font-light tabular-nums tracking-tight">{fmtDuration(session.elapsedS)}</div>
          </div>
          {w && (
            <div>
              <Label>{session.finished ? "Workout complete" : `Step ${session.stepIndex + 1} / ${session.plan.length}`}</Label>
              <div className="text-xl font-light">
                {step ? (
                  <>
                    {step.label}
                    {roundText(step)} ·{" "}
                    <span className="tabular-nums">{fmtDuration(session.stepRemainingS)}</span>
                    {step.end?.kind === "hr" ? " max" : " left"}
                    {step.cadence ? <span className="text-muted-foreground"> · {step.cadence} rpm</span> : null}
                  </>
                ) : (
                  w.name
                )}
              </div>
              {step?.end?.kind === "hr" && (
                <div className="mt-1 text-sm">
                  <HrTarget step={step} />
                </div>
              )}
              {next && (
                <Label className="mt-1">
                  Next · {next.label}
                  {roundText(next)} · level {next.resistance} · {describeEnd(next)}
                </Label>
              )}
            </div>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Btn onClick={() => engine.togglePause()}>{session.manualPaused ? "Resume" : "Pause"}</Btn>
          <Btn
            variant="solid"
            disabled={finishing}
            onClick={async () => {
              setFinishing(true);
              const result = await engine.endRide();
              setFinishing(false);
              if (result.saved) setNotice(`Ride saved · ${fmtDuration(result.saved.durationS)}`);
              else if (result.reason === "too-short")
                setNotice(`Not saved · under ${fmtDuration(minSaveS)} of moving time`);
              else if (result.reason === "error") setNotice(`Couldn't save the ride: ${result.message}. It's still running; try again.`);
            }}
          >
            Finish
          </Btn>
          <ConfirmBtn variant="ghost" confirmLabel="Discard ride?" onConfirm={() => engine.endRide(true)}>
            Discard
          </ConfirmBtn>
        </div>
      </div>
      {w && (
        <WorkoutProfile
          steps={w.steps}
          progressS={planProgressS(session.plan, session.planState, session.elapsedS)}
          activeIndex={session.finished ? session.plan.length : session.stepIndex}
        />
      )}
      {notice && (
        <Label className="text-spot" role="alert">
          {notice}
        </Label>
      )}
      <Label>
        {session.elapsedS < minSaveS ? `Rides under ${fmtDuration(minSaveS)} of moving time aren't saved · ` : ""}Keep this
        tab open while riding
      </Label>
    </div>
  );
}


const SCALE_MARKS = [1, 8, 16, 24, 32];
const pos = (n: number) => `${((n - MIN_RESISTANCE) / (MAX_RESISTANCE - MIN_RESISTANCE)) * 100}%`;

/** Whether the bike has actually reached the target. Re-renders per packet, so kept small. */
function SyncBadge({ target }: { target: number }) {
  const live = useLive();
  const { status } = useBikeState();
  const bike = live.resistance == null ? undefined : Math.round(live.resistance);
  const [tone, text] =
    status !== "connected"
      ? (["idle", "Bike offline"] as const)
      : bike === undefined
        ? (["wait", "Waiting for bike"] as const)
        : bike === target
          ? (["ok", `Bike at ${String(bike).padStart(2, "0")} · in sync`] as const)
          : (["wait", `Bike at ${String(bike).padStart(2, "0")} · adjusting`] as const);
  return (
    <span className="inline-flex items-center gap-2 rounded-full bg-card px-3 py-1.5 type-label text-muted-foreground">
      <span
        className={cn(
          "size-2 rounded-full",
          tone === "ok" && "bg-success",
          tone === "wait" && "animate-pulse bg-spot",
          tone === "idle" && "bg-muted-foreground/50",
        )}
      />
      {text}
    </span>
  );
}

function ResistanceControl() {
  const engine = useEngine();
  const { status, targetResistance, session } = useBikeState();
  const connected = status === "connected";
  const byWorkout = !!session?.workout && !session.finished;
  const { quickLevels } = useSettings();
  return (
    <div className="flex flex-1 flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <span className="text-6xl leading-none font-light tabular-nums tracking-tight">
          {String(targetResistance).padStart(2, "0")}
        </span>
        <SyncBadge target={targetResistance} />
      </div>

      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-x-4 sm:gap-x-6">
        <IconBtn boxed label="Decrease resistance" disabled={!connected} onClick={() => engine.setResistance(targetResistance - 1)}>
          <Minus className="size-4" strokeWidth={1.5} />
        </IconBtn>
        <div className="flex min-w-0 flex-col gap-3">
          <Slider
            aria-label="Resistance level"
            min={MIN_RESISTANCE}
            max={MAX_RESISTANCE}
            step={1}
            value={targetResistance}
            disabled={!connected}
            onValueChange={(v) => engine.setResistance(v as number)}
          />
          <div className="flex justify-between" aria-hidden>
            {Array.from({ length: MAX_RESISTANCE }, (_, i) => i + 1).map((n) => (
              <span
                key={n}
                className={cn(
                  "w-px",
                  SCALE_MARKS.includes(n) ? "h-3 bg-muted-foreground/60" : "h-1.5 bg-input",
                  n <= targetResistance && "bg-spot",
                )}
              />
            ))}
          </div>
          {/* Labels sit at their real positions on the scale. */}
          <div className="relative h-4 type-micro text-muted-foreground" aria-hidden>
            {SCALE_MARKS.map((n) => (
              <span key={n} className="absolute -translate-x-1/2 tabular-nums" style={{ left: pos(n) }}>
                {String(n).padStart(2, "0")}
              </span>
            ))}
          </div>
        </div>
        <IconBtn boxed label="Increase resistance" disabled={!connected} onClick={() => engine.setResistance(targetResistance + 1)}>
          <Plus className="size-4" strokeWidth={1.5} />
        </IconBtn>
      </div>

      <div className="mt-auto flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <Label>{byWorkout ? "Set by workout · changes at the next step" : "Quick levels"}</Label>
          <Link href="/settings" className="type-label text-muted-foreground hover:text-spot">
            Edit
          </Link>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {quickLevels.map((p) => {
            const active = targetResistance === p.level;
            return (
              <button
                key={p.name + p.level}
                type="button"
                aria-pressed={active}
                disabled={!connected}
                onClick={() => engine.setResistance(p.level)}
                className={cn(
                  "flex flex-col gap-0.5 rounded-xl px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-spot disabled:opacity-50",
                  active ? "bg-spot/10 ring-1 ring-spot/70" : "bg-card enabled:hover:bg-card/70",
                )}
              >
                <span className="text-sm font-medium">{p.name}</span>
                <span className="type-label text-muted-foreground tabular-nums">Level {p.level}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function Dashboard() {
  const { history, stats, session } = useBikeState();

  return (
    <div className="grid grid-cols-1 gap-x-4 xl:grid-cols-2">
      <div className="xl:col-span-2">
      <Section index="01" title="Output" aside={session ? fmtDuration(session.elapsedS) : "No ride running"}>
        <LiveOutput />
      </Section>
      </div>

      <Section index="02" title={session ? "Ride" : "Start a ride"} aside={session?.workout?.name ?? (session ? "Free ride" : undefined)}>
        <RideControl />
      </Section>

      <Section index="03" title="Resistance" aside="Target · 1–32">
        <ResistanceControl />
      </Section>

      <div className="xl:col-span-2">
      <Section index="04" title="Telemetry" aside="Last 180 s">
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <div>
            <Label className="mb-2">Power · W</Label>
            <Trace data={history} dataKey="powerW" label="Power" color="var(--spot)" x="t" formatX={clock} />
          </div>
          <div>
            <Label className="mb-2">Cadence · rpm</Label>
            <Trace data={history} dataKey="cadenceRpm" label="Cadence" color="var(--success)" x="t" formatX={clock} />
          </div>
        </div>
      </Section>
      </div>

      <div className="xl:col-span-2">
      <Section index="05" title="Session">
        <StatGrid
          items={[
            { label: "Elapsed", value: fmtDuration(stats.elapsedS) },
            { label: "Avg power", value: num(stats.avgPower), unit: "W" },
            { label: "Avg cadence", value: num(stats.avgCadence), unit: "rpm" },
            { label: "Avg heart rate", value: stats.avgHeartRate ? num(stats.avgHeartRate) : "—", unit: "bpm" },
            { label: "Work", value: num(stats.workKj), unit: "kJ" },
          ]}
        />
      </Section>
      </div>
    </div>
  );
}

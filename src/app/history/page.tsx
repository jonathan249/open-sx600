"use client";

import { useMemo, useRef, useState } from "react";
import { useBikeState } from "@/components/bike-provider";
import { Btn, ConfirmBtn, Label, num, Section, StatGrid } from "@/components/kit";
import { Trace } from "@/components/trace";
import { groupRides, maxOf, timeInZones, type WeekTotal, weeklyTotals } from "@/lib/history";
import { downsample } from "@/lib/ride";
import { useNow } from "@/hooks/use-now";
import { useSettings } from "@/lib/settings";
import { exportBackup, importBackup, type Ride, store, useCollection } from "@/lib/store";
import { cn } from "@/lib/utils";
import { fmtDuration } from "@/lib/workouts";

const MAX_CHART_POINTS = 600;

const WEEKS = 12;

const fmtTime = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const fmtLongDate = (t: number) =>
  new Date(t).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
/** "1 h 05 min" style, for totals where seconds don't matter. */
const fmtHours = (s: number) => {
  const total = Math.round(s / 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h} h ${String(m).padStart(2, "0")}` : `${m} min`;
};

// ---------------------------------------------------------------------------
// Overview

function WeekBars({ weeks }: { weeks: WeekTotal[] }) {
  const max = Math.max(1, ...weeks.map((w) => w.seconds));
  return (
    <div className="flex h-full min-h-40 flex-col gap-2 rounded-xl bg-card p-4">
      <div className="flex items-baseline justify-between gap-2">
        <Label className="text-foreground/80">Riding time · last {weeks.length} weeks</Label>
        <Label>avg {fmtHours(weeks.reduce((s, w) => s + w.seconds, 0) / weeks.length)} / week</Label>
      </div>
      <div className="flex flex-1 items-end gap-1.5" role="img" aria-label="Riding time per week">
        {weeks.map((w, i) => {
          const current = i === weeks.length - 1;
          const date = new Date(w.start).toLocaleDateString(undefined, { day: "numeric", month: "short" });
          return (
            <div key={w.start} className="group flex h-full flex-1 flex-col items-center justify-end gap-1.5">
              <div
                title={`Week of ${date}: ${fmtHours(w.seconds)} · ${w.rides} ${w.rides === 1 ? "ride" : "rides"} · ${num(w.workKj)} kJ`}
                className={cn(
                  "w-full rounded-t-[5px] rounded-b-[2px] transition-colors",
                  w.seconds === 0 ? "bg-foreground/[0.06]" : current ? "bg-spot" : "bg-spot-soft group-hover:bg-spot/70",
                )}
                style={{ height: w.seconds ? `${Math.max(6, (w.seconds / max) * 100)}%` : "3px" }}
              />
              <span className={cn("type-micro tabular-nums", current ? "text-foreground" : "text-muted-foreground")}>
                {i % 2 === (weeks.length - 1) % 2 ? date : "\u00a0"}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Overview({ rides }: { rides: Ride[] }) {
  const now = useNow();
  const weeks = useMemo(() => weeklyTotals(rides, WEEKS, now), [rides, now]);
  if (!now) return null; // clock not known yet (prerender / first hydration pass)
  const thisWeek = weeks.at(-1)!;
  const lastWeek = weeks.at(-2);
  const weekRides = rides.filter((r) => r.startedAt >= thisWeek.start);
  const hr = weekRides.filter((r) => r.stats.avgHeartRate);
  const avgHr = hr.length ? hr.reduce((s, r) => s + r.stats.avgHeartRate, 0) / hr.length : undefined;
  const delta = lastWeek ? thisWeek.seconds - lastWeek.seconds : 0;

  return (
    <Section index="01" title="Overview" aside="Weeks start on Monday">
      <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
        <div className="grid grid-cols-2 gap-2">
          {[
            {
              label: "This week",
              value: fmtHours(thisWeek.seconds),
              hint: lastWeek ? `${delta >= 0 ? "+" : "−"}${fmtHours(Math.abs(delta))} vs last week` : undefined,
            },
            { label: "Rides", value: String(thisWeek.rides), hint: `${rides.length} in total` },
            { label: "Work", value: `${num(thisWeek.workKj)} kJ`, hint: "this week" },
            { label: "Avg heart rate", value: avgHr ? `${num(avgHr)} bpm` : "—", hint: "this week" },
          ].map((t) => (
            <div key={t.label} className="flex flex-col gap-2 rounded-xl bg-card p-4">
              <Label className="text-foreground/80">{t.label}</Label>
              <span className="text-2xl tabular-nums tracking-tight">{t.value}</span>
              {t.hint && <span className="type-label text-muted-foreground">{t.hint}</span>}
            </div>
          ))}
        </div>
        <WeekBars weeks={weeks} />
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Ride list

function RideRow({ ride, selected, onSelect }: { ride: Ride; selected: boolean; onSelect: () => void }) {
  const d = new Date(ride.startedAt);
  return (
    <button
      type="button"
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-3 rounded-xl p-2.5 text-left transition-colors",
        selected ? "bg-card" : "hover:bg-card/60",
      )}
    >
      <span
        className={cn(
          "flex size-11 shrink-0 flex-col items-center justify-center rounded-lg leading-none",
          selected ? "bg-spot/15 text-spot" : "bg-foreground/[0.06]",
        )}
      >
        <span className="text-[15px] font-medium tabular-nums">{d.getDate()}</span>
        <span className="mt-1 type-micro uppercase opacity-70">{d.toLocaleDateString(undefined, { weekday: "short" })}</span>
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{ride.workoutName ?? "Free ride"}</span>
          {ride.partial && <span className="shrink-0 rounded-full bg-warning/15 px-2 type-micro text-warning">Unfinished</span>}
        </span>
        <span className="truncate type-label text-muted-foreground tabular-nums">
          {fmtTime(ride.startedAt)} · {num(ride.stats.avgPower)} W
          {ride.stats.avgHeartRate ? ` · ${num(ride.stats.avgHeartRate)} bpm` : ""}
        </span>
      </span>
      <span className="shrink-0 text-sm tabular-nums">{fmtDuration(ride.durationS)}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Ride detail

const ZONE_TINT = ["bg-spot/20", "bg-spot/40", "bg-spot/60", "bg-spot/80", "bg-spot"];

function Zones({ ride }: { ride: Ride }) {
  const { zones } = useSettings().hr;
  const secs = useMemo(() => timeInZones(ride.samples, zones), [ride.samples, zones]);
  const total = secs.reduce((a, b) => a + b, 0);
  if (!total) return null;
  return (
    <div className="flex flex-col gap-3 rounded-xl bg-card p-4">
      <div className="flex items-baseline justify-between gap-2">
        <Label className="text-foreground/80">Time in heart-rate zones</Label>
        <Label>your zones from Settings</Label>
      </div>
      <div className="flex h-3 overflow-hidden rounded-full bg-foreground/[0.06]">
        {secs.map((s, i) => (s ? <div key={i} className={ZONE_TINT[i]} style={{ width: `${(s / total) * 100}%` }} /> : null))}
      </div>
      <div className="grid grid-cols-5 gap-2">
        {secs.map((s, i) => (
          <div key={i} className="flex min-w-0 flex-col gap-0.5">
            <span className="flex items-center gap-1.5 type-label text-muted-foreground">
              <span className={cn("size-2 rounded-full", ZONE_TINT[i])} />Z{i + 1}
            </span>
            <span className="text-sm tabular-nums">{fmtDuration(s)}</span>
            <span className="type-micro text-muted-foreground tabular-nums">{Math.round((s / total) * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function RideDetail({ ride }: { ride: Ride }) {
  const points = useMemo(() => downsample(ride.samples, MAX_CHART_POINTS), [ride.samples]);
  const hasHr = ride.samples.some((s) => s.hr);
  const maxP = maxOf(ride.samples, "p");
  const maxHr = maxOf(ride.samples, "hr");
  // Stacked, sharing one time axis (shown on the last chart only), so moments line up.
  const traces = [
    { key: "p" as const, label: "Power", unit: "W", color: "var(--spot)" },
    ...(hasHr ? [{ key: "hr" as const, label: "Heart rate", unit: "bpm", color: "var(--destructive)" }] : []),
    { key: "c" as const, label: "Cadence", unit: "rpm", color: "var(--success)" },
    { key: "r" as const, label: "Resistance", unit: "level", color: "var(--muted-foreground)" },
  ];

  return (
    <Section
      index="03"
      title={ride.workoutName ?? "Free ride"}
      aside={
        <ConfirmBtn variant="ghost" className="-my-2 px-2" confirmLabel="Delete ride?" onConfirm={() => store.remove("rides", ride.id)}>
          Delete
        </ConfirmBtn>
      }
    >
      <div className="-mt-3 mb-4 flex flex-wrap items-center gap-2">
        <Label>
          {fmtLongDate(ride.startedAt)} · {fmtTime(ride.startedAt)}
        </Label>
        {ride.partial && (
          <span className="rounded-full bg-warning/15 px-2 py-0.5 type-micro text-warning">Unfinished · recovered after the tab closed</span>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <StatGrid
          className="md:grid-cols-3 2xl:grid-cols-6"
          items={[
            { label: "Duration", value: fmtDuration(ride.durationS) },
            { label: "Work", value: num(ride.stats.workKj), unit: "kJ" },
            { label: "Avg power", value: num(ride.stats.avgPower), unit: "W" },
            { label: "Max power", value: num(maxP), unit: "W" },
            { label: "Avg heart rate", value: ride.stats.avgHeartRate ? num(ride.stats.avgHeartRate) : "—", unit: "bpm" },
            { label: "Max heart rate", value: num(maxHr), unit: "bpm" },
          ]}
        />
        <Zones ride={ride} />
        <div className="flex flex-col gap-1 rounded-xl bg-card p-4">
          {traces.map((t, i) => (
            <div key={t.key}>
              <div className="flex items-baseline gap-1.5">
                <Label className="text-foreground/80">{t.label}</Label>
                <span className="type-micro text-muted-foreground">{t.unit}</span>
              </div>
              <Trace
                data={points}
                dataKey={t.key}
                label={t.label}
                color={t.color}
                x="t"
                formatX={fmtDuration}
                showX={i === traces.length - 1}
                height={i === traces.length - 1 ? "h-32" : "h-24"}
              />
            </div>
          ))}
        </div>
      </div>
    </Section>
  );
}

function Backup() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<string>();

  const download = async () => {
    const url = URL.createObjectURL(await exportBackup());
    const a = document.createElement("a");
    a.href = url;
    a.download = `sx600-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {message && (
        <Label role="status" className="mr-2">
          {message}
        </Label>
      )}
      <Btn variant="ghost" onClick={download}>
        Export backup
      </Btn>
      <Btn variant="ghost" onClick={() => fileRef.current?.click()}>
        Import
      </Btn>
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          try {
            const { workouts, rides } = await importBackup(file);
            setMessage(`Imported ${rides} rides · ${workouts} workouts`);
          } catch (err) {
            setMessage((err as Error).message);
          }
        }}
      />
    </div>
  );
}

export default function HistoryPage() {
  const all = useCollection("rides", (a, b) => b.startedAt - a.startedAt);
  const { session } = useBikeState();
  // The running ride's checkpoint isn't history yet.
  const rides = useMemo(() => all?.filter((r) => r.id !== session?.id) ?? null, [all, session?.id]);
  const [selectedId, setSelectedId] = useState<string>();
  const selected = rides?.find((r) => r.id === selectedId) ?? rides?.[0];
  const now = useNow();
  const groups = useMemo(() => (rides && now ? groupRides(rides, now) : []), [rides, now]);

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 pb-4">
        <Label>{rides ? `${rides.length} rides · ${fmtHours(rides.reduce((s, r) => s + r.durationS, 0))} in total · stored in this browser` : "Loading…"}</Label>
        <Backup />
      </div>

      {rides && rides.length === 0 ? (
        <Section index="01" title="No rides yet">
          <Label>Finish a ride and it shows up here, with charts and your heart-rate zones.</Label>
        </Section>
      ) : (
        rides && (
          <>
            <Overview rides={rides} />
            <div className="grid items-start gap-x-4 lg:grid-cols-[minmax(18rem,22rem)_minmax(0,1fr)]">
              <Section index="02" title="Rides">
                <div className="flex flex-col gap-4">
                  {groups.map((g) => (
                    <div key={g.label} className="flex flex-col gap-1">
                      <Label className="px-2.5 pb-1">{g.label}</Label>
                      {g.rides.map((r) => (
                        <RideRow key={r.id} ride={r} selected={selected?.id === r.id} onSelect={() => setSelectedId(r.id)} />
                      ))}
                    </div>
                  ))}
                </div>
              </Section>
              <div className="min-w-0">{selected && <RideDetail key={selected.id} ride={selected} />}</div>
            </div>
          </>
        )
      )}
    </div>
  );
}

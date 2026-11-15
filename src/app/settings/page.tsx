"use client";

import { type ReactNode, useState, useSyncExternalStore } from "react";
import { Btn, ConfirmBtn, inputClass, Label, NumberField, Section } from "@/components/kit";
import { DEFAULT_SETTINGS, resetSettings, type Settings, updateSettings, useSettings } from "@/lib/settings";
import { clampResistance, MAX_RESISTANCE } from "@/lib/sx600/fitshow";
import { getThemePref, setThemePref, subscribeTheme, type ThemePref } from "@/lib/theme";
import { cn } from "@/lib/utils";

const int = (min: number, max: number) => (n: number | null) => (n == null ? undefined : Math.min(max, Math.max(min, Math.round(n))));

/** Label above, control below, optional hint under it. */
function Field({
  label,
  hint,
  children,
  className,
  as: Tag = "label",
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
  /** Use "div" around controls that aren't a single input (a <label> forwards clicks to its first button). */
  as?: "label" | "div";
}) {
  return (
    <Tag className={cn("flex min-w-0 flex-col gap-2", className)}>
      <Label>{label}</Label>
      {children}
      {hint && <span className="text-xs leading-relaxed text-muted-foreground">{hint}</span>}
    </Tag>
  );
}

/** Text input that commits on blur/Enter, so clearing it while typing doesn't snap back. */
function TextField({ value, onCommit, ...props }: { value: string; onCommit: (v: string) => void; "aria-label": string }) {
  const [text, setText] = useState<string | null>(null);
  return (
    <input
      {...props}
      className={inputClass}
      value={text ?? value}
      onFocus={() => setText(value)}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (text != null && text !== value) onCommit(text);
        setText(null);
      }}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn("relative h-6 w-11 shrink-0 rounded-full transition-colors", checked ? "bg-spot" : "bg-foreground/15")}
    >
      <span
        className={cn(
          "absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow-sm transition-transform",
          checked && "translate-x-5",
        )}
      />
    </button>
  );
}

function ResetBtn({ section }: { section: keyof Settings }) {
  return (
    <Btn variant="ghost" className="-my-2 px-2" onClick={() => resetSettings(section)}>
      Reset
    </Btn>
  );
}

function QuickLevels({ s }: { s: Settings }) {
  const set = (i: number, patch: Partial<Settings["quickLevels"][number]>) =>
    updateSettings(
      "quickLevels",
      s.quickLevels.map((q, j) => (j === i ? { ...q, ...patch } : q)),
    );
  return (
    <Section index="01" title="Quick levels" aside={<ResetBtn section="quickLevels" />}>
      <p className="-mt-2 mb-4 text-sm text-muted-foreground">The four one-tap resistance buttons on Home.</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {s.quickLevels.map((q, i) => (
          <div key={i} className="grid grid-cols-[1fr_5.5rem] gap-2 rounded-xl bg-card p-3">
            <Field label={`Button ${i + 1}`}>
              <TextField aria-label={`Button ${i + 1} name`} value={q.name} onCommit={(name) => set(i, { name })} />
            </Field>
            <Field label="Level">
              <NumberField
                aria-label={`Button ${i + 1} level`}
                min={1}
                max={MAX_RESISTANCE}
                value={q.level}
                parse={(n) => clampResistance(n ?? q.level)}
                onCommit={(level) => set(i, { level: level ?? q.level })}
              />
            </Field>
          </div>
        ))}
      </div>
    </Section>
  );
}

function HeartRate({ s }: { s: Settings }) {
  const hr = s.hr;
  const setZone = (i: number, v: number | undefined) => {
    if (v == null) return;
    const zones = [...hr.zones] as Settings["hr"]["zones"];
    zones[i] = v;
    updateSettings("hr", { ...hr, zones });
  };
  const set = (patch: Partial<Settings["hr"]>) => updateSettings("hr", { ...hr, ...patch });
  return (
    <Section index="02" title="Heart rate" aside={<ResetBtn section="hr" />}>
      <p className="-mt-2 mb-4 text-sm text-muted-foreground">
        Your own zones, shown next to live heart rate (Z1–Z5). Each zone runs up to and including its limit.
      </p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {hr.zones.map((z, i) => (
          <div key={i} className="rounded-xl bg-card p-3">
            <Field label={`Z${i + 1} up to`}>
              <NumberField
                aria-label={`Zone ${i + 1} upper limit in bpm`}
                min={41}
                max={230}
                value={z}
                parse={int(41, 230)}
                onCommit={(v) => setZone(i, v)}
              />
            </Field>
          </div>
        ))}
        <div className="flex flex-col justify-between gap-2 rounded-xl bg-card p-3">
          <Label>Z5</Label>
          <span className="flex h-9 items-center text-sm text-muted-foreground tabular-nums">above {hr.zones[3]}</span>
        </div>
      </div>

      <div className="mt-5 grid gap-x-4 gap-y-5 sm:grid-cols-2">
        <Field label="HR intervals · work until" hint="Default target for “+ HR intervals” in Playground, in bpm.">
          <NumberField aria-label="Work until bpm" min={60} max={220} value={hr.intervalHigh} parse={int(60, 220)} onCommit={(v) => v && set({ intervalHigh: v })} />
        </Field>
        <Field label="HR intervals · recover until" hint="Recovery ends when heart rate drops to this, in bpm.">
          <NumberField aria-label="Recover until bpm" min={60} max={220} value={hr.intervalLow} parse={int(60, 220)} onCommit={(v) => v && set({ intervalLow: v })} />
        </Field>
        <Field label="HR intervals · rounds">
          <NumberField aria-label="Interval rounds" min={2} max={50} value={hr.intervalRounds} parse={int(2, 50)} onCommit={(v) => v && set({ intervalRounds: v })} />
        </Field>
        <Field label="Hold target for (s)" hint="How long heart rate must stay at a step's target before the step ends. Filters out single spikes.">
          <NumberField aria-label="Hold seconds" min={0} max={30} value={hr.holdS} parse={int(0, 30)} onCommit={(v) => v != null && set({ holdS: v })} />
        </Field>
      </div>
    </Section>
  );
}

function Ride({ s }: { s: Settings }) {
  const ride = s.ride;
  const set = (patch: Partial<Settings["ride"]>) => updateSettings("ride", { ...ride, ...patch });
  return (
    <Section index="03" title="Ride" aside={<ResetBtn section="ride" />}>
      <div className="flex flex-col gap-5">
        <div className="flex items-start justify-between gap-4 rounded-xl bg-card p-4">
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium">Auto-pause</span>
            <span className="text-xs leading-relaxed text-muted-foreground">
              Stops the clock when you stop pedalling or the bike disconnects. When off, the clock runs until you pause.
            </span>
          </div>
          <Switch label="Auto-pause" checked={ride.autoPause} onChange={(autoPause) => set({ autoPause })} />
        </div>
        <div className="grid gap-x-4 gap-y-5 sm:grid-cols-2">
          <Field label="Auto-pause after (s)" hint="Seconds without pedalling.">
            <NumberField
              aria-label="Auto-pause after seconds"
              min={2}
              max={120}
              value={ride.autoPauseAfterS}
              parse={int(2, 120)}
              onCommit={(v) => v && set({ autoPauseAfterS: v })}
            />
          </Field>
          <Field label="Save rides from (s)" hint={`Shorter rides are discarded. Default ${DEFAULT_SETTINGS.ride.minSaveS} s.`}>
            <NumberField
              aria-label="Minimum ride length in seconds"
              min={0}
              max={1800}
              value={ride.minSaveS}
              parse={int(0, 1800)}
              onCommit={(v) => v != null && set({ minSaveS: v })}
            />
          </Field>
        </div>
      </div>
    </Section>
  );
}

const THEME_OPTIONS: { id: ThemePref; label: string }[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

function Appearance() {
  const pref = useSyncExternalStore(subscribeTheme, getThemePref, () => "system" as const);
  return (
    <Section index="04" title="Appearance">
      <Field as="div" label="Theme" hint="System follows your computer's light/dark setting.">
        <div role="radiogroup" aria-label="Theme" className="flex w-fit gap-0.5 rounded-lg bg-foreground/[0.06] p-0.5">
          {THEME_OPTIONS.map((o) => (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={pref === o.id}
              onClick={() => setThemePref(o.id)}
              className={cn(
                "h-7 rounded-md px-3 type-label font-medium transition-colors",
                pref === o.id ? "bg-card text-foreground shadow-[0_1px_3px_rgb(0_0_0/0.08)]" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
      </Field>
    </Section>
  );
}

export default function SettingsPage() {
  const s = useSettings();
  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-baseline justify-between gap-2 pb-4">
        <Label>Changes save automatically · stored in this browser</Label>
        <ConfirmBtn variant="ghost" className="px-2" confirmLabel="Reset everything?" onConfirm={() => resetSettings()}>
          Reset all
        </ConfirmBtn>
      </div>
      <div className="grid gap-x-4 xl:grid-cols-2">
        <QuickLevels s={s} />
        <Ride s={s} />
        <div className="xl:col-span-2">
          <HeartRate s={s} />
        </div>
        <Appearance />
      </div>
    </div>
  );
}

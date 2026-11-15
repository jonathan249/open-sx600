"use client";

import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  type Modifier,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Repeat, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Btn, ConfirmBtn, IconBtn, inputClass, Label, NumberField, Section } from "@/components/kit";
import { WorkoutProfile } from "@/components/workout-profile";
import { useSettings } from "@/lib/settings";
import { store, useCollection } from "@/lib/store";
import { clampResistance, MAX_RESISTANCE } from "@/lib/sx600/fitshow";
import { cn } from "@/lib/utils";
import {
  blankWorkout,
  duplicateWorkout,
  fmtDuration,
  hasHrSteps,
  intervalSet,
  isRepeat,
  makeRepeat,
  makeStep,
  MIN_STEP_S,
  parseDurationText,
  type RepeatItem,
  repeatSpan,
  totalDuration,
  type Workout,
  type WorkoutItem,
  type WorkoutStep,
} from "@/lib/workouts";

/** Input inside a Cell: no own box, the Cell is the box. */
const CELL_INPUT = "h-6 w-full rounded-none bg-transparent p-0 text-sm focus:ring-0";

/**
 * A labelled field box: small label on top, value below, optional unit. The muted fill sets it
 * apart from the tile, so every editable value is visibly a field.
 */
function Cell({ label, unit, className, children }: { label: string; unit?: string; className?: string; children: ReactNode }) {
  return (
    <label
      className={cn(
        "flex min-w-0 flex-col gap-0.5 rounded-lg bg-muted px-3 py-1.5 ring-spot-soft transition-shadow focus-within:ring-2",
        className,
      )}
    >
      <span className="type-micro text-muted-foreground">{label}</span>
      <span className="flex items-baseline gap-1">
        {children}
        {unit && <span className="type-micro text-muted-foreground">{unit}</span>}
      </span>
    </label>
  );
}

const DRAGGING = "z-10 shadow-[0_8px_24px_rgb(0_0_0/0.12)]";

// Steps can only move up and down.
const verticalOnly: Modifier = ({ transform }) => ({ ...transform, x: 0 });

const parseLevel = (n: number | null) => clampResistance(n ?? 1);
const parseCadence = (n: number | null) => (n == null || n <= 0 ? undefined : Math.min(200, Math.round(n)));
const parseBpm = (n: number | null) => Math.min(220, Math.max(60, Math.round(n ?? 140)));
const parseCount = (min: number, max: number) => (n: number | null) => Math.min(max, Math.max(min, Math.round(n ?? min)));

const fmtClock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/** Duration input: type "1:30", "90s" or minutes; shows m:ss. Commits on blur or Enter. */
function DurationField({
  value,
  onCommit,
  label,
  className,
}: {
  value: number;
  onCommit: (s: number) => void;
  label: string;
  className?: string;
}) {
  const [text, setText] = useState<string | null>(null); // null while not editing
  const commit = () => {
    const parsed = text == null ? null : parseDurationText(text);
    setText(null);
    if (parsed != null) {
      const next = Math.min(4 * 3600, Math.max(MIN_STEP_S, parsed));
      if (next !== value) onCommit(next);
    }
  };
  return (
    <input
      aria-label={label}
      title="Type 1:30, 90s or minutes"
      inputMode="text"
      className={cn(inputClass, className)}
      value={text ?? fmtClock(value)}
      onFocus={(e) => {
        setText(fmtClock(value));
        e.target.select();
      }}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setText(null);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

type EndChoice = "time" | "above" | "below";
const endChoice = (s: WorkoutStep): EndChoice => (s.end?.kind === "hr" ? s.end.dir : "time");

/** Drag-handle props from useSortable, passed down field by field. */
type Handle = Pick<ReturnType<typeof useSortable>, "setActivatorNodeRef" | "attributes" | "listeners">;

function Grip({ label, handle }: { label: string; handle: Handle }) {
  const { setActivatorNodeRef, attributes, listeners } = handle;
  return (
    <div className="flex items-center gap-2 self-stretch">
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label={label}
        className="grid h-full min-h-8 w-6 cursor-grab touch-none place-items-center text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground active:cursor-grabbing"
      >
        <GripVertical className="size-4" strokeWidth={1.5} />
      </button>
    </div>
  );
}

function StepRow({
  step,
  number,
  inRepeat,
  onChange,
  onRemove,
}: {
  step: WorkoutStep;
  number: number;
  inRepeat: boolean;
  onChange: (patch: Partial<WorkoutStep>) => void;
  onRemove: () => void;
}) {
  const { setNodeRef, setActivatorNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({ id: step.id });
  const choice = endChoice(step);
  const setEnd = (c: EndChoice) => {
    if (c === "time") return onChange({ end: undefined });
    const bpm = step.end?.kind === "hr" ? step.end.bpm : c === "above" ? 160 : 130;
    onChange({ end: { kind: "hr", dir: c, bpm } });
  };

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "relative flex flex-col gap-2.5 rounded-xl bg-card p-3",
        // A lavender edge marks steps that a repeat row below plays again.
        inRepeat && "shadow-[inset_3px_0_0_var(--spot)]",
        isDragging && DRAGGING,
      )}
    >
      {/* Title line: grip · number · name · remove */}
      <div className="flex items-center gap-2">
        <Grip label={`Drag to reorder step ${number}`} handle={{ setActivatorNodeRef, attributes, listeners }} />
        <span className="grid size-6 shrink-0 place-items-center rounded-md bg-muted text-xs text-muted-foreground tabular-nums">
          {number}
        </span>
        <input
          className={cn(inputClass, "h-8 min-w-0 flex-1 bg-transparent px-2 text-[15px] font-medium hover:bg-muted focus:bg-muted")}
          value={step.label}
          aria-label="Step name"
          onChange={(e) => onChange({ label: e.target.value })}
        />
        <IconBtn label="Remove step" onClick={onRemove}>
          <X className="size-4" strokeWidth={1.5} />
        </IconBtn>
      </div>

      {/* Settings line, aligned with the name: how it ends · length · level · cadence */}
      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap md:pl-16">
        <Cell label="Ends" className="col-span-2 sm:w-44">
          <select
            aria-label="How this step ends"
            className={cn(inputClass, CELL_INPUT, "-ml-0.5 cursor-pointer")}
            value={choice}
            onChange={(e) => setEnd(e.target.value as EndChoice)}
          >
            <option value="time">After time</option>
            <option value="above">When HR rises to</option>
            <option value="below">When HR drops to</option>
          </select>
        </Cell>
        {step.end?.kind === "hr" && (
          <Cell label="Target" unit="bpm" className="sm:w-24">
            <NumberField
              aria-label="Heart-rate target in bpm"
              className={CELL_INPUT}
              min={60}
              max={220}
              value={step.end.bpm}
              parse={parseBpm}
              onCommit={(bpm) => step.end?.kind === "hr" && onChange({ end: { ...step.end, bpm: bpm ?? step.end.bpm } })}
            />
          </Cell>
        )}
        <Cell label={step.end?.kind === "hr" ? "At most" : "Duration"} className="sm:w-24">
          <DurationField
            label={step.end?.kind === "hr" ? "Maximum time for this step" : "Step duration"}
            className={CELL_INPUT}
            value={step.durationS}
            onCommit={(d) => onChange({ durationS: d })}
          />
        </Cell>
        <Cell label="Level" unit={`/ ${MAX_RESISTANCE}`} className="sm:w-24">
          <NumberField
            aria-label="Resistance level"
            className={CELL_INPUT}
            min={1}
            max={MAX_RESISTANCE}
            value={step.resistance}
            parse={parseLevel}
            onCommit={(l) => onChange({ resistance: l ?? 1 })}
          />
        </Cell>
        <Cell label="Cadence" unit="rpm" className="sm:w-24">
          <NumberField
            aria-label="Target cadence (optional)"
            className={CELL_INPUT}
            min={0}
            placeholder="—"
            value={step.cadence}
            parse={parseCadence}
            onCommit={(c) => onChange({ cadence: c })}
          />
        </Cell>
      </div>
    </div>
  );
}

function RepeatRow({
  item,
  covers,
  onChange,
  onRemove,
}: {
  item: RepeatItem;
  covers: number;
  onChange: (patch: Partial<RepeatItem>) => void;
  onRemove: () => void;
}) {
  const { setNodeRef, setActivatorNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({ id: item.id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn("rounded-xl bg-spot/10 p-3", isDragging && DRAGGING)}
    >
      <div className="flex items-center gap-2">
        <Grip label="Drag to move the repeat" handle={{ setActivatorNodeRef, attributes, listeners }} />
        <span className="grid size-6 shrink-0 place-items-center rounded-md bg-spot/15">
          <Repeat className="size-3.5 text-spot" strokeWidth={2} />
        </span>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 pl-2 text-sm">
          <span>Repeat the last</span>
          <NumberField
            aria-label="Number of steps to repeat"
            className="h-8 w-14 text-center"
            min={1}
            max={20}
            value={item.steps}
            parse={parseCount(1, 20)}
            onCommit={(n) => onChange({ steps: n ?? 1 })}
          />
          <span>{item.steps === 1 ? "step" : "steps"}</span>
          <NumberField
            aria-label="Times in total"
            className="h-8 w-14 text-center"
            min={2}
            max={50}
            value={item.times}
            parse={parseCount(2, 50)}
            onCommit={(n) => onChange({ times: n ?? 2 })}
          />
          <span>times</span>
          {covers < item.steps && (
            <Label className="text-warning">
              {covers === 0 ? "· no steps above to repeat" : `· only ${covers} ${covers === 1 ? "step" : "steps"} above`}
            </Label>
          )}
        </div>
        <IconBtn label="Remove repeat" onClick={onRemove}>
          <X className="size-4" strokeWidth={1.5} />
        </IconBtn>
      </div>
    </div>
  );
}

function Editor({
  initial,
  onSaved,
  onDirtyChange,
}: {
  initial: Workout;
  onSaved: (w: Workout) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [dirty, setDirtyState] = useState(false);
  const setDirty = (d: boolean) => {
    setDirtyState(d);
    onDirtyChange(d);
  };

  const update = (patch: Partial<Workout>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setDirty(true);
  };
  const updateItem = <T extends WorkoutItem>(id: string, patch: Partial<T>) =>
    update({ steps: draft.steps.map((s) => (s.id === id ? ({ ...s, ...patch } as WorkoutItem) : s)) });
  const removeItem = (id: string) => update({ steps: draft.steps.filter((x) => x.id !== id) });
  const add = (...items: WorkoutItem[]) => update({ steps: [...draft.steps, ...items] });
  const lastStep = draft.steps.findLast((s): s is WorkoutStep => !isRepeat(s));

  // Which step rows a repeat below plays again (for the lavender edge), and how many each repeat covers.
  const covered = new Set<string>();
  const covers = new Map<string, number>();
  draft.steps.forEach((item, i) => {
    if (!isRepeat(item)) return;
    const n = repeatSpan(draft.steps, i);
    covers.set(item.id, n);
    if (item.times >= 2) for (let j = i - n; j < i; j++) covered.add(draft.steps[j].id);
  });
  let stepNumber = 0;
  const { hr } = useSettings();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = draft.steps.findIndex((s) => s.id === active.id);
    const to = draft.steps.findIndex((s) => s.id === over.id);
    update({ steps: arrayMove(draft.steps, from, to) });
  };

  const hasSteps = draft.steps.some((s) => !isRepeat(s));
  const save = async () => {
    const w = { ...draft, name: draft.name.trim() || "Untitled", updatedAt: Date.now() };
    await store.put("workouts", w);
    setDraft(w);
    setDirty(false);
    onSaved(w);
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex min-w-60 flex-1 flex-col gap-2">
          <Label>Name</Label>
          <input className={cn(inputClass, "h-11 text-lg")} value={draft.name} onChange={(e) => update({ name: e.target.value })} />
        </label>
        <div className="flex flex-col gap-2">
          <Label>Total</Label>
          <div className="flex h-11 items-center text-lg tabular-nums">
            {hasHrSteps(draft) && <span className="mr-1.5 text-sm text-muted-foreground">up to</span>}
            {fmtDuration(totalDuration(draft))}
          </div>
        </div>
        <Btn variant="solid" className="h-11 px-5" onClick={save} disabled={!dirty || !hasSteps}>
          {dirty ? "Save" : "Saved"}
        </Btn>
      </div>

      <WorkoutProfile steps={draft.steps} className="h-28" />

      <div className="flex flex-col gap-1">
        <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[verticalOnly]} onDragEnd={onDragEnd}>
          <SortableContext items={draft.steps.map((s) => s.id)} strategy={verticalListSortingStrategy}>
            {draft.steps.map((s) =>
              isRepeat(s) ? (
                <RepeatRow
                  key={s.id}
                  item={s}
                  covers={covers.get(s.id) ?? 0}
                  onChange={(patch) => updateItem<RepeatItem>(s.id, patch)}
                  onRemove={() => removeItem(s.id)}
                />
              ) : (
                <StepRow
                  key={s.id}
                  step={s}
                  number={++stepNumber}
                  inRepeat={covered.has(s.id)}
                  onChange={(patch) => updateItem<WorkoutStep>(s.id, patch)}
                  onRemove={() => removeItem(s.id)}
                />
              ),
            )}
          </SortableContext>
        </DndContext>
      </div>
      <div className="flex flex-wrap gap-2">
        <Btn onClick={() => add(makeStep({ resistance: lastStep?.resistance }))}>+ Step</Btn>
        <Btn
          onClick={() => add(...intervalSet(hr.intervalRounds, hr.intervalHigh, hr.intervalLow))}
          title={`Work until HR rises to ${hr.intervalHigh}, recover until it drops to ${hr.intervalLow}, ${hr.intervalRounds} times (change in Settings)`}
        >
          + HR intervals
        </Btn>
        <Btn onClick={() => add(makeRepeat({ steps: 2, times: 6 }))} disabled={!lastStep}>
          + Repeat
        </Btn>
        <Btn onClick={() => add(makeStep({ label: "Cool-down", resistance: 3 }))}>+ Cool-down</Btn>
      </div>
    </div>
  );
}

export default function WorkoutsPage() {
  const workouts = useCollection("workouts", (a, b) => b.updatedAt - a.updatedAt);
  const [editing, setEditing] = useState<Workout | null>(null);
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState<Workout | null>(null); // switch target while dirty
  const current = editing ?? workouts?.[0] ?? null;

  const open = (w: Workout) => {
    if (w.id === current?.id) return;
    if (dirty) setPending(w);
    else setEditing(w);
  };
  const confirmSwitch = () => {
    setDirty(false);
    setEditing(pending);
    setPending(null);
  };

  const duplicate = async (w: Workout) => {
    const copy = duplicateWorkout(w);
    await store.put("workouts", copy);
    open(copy);
  };
  const remove = async (w: Workout) => {
    await store.remove("workouts", w.id);
    if (w.id === current?.id) {
      setDirty(false);
      setEditing(null);
    }
  };

  return (
    <Section index="01" title="Workouts" aside={workouts ? `${workouts.length} saved · this browser` : undefined}>
      <div className="grid gap-10 lg:grid-cols-[18rem_1fr]">
        <aside className="flex flex-col gap-1">
          {workouts?.map((w) => (
            <div
              key={w.id}
              className={cn("group rounded-xl px-3 py-3 transition-colors hover:bg-card", current?.id === w.id ? "bg-card text-foreground" : "text-muted-foreground")}
            >
              <button
                type="button"
                aria-current={current?.id === w.id ? "true" : undefined}
                className="w-full text-left hover:text-foreground"
                onClick={() => open(w)}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm">{w.name}</span>
                  <span className="font-mono type-label tabular-nums">{fmtDuration(totalDuration(w))}</span>
                </div>
                <WorkoutProfile steps={w.steps} className="mt-2 h-6" />
              </button>
              {/* Hover-revealed on desktop, always visible on touch screens. */}
              <div className="mt-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
                <Btn variant="ghost" className="px-2" onClick={() => duplicate(w)}>
                  Duplicate
                </Btn>
                <ConfirmBtn variant="ghost" className="px-2" confirmLabel="Delete?" onConfirm={() => remove(w)}>
                  Delete
                </ConfirmBtn>
              </div>
            </div>
          ))}
          <Btn className="mt-4" onClick={() => open(blankWorkout())}>
            + New workout
          </Btn>
        </aside>

        <div className="flex flex-col gap-4">
          {pending && (
            <div role="alert" className="flex flex-wrap items-center justify-between gap-3 border border-spot/60 px-4 py-3">
              <span className="text-sm">Unsaved changes will be lost.</span>
              <div className="flex gap-2">
                <Btn variant="ghost" onClick={() => setPending(null)}>
                  Keep editing
                </Btn>
                <Btn onClick={confirmSwitch}>Discard &amp; open “{pending.name}”</Btn>
              </div>
            </div>
          )}
          {current ? (
            <Editor key={current.id} initial={current} onSaved={setEditing} onDirtyChange={setDirty} />
          ) : (
            <Label>{workouts ? "No workouts yet" : "Loading…"}</Label>
          )}
        </div>
      </div>
    </Section>
  );
}

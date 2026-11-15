import { MAX_RESISTANCE } from "@/lib/sx600/fitshow";
import { cn } from "@/lib/utils";
import { describeEnd, expandPlan, isHrStep, type WorkoutItem } from "@/lib/workouts";

/** Diagonal stripes over the bar colour mark steps that end on heart rate. */
const HR_STRIPES = {
  backgroundImage: "repeating-linear-gradient(135deg, transparent 0 3px, rgb(255 255 255 / 0.35) 3px 5px)",
};

/**
 * Blocks sized by duration (width) and resistance (height), with an optional progress marker.
 * Repeats are unrolled, so every interval shows; HR-ended steps are striped and sized by
 * their cap. `fit` scales heights to the plan's own hardest step instead of the bike's
 * maximum, so small previews show the plan's shape even when all levels are low.
 */
export function WorkoutProfile({
  steps,
  progressS,
  activeIndex,
  fit = false,
  tone = "soft",
  className,
}: {
  steps: WorkoutItem[];
  /** Position of the progress marker on the plan's timeline, in seconds. */
  progressS?: number;
  /** Active step in the unrolled plan. */
  activeIndex?: number;
  fit?: boolean;
  /** Bar colour when no step is active: "strong" for a selected preview. */
  tone?: "soft" | "strong";
  className?: string;
}) {
  const plan = expandPlan({ steps });
  const total = plan.reduce((t, s) => t + s.durationS, 0) || 1;
  const top = fit ? Math.max(1, ...plan.map((s) => s.resistance)) : MAX_RESISTANCE;
  return (
    <div className={cn("relative flex h-20 w-full items-end gap-0.5", className)}>
      {plan.map((s, i) => (
        <div
          key={s.key}
          title={`${s.label}${s.round ? ` ${s.round.n}/${s.round.of}` : ""} · ${describeEnd(s)} · level ${s.resistance}`}
          style={{
            flexGrow: s.durationS,
            flexBasis: 0,
            height: `${Math.max(fit ? 18 : 8, (s.resistance / top) * 100)}%`,
            ...(isHrStep(s) ? HR_STRIPES : undefined),
          }}
          className={cn(
            "min-w-0.5 rounded-t-[5px] rounded-b-[2px]",
            activeIndex === undefined
              ? tone === "strong"
                ? "bg-spot"
                : "bg-spot-soft"
              : i === activeIndex
                ? "bg-spot"
                : i < activeIndex
                  ? "bg-spot-soft/40"
                  : "bg-spot-soft",
          )}
        />
      ))}
      {progressS !== undefined && (
        <div
          className="pointer-events-none absolute inset-y-0 w-0.5 rounded-full bg-foreground"
          style={{ left: `${Math.min(100, (progressS / total) * 100)}%` }}
        />
      )}
    </div>
  );
}

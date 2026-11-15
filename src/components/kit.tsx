"use client";

import { type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode, useEffect, useState } from "react";
import { cn } from "@/lib/utils";

export const num = (v: number | undefined, digits = 0) => (v == null || Number.isNaN(v) ? "—" : v.toFixed(digits));

export function Label({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("type-label text-muted-foreground", className)} {...props} />;
}

export function Section({
  index,
  title,
  aside,
  children,
}: {
  index: string;
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    // Card: a soft fill on the white page instead of a border; tiles inside are white.
    // The card owns its padding on all sides (flex also stops child margins leaking out),
    // so content inside never adds its own bottom spacing.
    <section data-index={index} className="mb-4 flex flex-col rounded-2xl bg-muted px-5 pb-5">
      <div className="flex items-baseline justify-between gap-4 pt-5 pb-4">
        <h2 className="text-[15px] font-medium tracking-tight">{title}</h2>
        {aside && <Label className="text-right">{aside}</Label>}
      </div>
      {children}
    </section>
  );
}

export function Readout({ label, unit, value }: { label: string; unit: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col justify-between gap-4 rounded-xl bg-card p-4 sm:gap-6 sm:p-5">
      <Label className="text-foreground/80">{label}</Label>
      <div className="flex flex-wrap items-baseline gap-x-1.5">
        {/* No reading yet: a muted dash, so the placeholder doesn't look like data. */}
        <span className={cn("text-3xl tabular-nums tracking-tight sm:text-5xl", value === "—" && "text-muted-foreground/50")}>
          {value}
        </span>
        <span className="type-label text-muted-foreground">{unit}</span>
      </div>
    </div>
  );
}

/**
 * Grid of white label/value tiles on the card fill. (Formerly hairlines; kept as tiles so
 * dividers stay correct at any column count.
 */
export function StatGrid({
  items,
  className,
}: {
  items: { label: string; value: string; unit?: string }[];
  className?: string;
}) {
  return (
    <div className={cn("grid grid-cols-2 gap-2 md:grid-cols-5", className)}>
      {items.map(({ label, value, unit }) => (
        <div key={label} className="flex flex-col gap-3 rounded-xl bg-card p-4">
          <Label className="text-foreground/80">{label}</Label>
          <div className="flex items-baseline gap-1.5">
            <span className="text-2xl tabular-nums tracking-tight">{value}</span>
            {unit && <span className="type-label text-muted-foreground">{unit}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "outline" | "solid" | "ghost" };

export function Btn({ variant = "outline", className, ...props }: BtnProps) {
  return (
    <button
      type="button"
      className={cn(
        // One control height (h-8) everywhere; callers change width, never height.
        "inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-3.5 type-label font-medium whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-40",
        // Translucent tint, so it reads on both the white page and the grey cards.
        variant === "outline" && "bg-foreground/[0.06] text-foreground hover:bg-foreground/[0.1]",
        variant === "solid" && "bg-foreground text-background hover:bg-foreground/85",
        variant === "ghost" && "text-muted-foreground hover:bg-muted hover:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

/** Icon-only button. `boxed` draws the square outline used for −/+ controls. */
export function IconBtn({
  label,
  boxed = false,
  className,
  children,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> & { label: string; boxed?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        "grid shrink-0 place-items-center transition-colors disabled:pointer-events-none disabled:opacity-25",
        boxed
          ? "size-10 rounded-xl bg-card hover:bg-foreground/[0.06]"
          : "size-8 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

/** Two-step confirm in place of window.confirm(): first click arms, second click runs. */
export function ConfirmBtn({
  onConfirm,
  confirmLabel = "Confirm?",
  children,
  ...props
}: Omit<BtnProps, "onClick"> & { onConfirm: () => void; confirmLabel?: string }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <Btn
      {...props}
      className={cn(props.className, armed && "text-destructive hover:text-destructive")}
      onClick={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
        } else setArmed(true);
      }}
      onBlur={() => setArmed(false)}
    >
      {armed ? confirmLabel : children}
    </Btn>
  );
}

export const inputClass =
  "w-full min-w-0 rounded-lg bg-card px-3 py-2 text-sm tabular-nums outline-none ring-spot-soft transition-shadow placeholder:text-muted-foreground focus:ring-2";

/**
 * Number input that lets you type freely and only normalises the value on blur or Enter.
 * `parse` returns the committed value (clamped/rounded), or null for "empty".
 */
export function NumberField({
  value,
  onCommit,
  parse,
  className,
  ...props
}: {
  value: number | undefined;
  onCommit: (v: number | undefined) => void;
  parse: (n: number | null) => number | undefined;
  className?: string;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  "aria-label": string;
}) {
  // Draft text only while editing; otherwise show the parent's value, so a commit the parent
  // normalises back to the current value (no prop change) still replaces the typed text.
  const [text, setText] = useState<string | null>(null);

  const commit = () => {
    if (text == null) return;
    const n = text.trim() === "" ? null : Number(text);
    const next = parse(n === null || Number.isNaN(n) ? null : n);
    setText(null);
    if (next !== value) onCommit(next);
  };

  return (
    <input
      {...props}
      type="number"
      inputMode="decimal"
      className={cn(inputClass, className)}
      value={text ?? (value == null ? "" : String(value))}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

"use client";

import { type MouseEvent, type UIEvent, useMemo, useState, useSyncExternalStore } from "react";
import { useBikeState } from "@/components/bike-provider";
import { Btn, ConfirmBtn, Label, Section, StatGrid } from "@/components/kit";
import { type DebugEntry, type DebugKind, type DebugSource, debugLog } from "@/lib/debug-log";
import { cn } from "@/lib/utils";

const EMPTY: readonly DebugEntry[] = [];
const MAX_ROWS = 500;
const PANE_ROWS = 200;
/** How far (px) from the newest row the list may be scrolled and still count as "following". */
const FOLLOW_SLACK_PX = 8;
const RATE_WINDOW_MS = 5000;

const KIND_FILTERS = ["all", "rx", "tx", "info", "error"] as const;
const SOURCE_FILTERS = ["all", "bike", "hr", "app"] as const;

const KIND_CLASS: Record<DebugKind, string> = {
  rx: "text-muted-foreground",
  tx: "text-spot",
  info: "text-foreground",
  error: "text-destructive",
};

/** The debug log, re-rendering at most a few times per second. */
export function useDebugEntries() {
  return useSyncExternalStore(debugLog.subscribe, debugLog.getSnapshot, () => EMPTY);
}

/** Packets per second per channel, over the last few seconds of the log. */
function useRates(entries: readonly DebugEntry[]) {
  return useMemo(() => {
    const end = entries.at(-1)?.t ?? 0;
    const counts = new Map<string, number>();
    for (let i = entries.length - 1; i >= 0 && end - entries[i].t <= RATE_WINDOW_MS; i--) {
      const e = entries[i];
      if (e.kind === "rx" && e.channel) counts.set(e.channel, (counts.get(e.channel) ?? 0) + 1);
    }
    return [...counts].map(([channel, n]) => ({ label: channel, value: (n / (RATE_WINDOW_MS / 1000)).toFixed(1), unit: "/s" }));
  }, [entries]);
}

type Filter = { kind?: DebugKind | "all"; source?: DebugSource | "all"; errorsOnly?: boolean; showStream: boolean };

function matches(e: DebugEntry, f: Filter) {
  if (!f.showStream && e.stream) return false;
  if (f.errorsOnly && e.kind !== "error") return false;
  if (f.kind && f.kind !== "all" && e.kind !== f.kind) return false;
  if (f.source && f.source !== "all" && e.source !== f.source) return false;
  return true;
}

/** Newest-first rows matching the filter, at most `max`. */
function pickRows(entries: readonly DebugEntry[], f: Filter, max: number) {
  const out: DebugEntry[] = [];
  for (let i = entries.length - 1; i >= 0 && out.length < max; i--) if (matches(entries[i], f)) out.push(entries[i]);
  return out;
}

/**
 * A newest-first log that holds still while you read it. Scrolling away from the top (or
 * pressing Freeze) pins the current snapshot; new events are counted, not inserted, until you
 * jump back to the latest.
 */
function useLiveView(live: readonly DebugEntry[], f: Filter) {
  const [held, setHeld] = useState<{ entries: readonly DebugEntry[]; manual: boolean } | null>(null);
  const entries = held?.entries ?? live;

  const onScroll = (e: UIEvent<HTMLElement>) => {
    const away = e.currentTarget.scrollTop > FOLLOW_SLACK_PX;
    if (away && !held) setHeld({ entries: live, manual: false });
    else if (!away && held && !held.manual) setHeld(null);
  };

  const lastHeldId = held?.entries.at(-1)?.id ?? Infinity;
  let newCount = 0;
  if (held) for (let i = live.length - 1; i >= 0 && live[i].id > lastHeldId; i--) if (matches(live[i], f)) newCount++;

  /** Scrolls the log (found from the clicked element, or by its data attribute) back to the newest row. */
  const jumpToLatest = (e?: MouseEvent<HTMLElement>) => {
    // From the bar inside the list: its own list. From the page's Freeze button: the page's list.
    const list =
      e?.currentTarget.closest<HTMLElement>("[data-debug-log]") ?? document.querySelector<HTMLElement>("main [data-debug-log]");
    list?.scrollTo({ top: 0 });
    setHeld(null);
  };
  const toggleFreeze = (e: MouseEvent<HTMLElement>) => (held ? jumpToLatest(e) : setHeld({ entries: live, manual: true }));

  return { entries, held: !!held, newCount, onScroll, jumpToLatest, toggleFreeze };
}

/** Sticky bar shown while the log is held. */
function HeldBar({ newCount, onJump }: { newCount: number; onJump: (e: MouseEvent<HTMLElement>) => void }) {
  return (
    <div className="sticky top-0 z-10 flex items-center justify-between gap-2 rounded-lg bg-spot/15 px-3 py-1.5 text-xs backdrop-blur">
      <span className="text-foreground">Paused{newCount ? ` · ${newCount} new` : ""}</span>
      <button type="button" onClick={onJump} className="font-medium text-spot hover:underline">
        Jump to latest
      </button>
    </div>
  );
}

/** Button label after a copy: "Copied", or "Copy failed" (no permission, insecure context, unfocused tab). */
function useCopyReport() {
  const [result, setResult] = useState<"Copied" | "Copy failed">();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(debugLog.report());
      setResult("Copied");
    } catch (err) {
      console.error("[debug] could not copy report", err);
      setResult("Copy failed");
    }
    setTimeout(() => setResult(undefined), 2000);
  };
  return [result, copy] as const;
}

/** Compact diagnostics for the right sidebar. The log scrolls on its own, below the stats. */
export function DiagnosticsPane() {
  const live = useDebugEntries();
  const rates = useRates(live);
  const [copyResult, copy] = useCopyReport();
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [showStream, setShowStream] = useState(false);
  const filter: Filter = { errorsOnly, showStream };
  const view = useLiveView(live, filter);
  const errors = live.filter((e) => e.kind === "error").length;
  const rows = pickRows(view.entries, filter, PANE_ROWS);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="grid shrink-0 grid-cols-2 gap-2">
        {[{ label: "Events", value: String(live.length) }, { label: "Errors", value: String(errors) }, ...rates].map((r) => (
          <div key={r.label} className="flex flex-col gap-1 rounded-xl bg-muted px-4 py-3">
            <Label className="type-micro truncate">{r.label}</Label>
            <span className={cn("text-lg font-light tabular-nums", r.label === "Errors" && errors > 0 && "text-destructive")}>
              {r.value}
              {"unit" in r && <span className="ml-1 type-micro text-muted-foreground">{r.unit}</span>}
            </span>
          </div>
        ))}
      </div>
      <div className="flex shrink-0 flex-wrap gap-2 py-3">
        <Btn variant="solid" className="px-3" onClick={copy}>
          {copyResult ?? "Copy report"}
        </Btn>
        <Btn variant={errorsOnly ? "solid" : "outline"} className="px-3" onClick={() => setErrorsOnly(!errorsOnly)}>
          Errors only
        </Btn>
        <Btn variant={showStream ? "solid" : "outline"} className="px-3" onClick={() => setShowStream(!showStream)} title="Bike data and heart-rate packets">
          Data packets
        </Btn>
      </div>
      <div data-debug-log onScroll={view.onScroll} className="min-h-40 flex-1 overflow-y-auto overscroll-contain">
        {view.held && <HeldBar newCount={view.newCount} onJump={view.jumpToLatest} />}
        <ol className="flex flex-col gap-1 pt-1 font-mono text-[11px] leading-snug">
          {rows.map((e) => (
            <li key={e.id} className={cn("rounded-lg px-3 py-1.5", e.kind === "error" ? "bg-destructive/[0.06]" : "bg-muted")}>
              <div className="flex gap-2">
                <span className="text-muted-foreground tabular-nums">{new Date(e.t).toISOString().slice(17, 23)}</span>
                <span className={cn("uppercase", KIND_CLASS[e.kind])}>{e.kind}</span>
                <span className="truncate text-muted-foreground">{e.channel ?? e.source}</span>
              </div>
              <div className={cn("break-words", e.kind === "error" && "text-destructive")}>{e.text}</div>
              {e.hex && <div className="break-all text-muted-foreground/70">{e.hex}</div>}
            </li>
          ))}
          {!rows.length && (
            <li className="px-4 py-4 text-muted-foreground">
              {errorsOnly ? "No errors." : showStream ? "No traffic yet." : "No control events yet. Data packets are hidden."}
            </li>
          )}
        </ol>
      </div>
    </div>
  );
}

function Chips<T extends string>({ value, options, onChange }: { value: T; options: readonly T[]; onChange: (v: T) => void }) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((o) => (
        <Btn key={o} variant={o === value ? "solid" : "outline"} className="px-3" onClick={() => onChange(o)}>
          {o}
        </Btn>
      ))}
    </div>
  );
}

export function DebugConsole() {
  const live = useDebugEntries();
  const { status, hr } = useBikeState();
  const [kind, setKind] = useState<(typeof KIND_FILTERS)[number]>("all");
  const [source, setSource] = useState<(typeof SOURCE_FILTERS)[number]>("all");
  const [showStream, setShowStream] = useState(false);
  const [copyResult, copyReport] = useCopyReport();
  const filter: Filter = { kind, source, showStream };
  const view = useLiveView(live, filter);
  const entries = view.entries;

  const rows = useMemo(
    () => pickRows(entries, { kind, source, showStream }, MAX_ROWS),
    [entries, kind, source, showStream],
  );

  const rates = useRates(entries);

  const errors = entries.filter((e) => e.kind === "error").length;

  const download = () => {
    const url = URL.createObjectURL(new Blob([debugLog.json()], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `sx600-debug-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-end justify-between gap-4 pb-8">
        <div>
          <h1 className="text-3xl font-light tracking-tight">Bluetooth debug</h1>
          <Label className="mt-2">Every packet in, every write out · last {entries.length} events kept in memory</Label>
        </div>
        <div className="flex flex-wrap gap-2">
          <Btn variant="solid" onClick={copyReport}>
            {copyResult ?? "Copy report"}
          </Btn>
          <Btn onClick={download}>Download JSON</Btn>
          <Btn onClick={view.toggleFreeze}>{view.held ? "Resume" : "Freeze"}</Btn>
          <ConfirmBtn
            onConfirm={() => {
              debugLog.clear();
              view.jumpToLatest(); // a paused view would keep showing the cleared events
            }}
          >
            Clear
          </ConfirmBtn>
        </div>
      </div>

      <Section index="01" title="Links">
        <StatGrid
          items={[
            { label: "Bike", value: status },
            { label: "Heart rate", value: hr.status },
            { label: "Events", value: String(entries.length) },
            { label: "Errors", value: String(errors) },
            ...rates,
          ]}
        />
      </Section>

      <Section index="02" title="Devices" aside="GATT layout and device info">
        <pre className="max-h-80 overflow-auto rounded-xl bg-card p-4 font-mono text-xs leading-relaxed">
          {Object.keys(debugLog.facts).length ? JSON.stringify(debugLog.facts, null, 2) : "Connect the bike or a heart-rate sensor to see its services."}
        </pre>
      </Section>

      <Section index="03" title="Event log" aside={view.held ? "Paused · scroll to the top or jump to resume" : "Live · newest first"}>
        <div className="flex flex-wrap gap-6 pb-4">
          <Chips value={kind} options={KIND_FILTERS} onChange={setKind} />
          <Chips value={source} options={SOURCE_FILTERS} onChange={setSource} />
          <Btn variant={showStream ? "solid" : "outline"} className="px-3" onClick={() => setShowStream(!showStream)} title="Bike data and heart-rate packets">
            {showStream ? "Data packets shown" : "Data packets hidden"}
          </Btn>
        </div>
        <div data-debug-log onScroll={view.onScroll} className="max-h-[60vh] overflow-auto overscroll-contain rounded-xl bg-card p-1">
          {view.held && <HeldBar newCount={view.newCount} onJump={view.jumpToLatest} />}
          <table className="w-full font-mono text-xs">
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} className={cn("border-b border-border/60 align-top last:border-b-0", e.kind === "error" && "bg-destructive/[0.06]")}>
                  <td className="whitespace-nowrap px-3 py-1.5 text-muted-foreground tabular-nums">
                    {new Date(e.t).toISOString().slice(11, 23)}
                  </td>
                  <td className="px-2 py-1.5 uppercase text-muted-foreground">{e.source}</td>
                  <td className={cn("px-2 py-1.5 uppercase", KIND_CLASS[e.kind])}>{e.kind}</td>
                  <td className="whitespace-nowrap px-2 py-1.5">{e.channel}</td>
                  <td className="px-2 py-1.5 break-all text-muted-foreground">{e.hex}</td>
                  <td className={cn("px-3 py-1.5", e.kind === "error" && "text-destructive")}>{e.text}</td>
                </tr>
              ))}
              {!rows.length && (
                <tr>
                  <td className="px-3 py-6 text-muted-foreground">
                    {showStream ? "Nothing yet. Connect the bike and pedal." : "No control events yet. Data packets are hidden."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}

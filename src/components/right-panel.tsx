"use client";

import { Bluetooth, Bug, type LucideIcon, Maximize2 } from "lucide-react";
import Link from "next/link";
import { useSyncExternalStore } from "react";
import { ConnectivityPane } from "@/components/connectivity";
import { DiagnosticsPane, useDebugEntries } from "@/components/debug-console";
import { Sidebar } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type View = "connectivity" | "debug";

const VIEWS: { id: View; label: string; icon: LucideIcon }[] = [
  { id: "connectivity", label: "Connectivity", icon: Bluetooth },
  { id: "debug", label: "Debug", icon: Bug },
];

// The chosen view, remembered per browser. Kept in memory too, so it works when storage is blocked.
const STORAGE_KEY = "sx600.panel-view";
let memoryView: View | null = null;
const viewListeners = new Set<() => void>();

function readView(): View {
  if (memoryView) return memoryView;
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "connectivity" || v === "debug") return v;
  } catch {
    // storage blocked: use the default
  }
  return "connectivity";
}

function writeView(v: View) {
  memoryView = v;
  try {
    localStorage.setItem(STORAGE_KEY, v);
  } catch {
    // not persisted; fine
  }
  viewListeners.forEach((l) => l());
}

function subscribeView(l: () => void) {
  viewListeners.add(l);
  return () => viewListeners.delete(l);
}

/** Error badge on the Debug icon, so problems are visible from the Connectivity view. */
function ErrorBadge() {
  const entries = useDebugEntries();
  const errors = entries.reduce((n, e) => n + (e.kind === "error" ? 1 : 0), 0);
  if (!errors) return null;
  return (
    <span className="absolute -top-0.5 -right-0.5 grid min-w-4 place-items-center rounded-full bg-destructive px-1 text-[10px] leading-4 font-medium text-white tabular-nums">
      {errors > 99 ? "99+" : errors}
    </span>
  );
}

/**
 * Always-open right panel. The view switcher sits at the right of the panel header, which has
 * the top bar's height so its buttons line up with the page controls (Connect etc.).
 */
export function RightPanel() {
  const view = useSyncExternalStore(subscribeView, readView, () => "connectivity" as const);
  const current = VIEWS.find((v) => v.id === view)!;

  return (
    <Sidebar side="right" collapsible="offcanvas" variant="inset" className="md:pl-0">
      <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl bg-background">
        <header className="flex h-14 shrink-0 items-center gap-3 px-4">
          <span className="text-sm font-medium">{current.label}</span>
          <div className="ml-auto flex items-center gap-3">
            {view === "debug" && (
              <Link
                href="/debug"
                className="flex items-center gap-1.5 type-label text-muted-foreground hover:text-spot"
                title="Open the full log"
              >
                <Maximize2 className="size-3.5" />
                Full log
              </Link>
            )}
            <nav aria-label="Panel views" className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
              {VIEWS.map(({ id, label, icon: Icon }) => (
                <Tooltip key={id}>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        aria-label={label}
                        aria-pressed={view === id}
                        onClick={() => writeView(id)}
                        className={cn(
                          "relative grid h-7 w-8 place-items-center rounded-md transition-colors",
                          view === id ? "bg-card text-spot shadow-[0_1px_3px_rgb(0_0_0/0.08)]" : "text-muted-foreground hover:text-foreground",
                        )}
                      />
                    }
                  >
                    <Icon className="size-4" />
                    {id === "debug" && <ErrorBadge />}
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{label}</TooltipContent>
                </Tooltip>
              ))}
            </nav>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          {view === "connectivity" ? <ConnectivityPane /> : <DiagnosticsPane />}
        </div>
      </div>
    </Sidebar>
  );
}

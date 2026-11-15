import { useSyncExternalStore } from "react";

/**
 * Current time for rendering, refreshed every minute. Returns 0 while prerendering on the
 * server (Next.js forbids reading the clock there); callers treat 0 as "not known yet".
 */
const TICK_MS = 60_000;
let now = 0;
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();

function subscribe(l: () => void) {
  listeners.add(l);
  timer ??= setInterval(() => {
    now = Date.now();
    listeners.forEach((f) => f());
  }, TICK_MS);
  return () => {
    listeners.delete(l);
    if (!listeners.size) {
      clearInterval(timer);
      timer = undefined;
      now = 0; // re-read on the next subscriber
    }
  };
}

function getSnapshot() {
  if (!now) now = Date.now();
  return now;
}

export function useNow() {
  return useSyncExternalStore(subscribe, getSnapshot, () => 0);
}

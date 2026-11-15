/**
 * User settings, kept in localStorage (this browser only). Small and read synchronously, so
 * the ride engine can use them mid-ride. Every value is validated on load, so a stale or
 * hand-edited entry can never break the app: anything invalid falls back to the default.
 */
import { useSyncExternalStore } from "react";
import { clampResistance } from "./sx600/fitshow";

export type QuickLevel = { name: string; level: number };

export type Settings = {
  quickLevels: QuickLevel[];
  hr: {
    /** Upper limits of zones 1–4 in bpm, ascending. Zone 5 is everything above the last. */
    zones: [number, number, number, number];
    /** Seconds heart rate must stay at a step's target before the step ends. */
    holdS: number;
    /** Defaults for the "+ HR intervals" block. */
    intervalHigh: number;
    intervalLow: number;
    intervalRounds: number;
  };
  ride: {
    autoPause: boolean;
    /** Seconds without pedalling before the ride auto-pauses. */
    autoPauseAfterS: number;
    /** Rides shorter than this (moving time) aren't saved. */
    minSaveS: number;
  };
};

export const DEFAULT_SETTINGS: Settings = {
  quickLevels: [
    { name: "Recovery", level: 4 },
    { name: "Endurance", level: 8 },
    { name: "Tempo", level: 12 },
    { name: "Climb", level: 18 },
  ],
  hr: { zones: [120, 140, 155, 170], holdS: 3, intervalHigh: 160, intervalLow: 130, intervalRounds: 6 },
  ride: { autoPause: true, autoPauseAfterS: 5, minSaveS: 60 },
};

const STORAGE_KEY = "sx600.settings";

const clamp = (v: unknown, min: number, max: number, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback;

/** Fills gaps with defaults and clamps everything into a sane range. */
export function normalizeSettings(raw: unknown): Settings {
  const r = (raw ?? {}) as Partial<Record<keyof Settings, Record<string, unknown>>> & { quickLevels?: unknown };
  const d = DEFAULT_SETTINGS;

  const levels = Array.isArray(r.quickLevels) ? r.quickLevels : [];
  const quickLevels = d.quickLevels.map((def, i) => {
    const q = (levels[i] ?? {}) as Partial<QuickLevel>;
    const name = typeof q.name === "string" && q.name.trim() ? q.name.trim().slice(0, 24) : def.name;
    return { name, level: typeof q.level === "number" ? clampResistance(q.level) : def.level };
  });

  const hr = r.hr ?? {};
  const zonesRaw = Array.isArray(hr.zones) ? hr.zones : [];
  // Each limit must be above the previous one.
  const zones = d.hr.zones.map((z) => z) as Settings["hr"]["zones"];
  let prev = 40;
  for (let i = 0; i < 4; i++) {
    const cap = 230 - (3 - i); // leave room for the limits after this one
    zones[i] = clamp(zonesRaw[i], prev + 1, cap, Math.min(cap, Math.max(prev + 1, d.hr.zones[i])));
    prev = zones[i];
  }

  const intervalHigh = clamp(hr.intervalHigh, 60, 220, d.hr.intervalHigh);
  // "Recover until" must be below "work until", or the intervals never alternate.
  const intervalLow = Math.min(clamp(hr.intervalLow, 60, 220, d.hr.intervalLow), intervalHigh - 5);

  const ride = r.ride ?? {};
  return {
    quickLevels,
    hr: {
      zones,
      holdS: clamp(hr.holdS, 0, 30, d.hr.holdS),
      intervalHigh,
      intervalLow,
      intervalRounds: clamp(hr.intervalRounds, 2, 50, d.hr.intervalRounds),
    },
    ride: {
      autoPause: typeof ride.autoPause === "boolean" ? ride.autoPause : d.ride.autoPause,
      autoPauseAfterS: clamp(ride.autoPauseAfterS, 2, 120, d.ride.autoPauseAfterS),
      minSaveS: clamp(ride.minSaveS, 0, 1800, d.ride.minSaveS),
    },
  };
}

let cached: Settings | null = null;
const listeners = new Set<() => void>();

export function getSettings(): Settings {
  if (cached) return cached;
  let raw: unknown = null;
  try {
    const text = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    raw = text ? JSON.parse(text) : null;
  } catch {
    // unreadable or blocked storage: defaults
  }
  cached = normalizeSettings(raw);
  return cached;
}

function save(next: Settings) {
  cached = normalizeSettings(next);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cached));
  } catch {
    // not persisted; still applies for this visit
  }
  listeners.forEach((l) => l());
}

/** Replaces one section, e.g. updateSettings("ride", { ...s.ride, minSaveS: 120 }). */
export function updateSettings<K extends keyof Settings>(key: K, value: Settings[K]) {
  save({ ...getSettings(), [key]: value });
}

export function resetSettings(key?: keyof Settings) {
  save(key ? { ...getSettings(), [key]: DEFAULT_SETTINGS[key] } : DEFAULT_SETTINGS);
}

export function subscribeSettings(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

// Another tab changed the settings: pick them up.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY) return;
    cached = null;
    listeners.forEach((l) => l());
  });
}

export function useSettings(): Settings {
  return useSyncExternalStore(subscribeSettings, getSettings, () => DEFAULT_SETTINGS);
}

/** Heart-rate zone 1–5 for a bpm value, using the user's own limits. */
export function hrZone(bpm: number, zones: Settings["hr"]["zones"]): 1 | 2 | 3 | 4 | 5 {
  for (let i = 0; i < zones.length; i++) if (bpm <= zones[i]) return (i + 1) as 1 | 2 | 3 | 4;
  return 5;
}

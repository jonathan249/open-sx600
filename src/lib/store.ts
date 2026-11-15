"use client";

/**
 * Local persistence in IndexedDB (this browser only).
 * Everything that reads or writes saved data goes through this module, so it can be
 * swapped for a synced backend (e.g. Convex) later without touching the UI.
 */
import { useEffect, useRef, useState } from "react";
import { sampleWorkouts, type Workout } from "./workouts";

export type RideStats = {
  elapsedS: number;
  avgPower: number;
  avgCadence: number;
  avgHeartRate: number;
  workKj: number;
};

export type RideSample = {
  t: number; // seconds since ride start (excluding pauses)
  p?: number; // power W
  c?: number; // cadence rpm
  hr?: number; // heart rate bpm
  r?: number; // resistance reported by the bike
  v?: number; // speed km/h
};

export type Ride = {
  id: string;
  startedAt: number;
  durationS: number;
  workoutName?: string;
  stats: RideStats;
  samples: RideSample[];
  /** Checkpoint of a ride that was never finished (tab closed, crash). */
  partial?: boolean;
};

type Stores = { workouts: Workout; rides: Ride };
type StoreName = keyof Stores;

const DB_NAME = "sx600";
const DB_VERSION = 1;
let dbPromise: Promise<IDBDatabase> | null = null;

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const fresh = !db.objectStoreNames.contains("workouts");
      if (fresh) db.createObjectStore("workouts", { keyPath: "id" });
      if (!db.objectStoreNames.contains("rides")) db.createObjectStore("rides", { keyPath: "id" });
      if (fresh) {
        const store = req.transaction!.objectStore("workouts");
        for (const w of sampleWorkouts()) store.put(w);
      }
    };
    req.onblocked = () => {
      dbPromise = null; // retry on the next call once the other tab is closed
      reject(new Error("Storage is blocked by another open tab of this app. Close it and reload."));
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another tab upgraded the schema: let it proceed, reopen lazily next time.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

async function run<T>(name: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(name, mode);
    const req = fn(tx.objectStore(name));
    if (mode === "readonly") {
      req.onsuccess = () => resolve(req.result);
    } else {
      // A write only counts once the transaction commits (it can still abort, e.g. over quota).
      tx.oncomplete = () => resolve(req.result);
      tx.onabort = () => reject(tx.error ?? new Error("Storage write was aborted"));
    }
    req.onerror = () => reject(req.error);
  });
}

const listeners: Record<StoreName, Set<() => void>> = { workouts: new Set(), rides: new Set() };
const notify = (name: StoreName) => listeners[name].forEach((l) => l());

export const store = {
  list: <K extends StoreName>(name: K) => run<Stores[K][]>(name, "readonly", (s) => s.getAll()),
  put: async <K extends StoreName>(name: K, value: Stores[K], { silent = false } = {}) => {
    await run(name, "readwrite", (s) => s.put(value));
    if (!silent) notify(name);
  },
  remove: async (name: StoreName, id: string) => {
    await run(name, "readwrite", (s) => s.delete(id));
    notify(name);
  },
};

/** Live list of a store, re-read whenever that store changes. */
export function useCollection<K extends StoreName>(name: K, sort: (a: Stores[K], b: Stores[K]) => number) {
  const [items, setItems] = useState<Stores[K][] | null>(null);
  const sortRef = useRef(sort);
  useEffect(() => {
    sortRef.current = sort;
  });
  useEffect(() => {
    let alive = true;
    const load = () =>
      store.list(name).then(
        (all) => {
          if (alive) setItems([...all].sort((a, b) => sortRef.current(a, b)));
        },
        (err) => {
          // Show an empty list rather than "Loading…" forever when storage is unavailable.
          console.error(`[store] could not read ${name}`, err);
          if (alive) setItems([]);
        },
      );
    load();
    listeners[name].add(load);
    return () => {
      alive = false;
      listeners[name].delete(load);
    };
  }, [name]);
  return items;
}

/** Asks the browser not to evict our data under storage pressure. Safe to call repeatedly. */
export async function requestPersistentStorage() {
  try {
    if (navigator.storage?.persisted && !(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch {
    // not supported: data still works, it just may be evicted under pressure
  }
}

// ---------------------------------------------------------------------------
// Backup

type Backup = { app: "sx600-dashboard"; version: 1; exportedAt: string; workouts: Workout[]; rides: Ride[] };

export async function exportBackup(): Promise<Blob> {
  const backup: Backup = {
    app: "sx600-dashboard",
    version: 1,
    exportedAt: new Date().toISOString(),
    workouts: await store.list("workouts"),
    rides: await store.list("rides"),
  };
  return new Blob([JSON.stringify(backup)], { type: "application/json" });
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Shape checks for the fields the app reads; a bad record would otherwise crash History on every load. */
export function isValidWorkout(w: unknown): w is Workout {
  return isObj(w) && typeof w.id === "string" && typeof w.name === "string" && Array.isArray(w.steps);
}

export function isValidRide(r: unknown): r is Ride {
  return (
    isObj(r) &&
    typeof r.id === "string" &&
    typeof r.startedAt === "number" &&
    typeof r.durationS === "number" &&
    isObj(r.stats) &&
    Object.values(r.stats).every((v) => v == null || typeof v === "number") &&
    Array.isArray(r.samples) &&
    r.samples.every((s) => isObj(s) && typeof s.t === "number")
  );
}

/** Merges a backup into local data (same ids are overwritten), all or nothing. Returns counts. */
export async function importBackup(file: File) {
  let data: Partial<Backup>;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new Error("This file isn't valid JSON.");
  }
  if (!isObj(data) || data.app !== "sx600-dashboard" || !Array.isArray(data.workouts) || !Array.isArray(data.rides)) {
    throw new Error("This file isn't an SX600 dashboard backup.");
  }
  if (data.version !== 1) throw new Error(`Unsupported backup version: ${String(data.version)}.`);
  const badW = data.workouts.filter((w) => !isValidWorkout(w)).length;
  const badR = data.rides.filter((r) => !isValidRide(r)).length;
  if (badW || badR) {
    throw new Error(`The backup has ${badW + badR} damaged record(s); nothing was imported.`);
  }
  const { workouts, rides } = data;

  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["workouts", "rides"], "readwrite");
      const ws = tx.objectStore("workouts");
      const rs = tx.objectStore("rides");
      for (const w of workouts) ws.put(w);
      for (const r of rides) rs.put(r);
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("Import was aborted; nothing was imported."));
    });
  } finally {
    notify("workouts");
    notify("rides");
  }
  return { workouts: workouts.length, rides: rides.length };
}

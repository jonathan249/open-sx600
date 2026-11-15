"use client";

import { createContext, type ReactNode, useContext, useEffect, useState, useSyncExternalStore } from "react";
import { RideEngine } from "@/lib/ride-engine";
import { requestPersistentStorage } from "@/lib/store";

// Lives in the root layout so the Bluetooth connection and a running ride
// survive navigating between Ride, Workouts and History.
const EngineContext = createContext<RideEngine | null>(null);

export function BikeProvider({ children }: { children: ReactNode }) {
  const [engine] = useState(() => new RideEngine());
  useEffect(() => {
    void requestPersistentStorage();
  }, []);
  return <EngineContext.Provider value={engine}>{children}</EngineContext.Provider>;
}

export function useEngine() {
  const engine = useContext(EngineContext);
  if (!engine) throw new Error("useEngine must be used inside <BikeProvider>");
  return engine;
}

/** Connection, ride session, stats, chart history. Changes about once per second. */
export function useBikeState() {
  const engine = useEngine();
  return useSyncExternalStore(engine.subscribeState, engine.getState, engine.getState);
}

/** Live readings. Changes on every Bluetooth packet; use only where they're shown. */
export function useLive() {
  const engine = useEngine();
  return useSyncExternalStore(engine.subscribeLive, engine.getLive, engine.getLive);
}

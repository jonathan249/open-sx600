"use client";

import { useSyncExternalStore } from "react";
import { useBikeState, useEngine } from "@/components/bike-provider";
import { Btn, Label } from "@/components/kit";
import { debugLog } from "@/lib/debug-log";
import type { Status } from "@/lib/ride-engine";
import { isWebBluetoothAvailable } from "@/lib/sx600/bike";
import { cn } from "@/lib/utils";

const noopSubscribe = () => () => {};

export function useBluetoothSupported() {
  return useSyncExternalStore(noopSubscribe, isWebBluetoothAvailable, () => true);
}

export function BikeStatusDot({ status }: { status: Status }) {
  return (
    <span
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        status === "connected" && "animate-pulse bg-success",
        (status === "reconnecting" || status === "connecting") && "animate-pulse bg-foreground",
        status === "error" && "bg-destructive",
        status === "idle" && "bg-muted-foreground/50",
      )}
    />
  );
}

const STATUS_TEXT: Record<Status, string> = {
  idle: "Not connected",
  connecting: "Linking…",
  connected: "Connected",
  reconnecting: "Reconnecting…",
  error: "Failed",
};

function Device({
  title,
  status,
  name,
  error,
  detail,
  action,
}: {
  title: string;
  status: Status;
  name?: string;
  error?: string;
  detail?: string;
  action: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-2xl bg-muted p-5">
      {/* Label and status as one block; the button is centred against both lines. */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <Label>{title}</Label>
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <BikeStatusDot status={status} />
            <span className="shrink-0">{STATUS_TEXT[status]}</span>
            {name && status !== "idle" && <span className="truncate text-muted-foreground">· {name}</span>}
          </div>
        </div>
        <div className="shrink-0">{action}</div>
      </div>
      {detail && <div className="text-xs leading-relaxed text-muted-foreground">{detail}</div>}
      {error && <div className="font-mono text-xs text-destructive">{error}</div>}
    </div>
  );
}

export function ConnectivityPane() {
  const engine = useEngine();
  const { status, name, error, hr } = useBikeState();
  // Re-render when the debug facts (control mode) change.
  useSyncExternalStore(debugLog.subscribe, debugLog.getSnapshot, debugLog.getSnapshot);
  const supported = useBluetoothSupported();
  const bikeLinked = status === "connected" || status === "reconnecting";
  const hrLinked = hr.status === "connected" || hr.status === "reconnecting";
  const control = debugLog.facts.bikeControl as { mode?: string; scale?: number } | undefined;

  return (
    <div className="flex flex-col gap-4">
      {!supported && (
        <div className="rounded-2xl bg-muted px-5 py-4 text-xs text-muted-foreground">
          Web Bluetooth unavailable. Use Chrome or Edge on macOS, Windows or Android.
        </div>
      )}
      <Device
        title="Bike"
        status={status}
        name={name}
        error={status === "error" ? error : undefined}
        detail={status === "connected" && control?.mode ? `Control via ${control.mode.toUpperCase()} · scale ×${control.scale}` : undefined}
        action={
          <Btn
            onClick={() => (bikeLinked ? engine.disconnect() : engine.connect())}
            disabled={(!supported && !bikeLinked) || status === "connecting"}
          >
            {bikeLinked ? "Disconnect" : "Connect"}
          </Btn>
        }
      />
      <Device
        title="Heart rate"
        status={hr.status}
        name={hr.name}
        error={hr.status === "error" ? hr.error : undefined}
        detail={hr.status === "idle" ? "Garmin: turn on Broadcast Heart Rate, then pair." : undefined}
        action={
          <Btn
            onClick={() => (hrLinked ? engine.disconnectHr() : engine.connectHr())}
            disabled={(!supported && !hrLinked) || hr.status === "connecting"}
          >
            {hrLinked ? "Unpair" : "Pair"}
          </Btn>
        }
      />
    </div>
  );
}

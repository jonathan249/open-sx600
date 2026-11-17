/**
 * Bluetooth debug log: every packet the bike/HR sensor sends, every write we make, and every
 * error, kept in a ring buffer so a problem can be inspected (and exported) after the fact.
 *
 * Always recording; it's cheap (a few packets per second). Listeners are notified at most
 * every NOTIFY_MS so an open debug page doesn't re-render on every packet.
 */

export type DebugSource = "bike" | "hr" | "app";
export type DebugKind = "rx" | "tx" | "info" | "error";

export type DebugEntry = {
  id: number;
  t: number;
  source: DebugSource;
  kind: DebugKind;
  /** Characteristic, e.g. "2AD2 Indoor Bike Data". */
  channel?: string;
  hex?: string;
  /** Human-readable decoding or message. */
  text: string;
  /** Periodic data packet (bike data, heart rate): the bulk of the log, rarely interesting. */
  stream?: boolean;
};

/**
 * Data packets and everything else (writes, control-point replies, status, errors) are kept in
 * separate ring buffers, so a long ride's data stream can't push the rare control events out.
 */
const MAX_STREAM = 2000;
const MAX_EVENTS = 2000;
const NOTIFY_MS = 250;

export const CHANNEL_NAMES: Record<number, string> = {
  0x2ad2: "Indoor Bike Data",
  0x2ad9: "FTMS Control Point",
  0x2ad6: "Resistance Range",
  0x2ada: "FTMS Status",
  0x2acc: "FTMS Feature",
  0x2a37: "Heart Rate",
  0xfff1: "FitShow Notify",
  0xfff2: "FitShow Write",
};

export function channelName(uuid: number | string) {
  const short = typeof uuid === "number" ? uuid : shortUuid(uuid);
  const hex = typeof short === "number" ? short.toString(16).toUpperCase().padStart(4, "0") : String(uuid);
  const name = typeof short === "number" ? CHANNEL_NAMES[short] : undefined;
  return name ? `${hex} ${name}` : hex;
}

/** "00002ad2-0000-1000-8000-00805f9b34fb" → 0x2ad2; other UUIDs are returned as-is. */
export function shortUuid(uuid: string): number | string {
  const m = /^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/i.exec(uuid);
  return m ? parseInt(m[1], 16) : uuid;
}

export function toHex(data: DataView | ArrayBufferView | ArrayLike<number>): string {
  const bytes =
    data instanceof DataView
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : Uint8Array.from(data);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" ");
}

export function describeError(err: unknown) {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

type Listener = () => void;

/** Incoming packets that just repeat readings. Control-point replies and status changes are not. */
export function isStreamEntry(e: Pick<DebugEntry, "kind" | "channel">) {
  return e.kind === "rx" && !!e.channel && !/^(2AD9|2ADA)\b/.test(e.channel);
}

/** Merges two id-sorted lists into one id-sorted list. */
function mergeById(a: readonly DebugEntry[], b: readonly DebugEntry[]): DebugEntry[] {
  const out: DebugEntry[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (j >= b.length || (i < a.length && a[i].id < b[j].id)) out.push(a[i++]);
    else out.push(b[j++]);
  }
  return out;
}

class DebugLog {
  private stream: DebugEntry[] = [];
  private events: DebugEntry[] = [];
  private snapshot: readonly DebugEntry[] = [];
  private nextId = 1;
  private listeners = new Set<Listener>();
  private notifyTimer?: ReturnType<typeof setTimeout>;
  /** Free-form facts about the connected devices (GATT layout, firmware, …) for the report. */
  facts: Record<string, unknown> = {};

  /** `stream` overrides the channel-based guess (e.g. FitShow keep-alive polls are writes but still noise). */
  add(e: Omit<DebugEntry, "id" | "t">) {
    const stream = e.stream ?? isStreamEntry(e);
    const entry: DebugEntry = { ...e, id: this.nextId++, t: Date.now(), stream: stream || undefined };
    const buf = stream ? this.stream : this.events;
    const max = stream ? MAX_STREAM : MAX_EVENTS;
    buf.push(entry);
    if (buf.length > max) buf.splice(0, buf.length - max);
    this.scheduleNotify();
  }

  private get entries() {
    return mergeById(this.events, this.stream);
  }

  setFact(key: string, value: unknown) {
    this.facts = { ...this.facts, [key]: value };
    this.scheduleNotify();
  }

  clear() {
    this.stream = [];
    this.events = [];
    this.flush();
  }

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getSnapshot = () => this.snapshot;

  /**
   * Plain-text report to paste into a bug report: control events (writes, replies, status,
   * errors) first, then only the most recent data packets for context.
   */
  report(eventLimit = 400, streamLimit = 40) {
    const lines = [
      `SX600 dashboard debug report · ${new Date().toISOString()}`,
      `User agent: ${typeof navigator !== "undefined" ? navigator.userAgent : "n/a"}`,
      "",
      "== Devices ==",
      JSON.stringify(this.facts, null, 2),
      "",
      `== Last ${Math.min(eventLimit, this.events.length)} of ${this.events.length} control events, info and errors ==`,
      ...this.events.slice(-eventLimit).map(formatEntry),
      "",
      `== Last ${Math.min(streamLimit, this.stream.length)} of ${this.stream.length} data packets ==`,
      ...this.stream.slice(-streamLimit).map(formatEntry),
    ];
    return lines.join("\n");
  }

  json() {
    return JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        userAgent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
        facts: this.facts,
        entries: this.entries,
      },
      null,
      2,
    );
  }

  private scheduleNotify() {
    this.notifyTimer ??= setTimeout(() => this.flush(), NOTIFY_MS);
  }

  private flush() {
    clearTimeout(this.notifyTimer);
    this.notifyTimer = undefined;
    this.snapshot = this.entries;
    this.listeners.forEach((l) => l());
  }
}

export function formatEntry(e: DebugEntry) {
  const time = new Date(e.t).toISOString().slice(11, 23);
  const parts = [time, e.source.padEnd(4), e.kind.toUpperCase().padEnd(5), e.channel ?? "", e.hex ? `[${e.hex}]` : "", e.text];
  return parts.filter(Boolean).join("  ");
}

export const debugLog = new DebugLog();

/**
 * Lists services/characteristics with their properties and reads the Device Information
 * strings (model, firmware, …). Only services the page was granted are visible.
 */
export async function inspectGatt(server: BluetoothRemoteGATTServer) {
  const services: Record<string, string[]> = {};
  const info: Record<string, string> = {};
  const DEVICE_INFO: Record<number, string> = {
    0x2a29: "manufacturer",
    0x2a24: "model",
    0x2a25: "serial",
    0x2a27: "hardware",
    0x2a26: "firmware",
    0x2a28: "software",
  };
  for (const service of await server.getPrimaryServices().catch(() => [])) {
    const chars = await service.getCharacteristics().catch(() => []);
    services[channelName(service.uuid)] = chars.map((c) => {
      const p = c.properties;
      const props = [
        p.read && "read",
        p.write && "write",
        p.writeWithoutResponse && "writeNoResp",
        p.notify && "notify",
        p.indicate && "indicate",
      ].filter(Boolean);
      return `${channelName(c.uuid)} (${props.join(", ")})`;
    });
    if (shortUuid(service.uuid) === 0x180a) {
      for (const c of chars) {
        const key = DEVICE_INFO[shortUuid(c.uuid) as number];
        if (!key) continue;
        const value = await c.readValue().catch(() => null);
        if (value) info[key] = new TextDecoder().decode(value).replace(/\0+$/, "");
      }
    }
  }
  return { services, info };
}

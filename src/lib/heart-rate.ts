/**
 * Standard Bluetooth Heart Rate sensor (service 0x180D, measurement 0x2A37).
 *
 * Works with anything that speaks the standard profile: chest straps, arm bands, and Garmin
 * watches with "Broadcast Heart Rate" switched on (Garmin broadcasts over BLE and ANT+;
 * the browser only sees BLE).
 */
import { channelName, debugLog, describeError, inspectGatt, toHex } from "./debug-log";

export const HR_SERVICE = 0x180d;
export const HR_MEASUREMENT = 0x2a37;

export type HeartRateReading = {
  bpm: number;
  /** R-R intervals in ms, when the sensor sends them (useful for HRV). */
  rrMs?: number[];
  /** false when the sensor reports no skin contact. */
  contact?: boolean;
};

export function parseHeartRate(view: DataView): HeartRateReading | null {
  if (view.byteLength < 2) return null;
  const flags = view.getUint8(0);
  const wide = (flags & 0x01) !== 0;
  let i = 1;
  if (wide && view.byteLength < 3) return null;
  const bpm = wide ? view.getUint16(i, true) : view.getUint8(i);
  i += wide ? 2 : 1;

  const out: HeartRateReading = { bpm };
  if (flags & 0x04) out.contact = (flags & 0x02) !== 0; // contact supported → bit 1 is the status
  if (flags & 0x08) i += 2; // energy expended
  if (flags & 0x10) {
    out.rrMs = [];
    for (; i + 2 <= view.byteLength; i += 2) out.rrMs.push(Math.round((view.getUint16(i, true) / 1024) * 1000));
  }
  return out;
}

export type HrLinkState = "connected" | "reconnecting" | "disconnected";

const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];

function log(kind: "rx" | "info" | "error", text: string, data?: DataView) {
  debugLog.add({ source: "hr", kind, text, channel: data ? channelName(HR_MEASUREMENT) : undefined, hex: data ? toHex(data) : undefined });
}

export class HeartRateSensor {
  private device?: BluetoothDevice;
  private userDisconnected = false;
  private reconnecting = false;
  onReading?: (r: HeartRateReading) => void;
  onLinkChange?: (state: HrLinkState) => void;

  get name() {
    return this.device?.name ?? "HR sensor";
  }

  async connect() {
    this.userDisconnected = false;
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [HR_SERVICE] }],
      optionalServices: ["battery_service", "device_information"],
    });
    log("info", `picked "${this.device.name ?? "unnamed"}"`);
    this.device.addEventListener("gattserverdisconnected", this.handleDisconnect);
    try {
      await this.setup();
    } catch (err) {
      log("error", `setup failed: ${describeError(err)}`);
      this.userDisconnected = true;
      this.device.gatt?.disconnect();
      throw err;
    }
  }

  disconnect() {
    this.userDisconnected = true;
    this.device?.gatt?.disconnect();
    this.onLinkChange?.("disconnected");
  }

  private async setup() {
    const server = await this.device!.gatt!.connect();
    const gatt = await inspectGatt(server).catch(() => null);
    if (gatt) debugLog.setFact("hr", { name: this.device!.name, ...gatt });

    const measurement = await (await server.getPrimaryService(HR_SERVICE)).getCharacteristic(HR_MEASUREMENT);
    measurement.oncharacteristicvaluechanged = (e) => {
      const view = (e.target as BluetoothRemoteGATTCharacteristic).value!;
      const reading = parseHeartRate(view);
      log("rx", reading ? `bpm=${reading.bpm}${reading.rrMs?.length ? ` rr=${reading.rrMs.join(",")}` : ""}${reading.contact === false ? " no-contact" : ""}` : "unparsed", view);
      if (reading && reading.bpm > 0) this.onReading?.(reading);
    };
    await measurement.startNotifications();
    log("info", "streaming");
    this.onLinkChange?.("connected");
  }

  private handleDisconnect = async () => {
    log("info", this.userDisconnected ? "disconnected" : "link lost");
    if (this.userDisconnected || this.reconnecting) return;
    this.reconnecting = true;
    this.onLinkChange?.("reconnecting");
    try {
      for (const delay of RECONNECT_DELAYS_MS) {
        await new Promise((r) => setTimeout(r, delay));
        if (this.userDisconnected) return;
        try {
          await this.setup();
          return;
        } catch (err) {
          log("error", `reconnect failed: ${describeError(err)}`);
        }
      }
      this.onLinkChange?.("disconnected");
    } finally {
      this.reconnecting = false;
    }
  };
}

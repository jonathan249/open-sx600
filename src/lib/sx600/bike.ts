/**
 * Web Bluetooth connection to a Sportstech SX600.
 *
 * Two control paths, picked automatically:
 * - "ftms": current SX600 consoles ("ZV-xxxxxx") are standard FTMS bikes. QZ drives them through
 *   the FTMS control point (ftmsbike.cpp), so that's what we do too.
 * - "fitshow": older consoles without an FTMS control point use the proprietary FitShow frames
 *   (QZ fitplusbike.cpp, sportstech_sx600 branches).
 *
 * Live data comes from FTMS Indoor Bike Data (0x2AD2) whenever the bike offers it.
 */
import { channelName, debugLog, describeError, inspectGatt, toHex } from "../debug-log";
import {
  FITSHOW_NOTIFY,
  FITSHOW_SERVICE,
  FITSHOW_WRITE,
  INIT_FRAMES,
  parseFitshowData,
  POLL_FRAMES,
  POLL_INTERVAL_MS,
  resistanceFrame,
} from "./fitshow";
import { type BikeData, FTMS_SERVICE, INDOOR_BIKE_DATA, parseIndoorBikeData } from "./ftms";
import {
  CONTROL_POINT,
  commands,
  type ControlResponse,
  describeMachineStatus,
  MACHINE_STATUS,
  OP,
  parseControlResponse,
  parseResistanceRange,
  RESISTANCE_RANGE,
  RESULT,
  RESULT_TEXT,
  resistanceScale,
  setResistanceCommand,
  simulationResistanceCommand,
  simulationResistanceLevel,
} from "./ftms-control";
import { WriteQueue } from "./write-queue";

export type { BikeData };

export function isWebBluetoothAvailable() {
  return typeof navigator !== "undefined" && "bluetooth" in navigator;
}

export type LinkState = "connected" | "reconnecting" | "disconnected";
export type ControlMode = "ftms" | "fitshow";

const OP_NAMES: Record<number, string> = Object.fromEntries(Object.entries(OP).map(([k, v]) => [v, k]));

const fields = (d: object) =>
  Object.entries(d)
    .map(([k, v]) => `${k}=${typeof v === "number" ? +v.toFixed(2) : v}`)
    .join(" ") || "(no fields)";

function log(kind: "rx" | "tx" | "info" | "error", text: string, channel?: number, data?: DataView | Uint8Array, stream?: boolean) {
  debugLog.add({
    source: "bike",
    kind,
    text,
    channel: channel == null ? undefined : channelName(channel),
    hex: data ? toHex(data) : undefined,
    stream,
  });
}

const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000];
const CONTROL_TIMEOUT_MS = 1500;

export class Sx600 {
  private device?: BluetoothDevice;
  private queue?: WriteQueue;
  private mode: ControlMode = "fitshow";
  private scale: 1 | 10 = 1;
  /**
   * How FTMS resistance is sent. "simulation" (op 0x11) is what QZ uses for ZV- consoles;
   * we drop to "target" (op 0x04) if the bike rejects it.
   */
  private resistanceOp: "simulation" | "target" = "simulation";
  /** Start/Resume sent on this link; QZ sends it before the first resistance change. */
  private started = false;
  private hasFtmsData = false;
  /** FitShow data frames carry the console's real level; FS- consoles' FTMS resistance field doesn't change. */
  private fitshowResistance = false;
  private pollTimer?: ReturnType<typeof setInterval>;
  private pollIndex = 0;
  private lastPollAt = 0;
  private userDisconnected = false;
  private reconnecting = false;
  private awaiting: { op: number; resolve: (r: ControlResponse | null) => void } | null = null;
  private dataListeners = new Set<(data: BikeData) => void>();
  onLinkChange?: (state: LinkState) => void;

  get name() {
    return this.device?.name ?? "SX600";
  }

  get controlMode() {
    return this.mode;
  }

  onData(cb: (data: BikeData) => void) {
    this.dataListeners.add(cb);
    return () => this.dataListeners.delete(cb);
  }

  /** Shows the browser's device picker, then sets up the link. */
  async connect() {
    this.userDisconnected = false;
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: "ZV-" }, { services: [FTMS_SERVICE] }, { services: [FITSHOW_SERVICE] }],
      // Device Information and Battery only feed the debug page.
      optionalServices: [FTMS_SERVICE, FITSHOW_SERVICE, "device_information", "battery_service"],
    });
    log("info", `picked "${this.device.name ?? "unnamed"}" (id ${this.device.id})`);
    this.device.addEventListener("gattserverdisconnected", this.handleDisconnect);
    try {
      await this.setup();
    } catch (err) {
      log("error", `setup failed: ${describeError(err)}`);
      // Don't leave a half-configured link open.
      this.userDisconnected = true;
      this.device.gatt?.disconnect();
      throw err;
    }
  }

  setResistance(level: number) {
    if (!this.queue) {
      log("error", `resistance ${level} not sent: bike not ready`);
      return Promise.resolve();
    }
    if (this.mode !== "ftms") return this.queue.setResistance(resistanceFrame(level));
    // FTMS consoles ignore targets until a session is started (QZ init(): 0x00 then 0x07).
    if (!this.started) void this.start();
    return this.queue.setResistance(
      this.resistanceOp === "simulation" ? simulationResistanceCommand(level) : setResistanceCommand(level, this.scale),
    );
  }

  /** Start/resume a session on the console (FTMS only; FitShow consoles start on the bike). */
  start() {
    if (this.mode !== "ftms" || !this.queue) return Promise.resolve();
    this.started = true;
    return this.queue.push(commands.start());
  }

  pause() {
    return this.mode === "ftms" ? (this.queue?.push(commands.pause()) ?? Promise.resolve()) : Promise.resolve();
  }

  stop() {
    if (this.mode !== "ftms" || !this.queue) return Promise.resolve();
    this.started = false;
    return this.queue.push(commands.stop());
  }

  disconnect() {
    this.userDisconnected = true;
    this.stopPolling();
    this.device?.gatt?.disconnect();
    this.onLinkChange?.("disconnected");
  }

  // ---------------------------------------------------------------------------

  private async setup() {
    const server = await this.device!.gatt!.connect();
    log("info", "GATT connected");
    try {
      const gatt = await inspectGatt(server);
      debugLog.setFact("bike", { name: this.device!.name, ...gatt });
    } catch (err) {
      log("error", `GATT inspection failed: ${describeError(err)}`);
    }
    const ftms = await server.getPrimaryService(FTMS_SERVICE).catch(() => null);
    const fitshow = await server.getPrimaryService(FITSHOW_SERVICE).catch(() => null);
    const controlPoint = ftms ? await ftms.getCharacteristic(CONTROL_POINT).catch(() => null) : null;
    // FitShow consoles ("FS-…", e.g. FS-BT-D2) also offer an FTMS control point, but only acknowledge
    // FTMS targets without applying them; QZ drives them with FitShow frames (fitplusbike.cpp).
    // "ZV-" consoles are plain FTMS bikes (QZ ftmsbike.cpp).
    const isZv = (this.device!.name ?? "").toUpperCase().startsWith("ZV-");
    const useFtmsControl = !!controlPoint && (isZv || !fitshow);

    if (ftms) {
      const range = await ftms
        .getCharacteristic(RESISTANCE_RANGE)
        .then((c) => c.readValue())
        .then(parseResistanceRange)
        .catch(() => null);
      this.scale = resistanceScale(range);
      console.info("[sx600] FTMS", { controlPoint: !!controlPoint, resistanceRange: range, scale: this.scale });
      log("info", `FTMS: control point ${controlPoint ? "yes" : "no"}, FitShow service ${fitshow ? "yes" : "no"}, resistance range ${range ? fields(range) : "unknown"}, scale ×${this.scale}`);

      const bikeData = await ftms.getCharacteristic(INDOOR_BIKE_DATA).catch(() => null);
      if (bikeData) {
        // Property handlers (not addEventListener) so a reconnect never stacks duplicates.
        bikeData.oncharacteristicvaluechanged = (e) => {
          const view = (e.target as BluetoothRemoteGATTCharacteristic).value!;
          // FitShow consoles report resistance ×10 (QZ fitplusbike); FTMS ones per their range.
          const data = parseIndoorBikeData(view, useFtmsControl ? this.scale : 10);
          if (this.fitshowResistance) delete data.resistance;
          log("rx", fields(data), INDOOR_BIKE_DATA, view);
          this.emit(data);
        };
        await bikeData.startNotifications();
        this.hasFtmsData = true;
      }

      // Machine Status tells us when the bike actually applied a target (or lost control).
      const status = await ftms.getCharacteristic(MACHINE_STATUS).catch(() => null);
      if (status) {
        status.oncharacteristicvaluechanged = (e) => {
          const view = (e.target as BluetoothRemoteGATTCharacteristic).value!;
          log("rx", describeMachineStatus(view, this.scale), MACHINE_STATUS, view);
        };
        await status.startNotifications().catch((err) => log("error", `status notifications failed: ${describeError(err)}`, MACHINE_STATUS));
      }
    }

    if (useFtmsControl) await this.setupFtmsControl(controlPoint!);
    else await this.setupFitshow(server);
    log("info", `ready, control via ${this.mode}`);
    debugLog.setFact("bikeControl", { mode: this.mode, scale: this.scale, ftmsData: this.hasFtmsData, resistanceOp: this.resistanceOp });
    this.onLinkChange?.("connected");
  }

  private async setupFtmsControl(cp: BluetoothRemoteGATTCharacteristic) {
    this.mode = "ftms";
    this.started = false;
    cp.oncharacteristicvaluechanged = (e) => {
      const view = (e.target as BluetoothRemoteGATTCharacteristic).value!;
      const res = parseControlResponse(view);
      log(
        res && res.result !== RESULT.success ? "error" : "rx",
        res ? `response to ${OP_NAMES[res.op] ?? `op 0x${res.op.toString(16)}`}: ${RESULT_TEXT[res.result] ?? res.result}` : "unrecognised",
        CONTROL_POINT,
        view,
      );
      if (!res) return;
      if (res.result !== RESULT.success) {
        console.warn(`[sx600] control point: op 0x${res.op.toString(16)} → ${RESULT_TEXT[res.result] ?? res.result}`);
      }
      if (this.awaiting && this.awaiting.op === res.op) {
        this.awaiting.resolve(res);
        this.awaiting = null;
      }
    };
    await cp.startNotifications(); // indications

    // One command at a time: write, then wait for the bike's response indication.
    const writeAndWait = async (bytes: Uint8Array) => {
      const op = bytes[0];
      let timer: ReturnType<typeof setTimeout> | undefined;
      const response = new Promise<ControlResponse | null>((resolve) => {
        const entry = { op, resolve };
        this.awaiting = entry;
        // On timeout, forget this request so a late reply can't complete the next command.
        timer = setTimeout(() => {
          if (this.awaiting === entry) this.awaiting = null;
          resolve(null);
        }, CONTROL_TIMEOUT_MS);
      });
      log("tx", OP_NAMES[op] ?? `op 0x${op.toString(16)}`, CONTROL_POINT, bytes);
      try {
        await cp.writeValueWithResponse(bytes as BufferSource);
        return await response;
      } finally {
        clearTimeout(timer);
        if (this.awaiting?.op === op) this.awaiting = null;
      }
    };

    this.queue = new WriteQueue(
      async (bytes) => {
        let res = await writeAndWait(bytes);
        // Lost control (e.g. after the console was used directly): take it back once and retry.
        if (res?.result === RESULT.notPermitted && bytes[0] !== OP.requestControl) {
          await writeAndWait(commands.requestControl());
          res = await writeAndWait(bytes);
        }
        // Bike doesn't take resistance via simulation parameters: use Set Target Resistance from now on.
        if (
          bytes[0] === OP.setIndoorBikeSimulation &&
          (res?.result === RESULT.notSupported || res?.result === RESULT.invalidParameter)
        ) {
          this.resistanceOp = "target";
          debugLog.setFact("bikeControl", { mode: this.mode, scale: this.scale, ftmsData: this.hasFtmsData, resistanceOp: this.resistanceOp });
          log("info", "simulation parameters rejected, switching resistance to Set Target Resistance (0x04)", CONTROL_POINT);
          bytes = setResistanceCommand(simulationResistanceLevel(bytes), this.scale);
          res = await writeAndWait(bytes);
        }
        if (!res) {
          console.warn(`[sx600] no response to op 0x${bytes[0].toString(16)}`);
          log("error", `no response to ${OP_NAMES[bytes[0]] ?? bytes[0]} within ${CONTROL_TIMEOUT_MS} ms`, CONTROL_POINT);
        }
      },
      (err) => {
        console.warn("[sx600] control point write failed", err);
        log("error", `write failed: ${describeError(err)}`, CONTROL_POINT);
      },
    );
    await this.queue.push(commands.requestControl());
  }

  private async setupFitshow(server: BluetoothRemoteGATTServer) {
    this.mode = "fitshow";
    this.fitshowResistance = false;
    const fitshow = await server.getPrimaryService(FITSHOW_SERVICE);
    const write = await fitshow.getCharacteristic(FITSHOW_WRITE);
    const notify = await fitshow.getCharacteristic(FITSHOW_NOTIFY);

    // Like QZ (fitplusbike.cpp writeCharacteristic): prefer write-without-response when supported.
    const withoutResponse = write.properties.writeWithoutResponse || !write.properties.write;
    log("info", `FitShow: writing ${withoutResponse ? "without" : "with"} response`);
    this.queue = new WriteQueue(
      async (bytes) => {
        // Keep-alive polls go out 5×/s: log them as data-stream noise, not as control events.
        const isPoll = POLL_FRAMES.includes(bytes);
        log("tx", isPoll ? "poll" : "frame", FITSHOW_WRITE, bytes, isPoll);
        if (withoutResponse) await write.writeValueWithoutResponse(bytes as BufferSource);
        else await write.writeValueWithResponse(bytes as BufferSource);
      },
      (err) => {
        console.warn("[sx600] FitShow write failed", err);
        log("error", `write failed: ${describeError(err)}`, FITSHOW_WRITE);
      },
    );

    notify.oncharacteristicvaluechanged = (e) => {
      const view = (e.target as BluetoothRemoteGATTCharacteristic).value!;
      const parsed = parseFitshowData(view);
      // Command replies (0x44 group: init, resistance) are control events; the rest is the data stream.
      const isCommandReply = view.byteLength > 1 && view.getUint8(1) === 0x44;
      log("rx", parsed ? fields(parsed) : "unparsed", FITSHOW_NOTIFY, view, !isCommandReply);
      if (parsed && this.hasFtmsData) {
        // Speed, power etc. come from FTMS; take only the level from FitShow.
        this.fitshowResistance = true;
        this.emit({ resistance: parsed.resistance });
        return;
      }
      if (parsed) this.emit({ resistance: parsed.resistance, cadenceRpm: parsed.cadence, powerW: parsed.power });
    };
    await notify.startNotifications();

    for (const f of INIT_FRAMES) await this.queue.push(f);
    this.startPolling();
  }

  // FitShow keep-alive: driven by a timer and by incoming data. Background tabs throttle
  // timers, but Bluetooth notifications keep arriving, so polling continues either way.
  private startPolling() {
    this.stopPolling();
    this.pollTimer = setInterval(() => this.maybePoll(), POLL_INTERVAL_MS);
  }

  private stopPolling() {
    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  private maybePoll() {
    const now = Date.now();
    if (this.mode !== "fitshow" || !this.queue || now - this.lastPollAt < POLL_INTERVAL_MS) return;
    this.lastPollAt = now;
    void this.queue.poll(POLL_FRAMES[this.pollIndex]);
    this.pollIndex = (this.pollIndex + 1) % POLL_FRAMES.length;
  }

  private emit(data: BikeData) {
    this.maybePoll();
    for (const cb of this.dataListeners) cb(data);
  }

  private handleDisconnect = async () => {
    this.stopPolling();
    this.queue?.clear();
    this.queue = undefined;
    this.awaiting?.resolve(null);
    this.awaiting = null;
    log("info", this.userDisconnected ? "disconnected" : "link lost");
    // A drop during a reconnect attempt fires this again: the running loop already retries.
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

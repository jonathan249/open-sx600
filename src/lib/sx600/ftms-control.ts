/**
 * FTMS Fitness Machine Control Point (0x2AD9).
 *
 * The SX600 variant that advertises as "ZV-xxxxxx" is handled by QZ as a standard FTMS bike
 * (src/devices/ftmsbike/ftmsbike.cpp, detected in bluetooth.cpp L2373), not via the FitShow
 * protocol. Control works like this:
 * - writes go to the control point *with response*
 * - the bike answers each write with an indication: 0x80, <request op>, <result>
 * - Request Control (0x00) must succeed before other commands are accepted
 */

export const CONTROL_POINT = 0x2ad9;
export const RESISTANCE_RANGE = 0x2ad6; // Supported Resistance Level Range

export const OP = {
  requestControl: 0x00,
  reset: 0x01,
  setTargetResistance: 0x04,
  setTargetPower: 0x05,
  startResume: 0x07,
  stopPause: 0x08,
} as const;

export const STOP = 0x01;
export const PAUSE = 0x02;

export const RESULT = {
  success: 0x01,
  notSupported: 0x02,
  invalidParameter: 0x03,
  failed: 0x04,
  notPermitted: 0x05,
} as const;

export const RESULT_TEXT: Record<number, string> = {
  1: "success",
  2: "op code not supported",
  3: "invalid parameter",
  4: "operation failed",
  5: "control not permitted",
};

export type ControlResponse = { op: number; result: number };

export function parseControlResponse(view: DataView): ControlResponse | null {
  if (view.byteLength < 3 || view.getUint8(0) !== 0x80) return null;
  return { op: view.getUint8(1), result: view.getUint8(2) };
}

export type ResistanceRange = { min: number; max: number; increment: number };

/** Raw sint16 values as the bike sends them (the spec says 0.1 resolution; some bikes send whole levels). */
export function parseResistanceRange(view: DataView): ResistanceRange | null {
  if (view.byteLength < 6) return null;
  return { min: view.getInt16(0, true), max: view.getInt16(2, true), increment: view.getUint16(4, true) };
}

/**
 * Raw units per resistance level. Spec-compliant bikes report 0.1 resolution (range max like 320
 * for 32 levels); others report whole levels. Without a range, assume whole levels like QZ's
 * generic FTMS bike does.
 */
export function resistanceScale(range: ResistanceRange | null): 1 | 10 {
  return range && range.max >= 100 ? 10 : 1;
}

export function setResistanceCommand(level: number, scale: 1 | 10): Uint8Array {
  const raw = Math.round(level * scale);
  // uint8 fits whole levels; 0.1-resolution values above 255 need two bytes (as QZ does for such bikes).
  return scale === 1 ? Uint8Array.from([OP.setTargetResistance, raw & 0xff]) : Uint8Array.from([OP.setTargetResistance, raw & 0xff, (raw >> 8) & 0xff]);
}

export function setPowerCommand(watts: number): Uint8Array {
  const w = Math.max(0, Math.round(watts));
  return Uint8Array.from([OP.setTargetPower, w & 0xff, (w >> 8) & 0xff]);
}

export const commands = {
  requestControl: () => Uint8Array.from([OP.requestControl]),
  start: () => Uint8Array.from([OP.startResume]),
  pause: () => Uint8Array.from([OP.stopPause, PAUSE]),
  stop: () => Uint8Array.from([OP.stopPause, STOP]),
};

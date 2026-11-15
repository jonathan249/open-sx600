/**
 * FTMS (Bluetooth Fitness Machine Service) Indoor Bike Data parser.
 * The SX600 streams live data on characteristic 0x2AD2 of service 0x1826.
 *
 * Mirrors QZ fitplusbike.cpp characteristicChanged() (L432–600). Resistance is divided by
 * `resistanceDivisor`: 10 for the FitShow-era SX600 (as QZ does), and for FTMS-controlled bikes
 * whatever the Supported Resistance Level Range implies (see ftms-control.ts).
 */

export const FTMS_SERVICE = 0x1826;
export const INDOOR_BIKE_DATA = 0x2ad2;

export type BikeData = {
  speedKmh?: number;
  cadenceRpm?: number;
  distanceM?: number;
  resistance?: number;
  powerW?: number;
  energyKcal?: number;
  heartRate?: number;
  elapsedS?: number;
};

const FLAG = {
  moreData: 1 << 0, // NOTE: inverted — speed is present when this bit is 0
  avgSpeed: 1 << 1,
  instCadence: 1 << 2,
  avgCadence: 1 << 3,
  totalDistance: 1 << 4,
  resistance: 1 << 5,
  instPower: 1 << 6,
  avgPower: 1 << 7,
  energy: 1 << 8,
  heartRate: 1 << 9,
  metabolic: 1 << 10,
  elapsedTime: 1 << 11,
  remainingTime: 1 << 12,
} as const;

export function parseIndoorBikeData(view: DataView, resistanceDivisor = 10): BikeData {
  const out: BikeData = {};
  if (view.byteLength < 2) return out;
  const flags = view.getUint16(0, true);
  let i = 2;
  const has = (f: number) => (flags & f) !== 0;
  const fits = (n: number) => i + n <= view.byteLength;
  // A flagged field that doesn't fit means a truncated packet: stop rather than misread later fields.

  if (!has(FLAG.moreData)) {
    if (!fits(2)) return out;
    out.speedKmh = view.getUint16(i, true) / 100;
    i += 2;
  }
  if (has(FLAG.avgSpeed)) {
    if (!fits(2)) return out;
    i += 2;
  }
  if (has(FLAG.instCadence)) {
    if (!fits(2)) return out;
    out.cadenceRpm = view.getUint16(i, true) / 2;
    i += 2;
  }
  if (has(FLAG.avgCadence)) {
    if (!fits(2)) return out;
    i += 2;
  }
  if (has(FLAG.totalDistance)) {
    if (!fits(3)) return out;
    out.distanceM = view.getUint16(i, true) | (view.getUint8(i + 2) << 16);
    i += 3;
  }
  if (has(FLAG.resistance)) {
    if (!fits(2)) return out;
    out.resistance = view.getInt16(i, true) / resistanceDivisor;
    i += 2;
  }
  if (has(FLAG.instPower)) {
    if (!fits(2)) return out;
    out.powerW = view.getInt16(i, true);
    i += 2;
  }
  if (has(FLAG.avgPower)) {
    if (!fits(2)) return out;
    i += 2;
  }
  if (has(FLAG.energy)) {
    if (!fits(5)) return out;
    out.energyKcal = view.getUint16(i, true);
    i += 5; // total (2) + per hour (2) + per minute (1)
  }
  if (has(FLAG.heartRate)) {
    if (!fits(1)) return out;
    // 0 means "no contact": report it as an explicit undefined so the caller clears a stale value.
    const hr = view.getUint8(i);
    out.heartRate = hr > 0 ? hr : undefined;
    i += 1;
  }
  if (has(FLAG.metabolic)) {
    if (!fits(1)) return out;
    i += 1;
  }
  if (has(FLAG.elapsedTime)) {
    if (!fits(2)) return out;
    out.elapsedS = view.getUint16(i, true);
    i += 2;
  }
  return out;
}

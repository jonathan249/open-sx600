/**
 * Serialises GATT writes (Web Bluetooth allows one operation at a time) without letting
 * them pile up:
 * - resistance is "latest wins": only the newest requested level is ever sent
 * - queued commands (init, start/stop) keep their order and go before a pending resistance
 *   change, so e.g. "start" always reaches the bike before the first resistance target
 * - a keep-alive poll is dropped if anything is in flight or waiting
 */
export class WriteQueue {
  private busy = false;
  private pendingResistance: Uint8Array | null = null;
  private pendingOther: Uint8Array[] = [];

  constructor(
    private readonly write: (bytes: Uint8Array) => Promise<void>,
    private readonly onError: (err: unknown) => void = () => {},
  ) {}

  get inFlight() {
    return this.busy;
  }

  /** One-off frames (init); kept in order. */
  push(bytes: Uint8Array) {
    this.pendingOther.push(bytes);
    return this.pump();
  }

  /** Replaces any resistance frame that hasn't been sent yet. */
  setResistance(bytes: Uint8Array) {
    this.pendingResistance = bytes;
    return this.pump();
  }

  /** Keep-alive: skipped when the link is busy or anything else is waiting. */
  poll(bytes: Uint8Array) {
    if (this.busy || this.pendingResistance || this.pendingOther.length) return Promise.resolve();
    this.pendingOther.push(bytes);
    return this.pump();
  }

  clear() {
    this.pendingResistance = null;
    this.pendingOther = [];
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (;;) {
        let next = this.pendingOther.shift();
        if (!next && this.pendingResistance) {
          next = this.pendingResistance;
          this.pendingResistance = null;
        }
        if (!next) break;
        try {
          await this.write(next);
        } catch (err) {
          this.onError(err);
        }
      }
    } finally {
      this.busy = false;
    }
  }
}

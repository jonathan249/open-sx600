import { describe, expect, test } from "bun:test";
import { downsample, elapsedMs, integrationSeconds, pause, resume } from "./ride";
import { WriteQueue } from "./sx600/write-queue";

describe("ride clock", () => {
  test("elapsed excludes paused time", () => {
    let c = { startedAt: 0, pausedMs: 0, pausedSince: null as number | null };
    expect(elapsedMs(c, 10_000)).toBe(10_000);
    c = pause(c, 10_000);
    expect(elapsedMs(c, 25_000)).toBe(10_000);
    c = resume(c, 25_000);
    expect(elapsedMs(c, 30_000)).toBe(15_000);
  });

  test("pause and resume are idempotent", () => {
    const c = pause(pause({ startedAt: 0, pausedMs: 0, pausedSince: null }, 5), 9);
    expect(c.pausedSince).toBe(5);
    expect(resume(resume(c, 10), 20).pausedMs).toBe(5);
  });

  test("integration gap is capped", () => {
    expect(integrationSeconds(0, 1000)).toBe(1);
    expect(integrationSeconds(0, 60_000)).toBe(5);
    expect(integrationSeconds(1000, 0)).toBe(0);
  });
});

describe("downsample", () => {
  test("keeps short series and averages long ones", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ t: i, p: i * 10 }));
    expect(downsample(rows, 20)).toBe(rows);
    const out = downsample(rows, 5);
    expect(out).toHaveLength(5);
    expect(out[0]).toEqual({ t: 0, p: 5 });
  });

  test("ignores missing values in a bucket", () => {
    const out = downsample([{ t: 0, hr: undefined }, { t: 1, hr: 120 }] as { t: number; hr?: number }[], 1);
    expect(out[0].hr).toBe(120);
  });
});

describe("write queue", () => {
  const frame = (n: number) => Uint8Array.from([n]);

  test("commands keep order before a pending resistance change", async () => {
    const sent: number[] = [];
    let release!: () => void;
    const q = new WriteQueue(async (b) => {
      sent.push(b[0]);
      if (b[0] === 1) await new Promise<void>((r) => (release = r));
    });
    const first = q.push(frame(1));
    void q.setResistance(frame(5));
    void q.push(frame(2)); // e.g. "start": must precede the resistance target
    release();
    await first;
    expect(sent).toEqual([1, 2, 5]);
  });

  test("resistance is latest-wins and polls are dropped while busy", async () => {
    const sent: number[] = [];
    let release!: () => void;
    const q = new WriteQueue(async (b) => {
      sent.push(b[0]);
      if (b[0] === 1) await new Promise<void>((r) => (release = r));
    });
    const first = q.push(frame(1)); // in flight, blocks
    void q.poll(frame(9)); // dropped: link busy
    void q.setResistance(frame(2));
    void q.setResistance(frame(3)); // replaces 2
    release();
    await first;
    expect(sent).toEqual([1, 3]);
  });

  test("poll goes out when idle", async () => {
    const sent: number[] = [];
    const q = new WriteQueue(async (b) => {
      sent.push(b[0]);
    });
    await q.poll(frame(7));
    expect(sent).toEqual([7]);
  });

  test("a failed write doesn't stall the queue", async () => {
    const sent: number[] = [];
    const errors: unknown[] = [];
    const q = new WriteQueue(
      async (b) => {
        if (b[0] === 1) throw new Error("boom");
        sent.push(b[0]);
      },
      (e) => errors.push(e),
    );
    void q.push(frame(1));
    await q.push(frame(2));
    expect(sent).toEqual([2]);
    expect(errors).toHaveLength(1);
  });
});

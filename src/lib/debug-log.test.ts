import { describe, expect, test } from "bun:test";
import { debugLog, isStreamEntry } from "./debug-log";

describe("debug log", () => {
  test("data packets are stream entries; control replies and status are not", () => {
    expect(isStreamEntry({ kind: "rx", channel: "2AD2 Indoor Bike Data" })).toBe(true);
    expect(isStreamEntry({ kind: "rx", channel: "2A37 Heart Rate" })).toBe(true);
    expect(isStreamEntry({ kind: "rx", channel: "2AD9 FTMS Control Point" })).toBe(false);
    expect(isStreamEntry({ kind: "rx", channel: "2ADA FTMS Status" })).toBe(false);
    expect(isStreamEntry({ kind: "tx", channel: "2AD9 FTMS Control Point" })).toBe(false);
    expect(isStreamEntry({ kind: "info" })).toBe(false);
  });

  test("a long data stream doesn't push control events out, and order is kept", () => {
    debugLog.clear();
    debugLog.add({ source: "bike", kind: "tx", channel: "2AD9 FTMS Control Point", text: "setTargetResistance" });
    for (let i = 0; i < 5000; i++) debugLog.add({ source: "bike", kind: "rx", channel: "2AD2 Indoor Bike Data", text: `p${i}` });
    debugLog.add({ source: "bike", kind: "rx", channel: "2AD9 FTMS Control Point", text: "response: op code not supported" });

    const report = debugLog.report();
    expect(report).toContain("setTargetResistance");
    expect(report).toContain("op code not supported");
    expect(report).toContain("p4999");
    expect(report).not.toContain("p4000 ");

    const json = JSON.parse(debugLog.json()) as { entries: { id: number; text: string }[] };
    const ids = json.entries.map((e) => e.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(json.entries[0].text).toBe("setTargetResistance");
    expect(json.entries.at(-1)!.text).toBe("response: op code not supported");
    debugLog.clear();
  });
});

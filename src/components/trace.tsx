"use client";

import { Area, AreaChart, XAxis, YAxis } from "recharts";
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";

const tick = { fontFamily: "var(--font-sans)", fontSize: 11, fill: "var(--muted-foreground)" };

/** Single-series line with a soft fade-out fill. `x` is the key on each row used for the axis and tooltip. */
export function Trace<T extends Record<string, unknown>>({
  data,
  dataKey,
  label,
  color,
  x,
  formatX,
  showX = false,
  height = "h-44",
}: {
  data: T[];
  dataKey: keyof T & string;
  label: string;
  color: string;
  x: keyof T & string;
  formatX: (v: number) => string;
  showX?: boolean;
  height?: string;
}) {
  const config = { [dataKey]: { label, color } } satisfies ChartConfig;
  return (
    <ChartContainer config={config} className={`aspect-auto ${height} w-full`}>
      <AreaChart data={data} margin={{ left: 0, right: 8, top: 8, bottom: 0 }} accessibilityLayer>
        <XAxis
          dataKey={x as string}
          hide={!showX}
          type="number"
          domain={["dataMin", "dataMax"]}
          tickLine={false}
          axisLine={false}
          minTickGap={48}
          tickFormatter={(v: number) => formatX(v)}
          tick={tick}
        />
        <YAxis width={36} tickLine={false} axisLine={false} domain={[0, "auto"]} tick={tick} />
        <ChartTooltip
          cursor={{ stroke: "var(--muted-foreground)", strokeWidth: 1 }}
          content={<ChartTooltipContent labelFormatter={(_, p) => formatX(Number(p?.[0]?.payload?.[x]))} />}
        />
        <defs>
          <linearGradient id={`fill-${dataKey}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={`var(--color-${dataKey})`} stopOpacity={0.18} />
            <stop offset="100%" stopColor={`var(--color-${dataKey})`} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area
          type="monotone"
          dataKey={dataKey as string}
          stroke={`var(--color-${dataKey})`}
          fill={`url(#fill-${dataKey})`}
          strokeWidth={1.5}
          dot={false}
          connectNulls
          isAnimationActive={false}
        />
      </AreaChart>
    </ChartContainer>
  );
}

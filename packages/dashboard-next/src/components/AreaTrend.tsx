import { AreaChart } from "@lobehub/charts";

interface Series {
  key: string;
  color: string;
  name: string;
}
interface Props {
  data: Record<string, number | string>[];
  series: Series[];
  height?: number | string;
  yDomain?: [number, number];
  xKey?: string;
}

export function AreaTrend({ data, series, height = 160, yDomain, xKey = "t" }: Props) {
  return (
    <AreaChart
      data={data}
      index={xKey}
      categories={series.map((s) => s.key)}
      colors={series.map((s) => s.color)}
      height={height}
      yAxisDomain={yDomain}
      showGradient
      showLegend={series.length > 1}
      showXAxis={false}
      showGridLines={false}
      yAxisWidth={28}
      valueFormatter={(v) => (typeof v === "number" ? v.toFixed(1) : String(v))}
    />
  );
}

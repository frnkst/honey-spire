"use client";

import { useEffect, useRef } from "react";
import type { ECharts, EChartsOption } from "echarts";
import type { FeatureCollection, Geometry } from "geojson";
import type {
  GeometryCollection,
  Properties,
  Topology,
} from "topojson-specification";
import type { DashboardData } from "@/lib/types";

function useChart(option: EChartsOption, dependencies: unknown[]) {
  const element = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let chart: ECharts | undefined;
    let cancelled = false;
    void import("echarts").then((echarts) => {
      if (cancelled || !element.current) return;
      chart = echarts.init(element.current, undefined, { renderer: "canvas" });
      chart.setOption(option);
    });
    const resize = () => chart?.resize();
    window.addEventListener("resize", resize);
    return () => {
      cancelled = true;
      window.removeEventListener("resize", resize);
      chart?.dispose();
    };
    // The chart is recreated only when its source data changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, dependencies);

  return element;
}

export function AttackTrend({ data }: { data: DashboardData }) {
  const ref = useChart(
    {
      animationDuration: 700,
      grid: { left: 38, right: 14, top: 18, bottom: 30 },
      tooltip: {
        trigger: "axis",
        backgroundColor: "#1F1F22",
        borderColor: "rgba(242,201,76,.3)",
        textStyle: { color: "#F7F7F7" },
      },
      xAxis: {
        type: "category",
        boundaryGap: false,
        data: data.trend.map((point) =>
          new Date(point.timestamp).toLocaleString([], {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          }),
        ),
        axisLine: { lineStyle: { color: "#34343a" } },
        axisLabel: { color: "#85858f", hideOverlap: true },
      },
      yAxis: {
        type: "value",
        minInterval: 1,
        splitLine: { lineStyle: { color: "rgba(255,255,255,.05)" } },
        axisLabel: { color: "#85858f" },
      },
      series: [
        {
          type: "line",
          smooth: true,
          symbol: "none",
          lineStyle: { color: "#F2C94C", width: 2 },
          areaStyle: {
            color: {
              type: "linear",
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: "rgba(242,201,76,.32)" },
                { offset: 1, color: "rgba(242,201,76,0)" },
              ],
            },
          },
          data: data.trend.map((point) => point.count),
        },
      ],
    },
    [data.trend],
  );

  return <div className="h-72 w-full" ref={ref} />;
}

export function AttackGauge({ data }: { data: DashboardData }) {
  const ref = useChart(
    {
      animationDuration: 600,
      series: [
        {
          type: "gauge",
          startAngle: 210,
          endAngle: -30,
          min: 0,
          max: data.gaugeMaximum,
          splitNumber: 5,
          pointer: {
            length: "58%",
            width: 5,
            itemStyle: { color: "#F2C94C" },
          },
          progress: {
            show: true,
            roundCap: true,
            width: 12,
            itemStyle: { color: "#F2C94C" },
          },
          axisLine: {
            roundCap: true,
            lineStyle: { width: 12, color: [[1, "#29292e"]] },
          },
          axisTick: { show: false },
          splitLine: { distance: -18, length: 5, lineStyle: { color: "#666" } },
          axisLabel: { distance: 18, color: "#85858f", fontSize: 10 },
          anchor: {
            show: true,
            size: 12,
            itemStyle: { color: "#0A0A0C", borderColor: "#F2C94C" },
          },
          title: {
            offsetCenter: [0, "68%"],
            color: "#85858f",
            fontSize: 11,
          },
          detail: {
            offsetCenter: [0, "35%"],
            color: "#F7F7F7",
            fontSize: 28,
            fontFamily: "JetBrains Mono",
            formatter: "{value}",
          },
          data: [{ value: data.currentRate, name: "ATTACKS / MIN" }],
        },
      ],
    },
    [data.currentRate, data.gaugeMaximum],
  );

  return <div className="h-72 w-full" ref={ref} />;
}

export function AttackMap({ data }: { data: DashboardData }) {
  const element = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let chart: ECharts | undefined;
    let cancelled = false;

    void Promise.all([
      import("echarts"),
      import("world-atlas/countries-110m.json"),
      import("topojson-client"),
    ]).then(([echarts, topologyModule, topojson]) => {
      if (cancelled || !element.current) return;
      const topology = topologyModule.default as unknown as Topology<{
        countries: GeometryCollection<Properties>;
      }>;
      const geoJson = topojson.feature(
        topology,
        topology.objects.countries,
      ) as FeatureCollection<Geometry, Properties>;
      echarts.registerMap(
        "world",
        geoJson as unknown as Parameters<typeof echarts.registerMap>[1],
      );
      chart = echarts.init(element.current, undefined, { renderer: "canvas" });
      chart.setOption({
        animationDuration: 900,
        tooltip: {
          trigger: "item",
          backgroundColor: "#1F1F22",
          borderColor: "rgba(242,201,76,.3)",
          textStyle: { color: "#F7F7F7" },
          formatter: (params: { data?: { label?: string } }) =>
            params.data?.label ?? "",
        },
        geo: {
          map: "world",
          roam: true,
          silent: true,
          itemStyle: {
            areaColor: "#17171b",
            borderColor: "#36363d",
            borderWidth: 0.6,
          },
          emphasis: { disabled: true },
        },
        series: [
          {
            type: "effectScatter",
            coordinateSystem: "geo",
            rippleEffect: { scale: 5, brushType: "stroke" },
            symbolSize: 7,
            itemStyle: {
              color: "#F2C94C",
              shadowBlur: 16,
              shadowColor: "#F2C94C",
            },
            data: data.mapAttacks.map((attack) => ({
              value: [attack.longitude, attack.latitude, 1],
              label: `${attack.city ?? attack.countryName ?? "Unknown"} · ${attack.sourceIp}`,
            })),
          },
        ],
      });
    });

    const resize = () => chart?.resize();
    window.addEventListener("resize", resize);
    return () => {
      cancelled = true;
      window.removeEventListener("resize", resize);
      chart?.dispose();
    };
  }, [data.mapAttacks]);

  return <div className="h-[23rem] w-full" ref={element} />;
}

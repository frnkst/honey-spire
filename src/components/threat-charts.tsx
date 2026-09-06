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
      animationDuration: 900,
      animationEasing: "cubicOut",
      grid: { left: 46, right: 18, top: 28, bottom: 34 },
      tooltip: {
        trigger: "axis",
        backgroundColor: "rgba(12,13,11,.96)",
        borderColor: "rgba(255,194,71,.35)",
        borderWidth: 1,
        padding: [10, 12],
        textStyle: {
          color: "#F1EEE4",
          fontFamily: "IBM Plex Mono",
          fontSize: 11,
        },
        axisPointer: {
          type: "line",
          lineStyle: { color: "rgba(98,200,220,.35)", type: "dashed" },
        },
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
        axisLine: { lineStyle: { color: "rgba(241,238,228,.12)" } },
        axisTick: { show: false },
        axisLabel: {
          color: "#73766e",
          hideOverlap: true,
          fontFamily: "IBM Plex Mono",
          fontSize: 9,
          margin: 14,
        },
      },
      yAxis: {
        type: "value",
        minInterval: 1,
        splitLine: {
          lineStyle: { color: "rgba(241,238,228,.055)", type: "dashed" },
        },
        axisLabel: {
          color: "#73766e",
          fontFamily: "IBM Plex Mono",
          fontSize: 9,
        },
      },
      series: [
        {
          type: "line",
          smooth: 0.38,
          symbol: "none",
          lineStyle: {
            color: "#FFC247",
            width: 2,
            shadowBlur: 14,
            shadowColor: "rgba(255,194,71,.3)",
          },
          areaStyle: {
            color: {
              type: "linear",
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: "rgba(255,194,71,.26)" },
                { offset: 0.65, color: "rgba(255,194,71,.04)" },
                { offset: 1, color: "rgba(255,194,71,0)" },
              ],
            },
          },
          data: data.trend.map((point) => point.count),
        },
      ],
    },
    [data.trend],
  );

  return <div className="h-80 w-full" ref={ref} />;
}

export function AttackGauge({ data }: { data: DashboardData }) {
  const ref = useChart(
    {
      animationDuration: 1000,
      animationEasing: "cubicOut",
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
            itemStyle: { color: "#FFC247" },
          },
          progress: {
            show: true,
            roundCap: true,
            width: 12,
            itemStyle: {
              color: "#FFC247",
              shadowBlur: 14,
              shadowColor: "rgba(255,194,71,.35)",
            },
          },
          axisLine: {
            roundCap: true,
            lineStyle: {
              width: 12,
              color: [[1, "rgba(241,238,228,.075)"]],
            },
          },
          axisTick: { show: false },
          splitLine: {
            distance: -18,
            length: 5,
            lineStyle: { color: "rgba(98,200,220,.35)", width: 1 },
          },
          axisLabel: {
            distance: 18,
            color: "#73766e",
            fontFamily: "IBM Plex Mono",
            fontSize: 9,
          },
          anchor: {
            show: true,
            size: 12,
            itemStyle: { color: "#080907", borderColor: "#FFC247" },
          },
          title: {
            offsetCenter: [0, "68%"],
            color: "#73766e",
            fontFamily: "IBM Plex Mono",
            fontSize: 9,
          },
          detail: {
            offsetCenter: [0, "35%"],
            color: "#F1EEE4",
            fontSize: 34,
            fontFamily: "Barlow Condensed",
            fontWeight: 600,
            formatter: "{value}",
          },
          data: [{ value: data.currentRate, name: "ATTACKS / MIN" }],
        },
      ],
    },
    [data.currentRate, data.gaugeMaximum],
  );

  return <div className="h-80 w-full" ref={ref} />;
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
        animationDuration: 1200,
        animationEasing: "cubicOut",
        tooltip: {
          trigger: "item",
          backgroundColor: "rgba(12,13,11,.96)",
          borderColor: "rgba(255,194,71,.35)",
          padding: [10, 12],
          textStyle: {
            color: "#F1EEE4",
            fontFamily: "IBM Plex Mono",
            fontSize: 11,
          },
          formatter: (params: { data?: { label?: string } }) =>
            params.data?.label ?? "",
        },
        geo: {
          map: "world",
          roam: true,
          silent: true,
          itemStyle: {
            areaColor: "#12130f",
            borderColor: "rgba(98,200,220,.18)",
            borderWidth: 0.7,
          },
          emphasis: { disabled: true },
        },
        series: [
          {
            type: "effectScatter",
            coordinateSystem: "geo",
            rippleEffect: { scale: 6, brushType: "stroke", number: 2 },
            symbolSize: 6,
            itemStyle: {
              color: "#FFC247",
              shadowBlur: 18,
              shadowColor: "rgba(255,194,71,.7)",
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

  return <div className="h-[28rem] w-full sm:h-[34rem]" ref={element} />;
}

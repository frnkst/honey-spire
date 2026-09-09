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
          // Thin inner arc: the previous minute, kept as a reference trace.
          type: "gauge",
          startAngle: 210,
          endAngle: -30,
          min: 0,
          max: data.gaugeMaximum,
          radius: "64%",
          center: ["50%", "57%"],
          pointer: { show: false },
          progress: {
            show: true,
            roundCap: true,
            width: 4,
            itemStyle: { color: "rgba(98,200,220,.8)" },
          },
          axisLine: {
            lineStyle: { width: 4, color: [[1, "rgba(241,238,228,.06)"]] },
          },
          axisTick: { show: false },
          splitLine: { show: false },
          axisLabel: { show: false },
          anchor: { show: false },
          title: { show: false },
          detail: { show: false },
          silent: true,
          data: [{ value: data.previousRate }],
        },
        {
          type: "gauge",
          startAngle: 210,
          endAngle: -30,
          min: 0,
          max: data.gaugeMaximum,
          radius: "94%",
          center: ["50%", "57%"],
          splitNumber: 4,
          pointer: {
            length: "62%",
            width: 4,
            offsetCenter: [0, "10%"],
            itemStyle: {
              color: "#FFC247",
              shadowBlur: 10,
              shadowColor: "rgba(255,194,71,.55)",
            },
          },
          progress: {
            show: true,
            roundCap: true,
            width: 13,
            itemStyle: {
              color: {
                type: "linear",
                x: 0,
                y: 1,
                x2: 1,
                y2: 0,
                colorStops: [
                  { offset: 0, color: "#62C8DC" },
                  { offset: 0.55, color: "#FFC247" },
                  { offset: 1, color: "#FF7A45" },
                ],
              },
              shadowBlur: 20,
              shadowColor: "rgba(255,194,71,.4)",
            },
          },
          axisLine: {
            roundCap: true,
            lineStyle: {
              width: 13,
              color: [
                [0.45, "rgba(98,200,220,.13)"],
                [0.75, "rgba(255,194,71,.15)"],
                [1, "rgba(255,98,89,.17)"],
              ],
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
            size: 9,
            itemStyle: {
              color: "#080907",
              borderColor: "#FFC247",
              borderWidth: 1.5,
            },
          },
          title: {
            offsetCenter: [0, "62%"],
            color: "#73766e",
            fontFamily: "IBM Plex Mono",
            fontSize: 9,
          },
          detail: {
            offsetCenter: [0, "24%"],
            formatter: (value: number) => `{v|${Math.round(value)}}{u| /MIN}`,
            rich: {
              v: {
                color: "#F1EEE4",
                fontSize: 42,
                fontFamily: "Barlow Condensed",
                fontWeight: 600,
              },
              u: {
                color: "#73766e",
                fontSize: 10,
                fontFamily: "IBM Plex Mono",
                padding: [14, 0, 0, 4],
              },
            },
          },
          data: [
            { value: data.currentRate, name: `OF ${data.gaugeMaximum} PEAK` },
          ],
        },
      ],
    },
    [data.currentRate, data.previousRate, data.gaugeMaximum],
  );

  return (
    <>
      <div className="h-56 w-full sm:h-60" ref={ref} />
      <div className="mt-1 flex items-center justify-center gap-5">
        <span className="data-label flex items-center gap-1.5">
          <span className="h-[3px] w-4 rounded-full bg-primary shadow-[0_0_8px_rgba(255,194,71,.7)]" />
          Current minute
        </span>
        <span className="data-label flex items-center gap-1.5">
          <span className="h-[2px] w-4 rounded-full bg-secondary/80" />
          Previous
        </span>
      </div>
    </>
  );
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
          {
            // This tower and its beecons: emerald triangles above the attacks.
            type: "effectScatter",
            coordinateSystem: "geo",
            zlevel: 2,
            symbol: "triangle",
            rippleEffect: {
              scale: 2.6,
              brushType: "stroke",
              number: 1,
              period: 4.5,
            },
            itemStyle: {
              color: "#34D399",
              shadowBlur: 14,
              shadowColor: "rgba(52,211,153,.65)",
            },
            label: {
              show: true,
              position: "top",
              distance: 7,
              formatter: "{b}",
              color: "#6EE7B7",
              fontFamily: "IBM Plex Mono",
              fontSize: 9,
              textBorderColor: "rgba(8,9,7,.9)",
              textBorderWidth: 2,
            },
            data: data.sensors.map((sensor) => ({
              value: [sensor.longitude, sensor.latitude, 1],
              name: sensor.local ? "TOWER" : sensor.name,
              label: [
                sensor.local
                  ? "TOWER · This server (built-in)"
                  : `BEECON · ${sensor.name}`,
                sensor.location ?? "Unknown location",
                sensor.online ? "online" : "offline",
              ].join("<br/>"),
              symbolSize: sensor.online ? 11 : 9,
              itemStyle: sensor.online
                ? undefined
                : {
                    color: "rgba(52,211,153,.1)",
                    borderColor: "#34D399",
                    borderWidth: 1.4,
                    shadowBlur: 0,
                  },
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
  }, [data.mapAttacks, data.sensors]);

  return <div className="h-[28rem] w-full sm:h-[34rem]" ref={element} />;
}

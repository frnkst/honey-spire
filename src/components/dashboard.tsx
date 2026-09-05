"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Activity,
  Clock3,
  Globe2,
  LogOut,
  Radio,
  ShieldAlert,
} from "lucide-react";
import { AttackGauge, AttackMap, AttackTrend } from "@/components/threat-charts";
import { Brand } from "@/components/brand";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { AttackEvent, DashboardData, RankedValue } from "@/lib/types";

const ranges = ["1h", "24h", "7d", "30d"];

function MetricCard({
  label,
  value,
  detail,
  icon: Icon,
}: {
  label: string;
  value: string | number;
  detail: string;
  icon: typeof Activity;
}) {
  return (
    <Card className="glass-card border-white/[.06]">
      <CardContent className="flex items-start justify-between p-5">
        <div>
          <p className="text-xs font-medium uppercase tracking-[.16em] text-muted-foreground">
            {label}
          </p>
          <p className="mt-2 font-mono text-3xl font-semibold tracking-tight">
            {value}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
        </div>
        <div className="rounded-xl border border-primary/15 bg-primary/[.06] p-2.5">
          <Icon className="size-5 text-primary" />
        </div>
      </CardContent>
    </Card>
  );
}

function RankTable({
  title,
  values,
  mono = false,
}: {
  title: string;
  values: RankedValue[];
  mono?: boolean;
}) {
  return (
    <Card className="glass-card min-w-0 border-white/[.06]">
      <CardHeader>
        <CardTitle className="font-heading text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="px-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12 pl-6">#</TableHead>
              <TableHead>Value</TableHead>
              <TableHead className="pr-6 text-right">Count</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {values.length ? (
              values.map((item, index) => (
                <TableRow key={`${item.value}-${index}`}>
                  <TableCell className="pl-6 text-muted-foreground">
                    {String(index + 1).padStart(2, "0")}
                  </TableCell>
                  <TableCell
                    className={
                      mono
                        ? "max-w-40 truncate font-mono text-xs"
                        : "max-w-40 truncate"
                    }
                    title={item.value}
                  >
                    {item.value || "(empty)"}
                  </TableCell>
                  <TableCell className="pr-6 text-right font-mono text-primary">
                    {item.count}
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  className="h-24 text-center text-muted-foreground"
                  colSpan={3}
                >
                  Waiting for attacks
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function formatLocation(attack: AttackEvent) {
  return [attack.city, attack.countryCode].filter(Boolean).join(", ") || "Unknown";
}

export function Dashboard({ initialData }: { initialData: DashboardData }) {
  const router = useRouter();
  const [data, setData] = useState(initialData);
  const [range, setRange] = useState(initialData.range);
  const [connected, setConnected] = useState(false);

  const refresh = useCallback(async (selectedRange: string) => {
    const response = await fetch(`/api/dashboard?range=${selectedRange}`, {
      cache: "no-store",
    });
    if (response.status === 401) {
      router.replace("/login");
      router.refresh();
      return;
    }
    if (response.ok) setData((await response.json()) as DashboardData);
  }, [router]);

  useEffect(() => {
    const interval = setInterval(() => void refresh(range), 30_000);
    return () => clearInterval(interval);
  }, [range, refresh]);

  useEffect(() => {
    const events = new EventSource("/api/events");
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    events.onopen = () => setConnected(true);
    events.onerror = () => setConnected(false);
    events.addEventListener("attack", () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => void refresh(range), 500);
    });
    return () => {
      clearTimeout(refreshTimer);
      events.close();
    };
  }, [range, refresh]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  const delta = data.currentRate - data.previousRate;

  return (
    <main className="hex-grid min-h-screen">
      <header className="sticky top-0 z-20 border-b border-white/[.06] bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1600px] items-center justify-between px-4 py-3 sm:px-6">
          <Brand compact />
          <div className="flex items-center gap-3">
            <Badge
              className={
                connected
                  ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-300"
                  : "border-white/10 bg-white/5 text-muted-foreground"
              }
              variant="outline"
            >
              <Radio className={connected ? "animate-pulse" : ""} />
              {connected ? "Live" : "Reconnecting"}
            </Badge>
            <Button
              aria-label="Log out"
              onClick={logout}
              size="icon"
              variant="ghost"
            >
              <LogOut />
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1600px] space-y-5 px-4 py-6 sm:px-6 lg:py-8">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div>
            <p className="mb-1 text-xs font-medium uppercase tracking-[.18em] text-primary">
              Threat overview
            </p>
            <h1 className="font-heading text-2xl font-semibold sm:text-3xl">
              The spire is watching.
            </h1>
          </div>
          <div className="flex rounded-xl border border-white/[.06] bg-card/70 p-1">
            {ranges.map((item) => (
              <Button
                className="h-8 flex-1 px-3 text-xs sm:flex-none"
                key={item}
                onClick={() => {
                  setRange(item);
                  void refresh(item);
                }}
                size="sm"
                variant={range === item ? "default" : "ghost"}
              >
                {item}
              </Button>
            ))}
          </div>
        </div>

        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            detail={`${delta >= 0 ? "+" : ""}${delta} vs previous minute`}
            icon={Activity}
            label="Current attack rate"
            value={`${data.currentRate}/m`}
          />
          <MetricCard
            detail={`During the selected ${range} window`}
            icon={ShieldAlert}
            label="Observed attacks"
            value={data.totalAttacks.toLocaleString()}
          />
          <MetricCard
            detail="Distinct sources in top rankings"
            icon={Globe2}
            label="Tracked sources"
            value={data.topIps.length}
          />
          <MetricCard
            detail={`Updated ${new Date(data.generatedAt).toLocaleTimeString()}`}
            icon={Clock3}
            label="Telemetry status"
            value={connected ? "LIVE" : "SYNC"}
          />
        </section>

        <section className="grid gap-4 xl:grid-cols-[1.65fr_1fr]">
          <Card className="glass-card min-w-0 border-white/[.06]">
            <CardHeader>
              <CardTitle className="font-heading text-base">
                Attack volume
              </CardTitle>
            </CardHeader>
            <CardContent className="px-2 pb-2 sm:px-4">
              <AttackTrend data={data} />
            </CardContent>
          </Card>
          <Card className="glass-card gold-glow min-w-0 border-primary/15">
            <CardHeader>
              <CardTitle className="font-heading text-base">
                Live intensity
              </CardTitle>
            </CardHeader>
            <CardContent className="px-2 pb-2">
              <AttackGauge data={data} />
            </CardContent>
          </Card>
        </section>

        <Card className="glass-card min-w-0 overflow-hidden border-white/[.06]">
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="font-heading text-base">
              Global attack origin
            </CardTitle>
            <Badge variant="outline">{data.mapAttacks.length} recent</Badge>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            <AttackMap data={data} />
          </CardContent>
        </Card>

        <section className="grid gap-4 xl:grid-cols-3">
          <RankTable mono title="Top 20 IP addresses" values={data.topIps} />
          <RankTable title="Top 20 usernames" values={data.topUsernames} />
          <RankTable mono title="Top 20 passwords" values={data.topPasswords} />
        </section>

        <Card className="glass-card min-w-0 border-white/[.06]">
          <CardHeader>
            <CardTitle className="font-heading text-base">
              20 most recent attacks
            </CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto px-0">
            <Table className="min-w-[900px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">Time</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead>Username</TableHead>
                  <TableHead>Password</TableHead>
                  <TableHead>Client fingerprint</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.recentAttacks.length ? (
                  data.recentAttacks.map((attack) => (
                    <TableRow key={attack.id}>
                      <TableCell className="pl-6 font-mono text-xs text-muted-foreground">
                        {new Date(attack.occurredAt).toLocaleString()}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-primary">
                        {attack.sourceIp}
                      </TableCell>
                      <TableCell>{formatLocation(attack)}</TableCell>
                      <TableCell className="font-mono text-xs">
                        {attack.username || "(empty)"}
                      </TableCell>
                      <TableCell className="max-w-48 truncate font-mono text-xs">
                        {attack.password || "(empty)"}
                      </TableCell>
                      <TableCell
                        className="max-w-56 truncate font-mono text-xs text-secondary"
                        title={attack.hassh ?? attack.clientVersion ?? ""}
                      >
                        {attack.hassh ?? attack.clientVersion ?? "Unknown"}
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell
                      className="h-28 text-center text-muted-foreground"
                      colSpan={6}
                    >
                      No attacks recorded yet. Cowrie is listening.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <footer className="pb-4 text-center text-xs text-muted-foreground">
          Optional IP geolocation uses free GeoLite2 data created by MaxMind.
        </footer>
      </div>
    </main>
  );
}

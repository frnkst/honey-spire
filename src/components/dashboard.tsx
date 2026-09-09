"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  Activity,
  Check,
  Crosshair,
  Database,
  Globe2,
  LogOut,
  LoaderCircle,
  Minus,
  Radio,
  Send,
  ShieldAlert,
  TerminalSquare,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import {
  BeeconJoinBanner,
  BeeconTable,
  beeconLabel,
  formatJoined,
  joinedAt,
  liveBeecons,
  useBeecons,
} from "@/components/beecons";
import {
  AttackGauge,
  AttackMap,
  AttackTrend,
} from "@/components/threat-charts";
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

const COMPACT_COUNTS = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

function MetricCard({
  index,
  label,
  value,
  detail,
  icon: Icon,
  accent = "gold",
}: {
  index: string;
  label: string;
  value: string | number;
  detail: string;
  icon: typeof Activity;
  accent?: "gold" | "cyan";
}) {
  return (
    <Card
      className={`glass-card instrument-card reveal min-h-40 border-white/[.07] ${
        accent === "cyan" ? "cyan-instrument" : ""
      }`}
    >
      <CardContent className="flex h-full flex-col justify-between p-5">
        <div className="flex items-center justify-between">
          <span className="section-index">{index}</span>
          <Icon
            className={
              accent === "cyan"
                ? "size-4 text-secondary"
                : "size-4 text-primary"
            }
            strokeWidth={1.5}
          />
        </div>
        <div>
          <p className="mt-7 font-heading text-[2.75rem] font-semibold leading-none tracking-[-.035em]">
            {value}
          </p>
          <p className="data-label mt-3 text-foreground/75">{label}</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {detail}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function GaugeStat({
  label,
  value,
  icon: Icon,
  tone = "text-foreground",
}: {
  label: string;
  value: string;
  icon: typeof Activity;
  tone?: string;
}) {
  return (
    <div className="flex flex-col items-center gap-1.5 px-1">
      <span className={`flex items-center gap-1 font-mono text-sm ${tone}`}>
        <Icon className="size-3" strokeWidth={1.75} />
        {value}
      </span>
      <span className="data-label">{label}</span>
    </div>
  );
}

function SectionHeading({
  index,
  title,
  detail,
}: {
  index: string;
  title: string;
  detail: string;
}) {
  return (
    <div className="mb-4 flex items-end justify-between gap-4 border-b border-white/[.07] pb-3">
      <div className="flex items-baseline gap-3">
        <span className="section-index">{index}</span>
        <h2 className="font-heading text-2xl font-semibold uppercase tracking-[.02em]">
          {title}
        </h2>
      </div>
      <p className="data-label hidden sm:block">{detail}</p>
    </div>
  );
}

function ReconShell({
  index,
  title,
  tag,
  children,
}: {
  index: string;
  title: string;
  tag: string;
  children: ReactNode;
}) {
  return (
    <Card className="glass-card instrument-card cyan-instrument reveal min-w-0 border-white/[.07]">
      <CardHeader className="grid-cols-[1fr_auto] items-center border-b border-white/[.06] pb-4">
        <div>
          <span className="section-index">{index}</span>
          <CardTitle className="mt-1 font-heading text-xl uppercase tracking-wide">
            {title}
          </CardTitle>
        </div>
        <span className="data-label">{tag}</span>
      </CardHeader>
      <CardContent className="max-h-[24rem] overflow-y-auto px-0">
        {children}
      </CardContent>
    </Card>
  );
}

function RankTable({
  index,
  title,
  values,
  mono = false,
}: {
  index: string;
  title: string;
  values: RankedValue[];
  mono?: boolean;
}) {
  const maximum = Math.max(1, ...values.map((item) => item.count));
  return (
    <Card className="glass-card instrument-card reveal min-w-0 border-white/[.07]">
      <CardHeader className="grid-cols-[1fr_auto] items-center border-b border-white/[.06] pb-4">
        <div>
          <span className="section-index">{index}</span>
          <CardTitle className="mt-1 font-heading text-xl uppercase tracking-wide">
            {title}
          </CardTitle>
        </div>
        <span className="data-label">{values.length}/20</span>
      </CardHeader>
      <CardContent className="max-h-[28rem] overflow-y-auto px-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12 pl-5 text-[10px] uppercase tracking-[.14em] text-muted-foreground">
                Pos
              </TableHead>
              <TableHead className="text-[10px] uppercase tracking-[.14em] text-muted-foreground">
                Signal
              </TableHead>
              <TableHead className="pr-5 text-right text-[10px] uppercase tracking-[.14em] text-muted-foreground">
                Hits
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {values.length ? (
              values.map((item, index) => (
                <TableRow
                  className="group/row border-white/[.05]"
                  key={`${item.value}-${index}`}
                >
                  <TableCell className="pl-5 font-mono text-[10px] text-muted-foreground">
                    {String(index + 1).padStart(2, "0")}
                  </TableCell>
                  <TableCell className="relative py-3" title={item.value}>
                    <div
                      className="absolute inset-y-1 left-0 bg-primary/[.045] transition-colors group-hover/row:bg-primary/[.08]"
                      style={{ width: `${(item.count / maximum) * 100}%` }}
                    />
                    <span
                      className={`relative block max-w-44 truncate ${
                        mono ? "font-mono text-xs" : "text-sm"
                      }`}
                    >
                      {item.value || "(empty)"}
                    </span>
                  </TableCell>
                  <TableCell className="pr-5 text-right font-mono text-xs text-primary">
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
  return (
    [attack.city, attack.countryCode].filter(Boolean).join(", ") || "Unknown"
  );
}

export function Dashboard({ initialData }: { initialData: DashboardData }) {
  const router = useRouter();
  const [data, setData] = useState(initialData);
  const [range, setRange] = useState(initialData.range);
  const [connected, setConnected] = useState(false);
  const [telegramStatus, setTelegramStatus] = useState<
    "idle" | "sending" | "sent" | "error"
  >("idle");
  const [telegramError, setTelegramError] = useState("");
  const [beeconSignal, setBeeconSignal] = useState(0);
  const [beeconBusyId, setBeeconBusyId] = useState<string | null>(null);
  const {
    beecons: fleet,
    pending: pendingBeecons,
    error: beeconError,
    approve,
    remove,
  } = useBeecons(range, beeconSignal);

  const refresh = useCallback(
    async (selectedRange: string) => {
      const response = await fetch(`/api/dashboard?range=${selectedRange}`, {
        cache: "no-store",
      });
      if (response.status === 401) {
        router.replace("/login");
        router.refresh();
        return;
      }
      if (response.ok) setData((await response.json()) as DashboardData);
    },
    [router],
  );

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
    events.addEventListener("command", () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => void refresh(range), 250);
    });
    events.addEventListener("beecon", () => setBeeconSignal((n) => n + 1));
    return () => {
      clearTimeout(refreshTimer);
      events.close();
    };
  }, [range, refresh]);

  async function runBeeconAction(
    action: (id: string) => Promise<boolean>,
    id: string,
  ) {
    setBeeconBusyId(id);
    await action(id);
    setBeeconBusyId(null);
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  async function sendTelegramUpdate() {
    setTelegramStatus("sending");
    setTelegramError("");
    try {
      const response = await fetch("/api/telegram", { method: "POST" });
      if (response.ok) {
        setTelegramStatus("sent");
        return;
      }
      const body = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      setTelegramError(body?.error ?? "Send failed.");
      setTelegramStatus("error");
    } catch {
      setTelegramError("Could not reach the server.");
      setTelegramStatus("error");
    }
  }

  const delta = data.currentRate - data.previousRate;

  const liveFleet = liveBeecons(fleet);
  const activeFleet = (fleet ?? []).filter(
    (beecon) => beecon.status === "active",
  );
  const updatedAt = `Updated ${new Date(data.generatedAt).toLocaleTimeString()}`;
  const uplinkValue = !fleet
    ? "…"
    : connected
      ? `${liveFleet.length} LIVE`
      : "SYNC";
  const uplinkDetail = !fleet
    ? "Syncing the beecon fleet…"
    : !connected
      ? `Stream reconnecting · ${updatedAt}`
      : liveFleet.length
        ? `${liveFleet.length}/${activeFleet.length} beecons live · ${liveFleet
            .map(
              (beecon) =>
                `${beeconLabel(beecon)} (since ${formatJoined(joinedAt(beecon))})`,
            )
            .join(" · ")}`
        : `0/${activeFleet.length} beecons live · ${updatedAt}`;

  return (
    <main className="threat-field min-h-screen">
      <div className="scan-line" />
      <header className="sticky top-0 z-20 border-b border-white/[.07] bg-[#080907]/85 backdrop-blur-2xl">
        <div className="mx-auto flex max-w-[1720px] items-center justify-between px-4 py-3 sm:px-7">
          <Brand compact />
          <div className="flex items-center gap-2">
            <Button
              aria-label="Send update to Telegram"
              disabled={telegramStatus === "sending"}
              onClick={sendTelegramUpdate}
              size="sm"
              title={telegramStatus === "error" ? telegramError : undefined}
              variant="outline"
              className="h-8 rounded-sm border-white/10 bg-white/[.025] font-mono text-[10px] uppercase tracking-[.1em] hover:border-primary/30 hover:bg-primary/[.08]"
            >
              {telegramStatus === "sending" ? (
                <LoaderCircle className="animate-spin" />
              ) : telegramStatus === "sent" ? (
                <Check />
              ) : (
                <Send />
              )}
              <span className="sm:hidden">
                {telegramStatus === "sending"
                  ? "Sending"
                  : telegramStatus === "sent"
                    ? "Sent"
                    : telegramStatus === "error"
                      ? "Failed"
                      : "Telegram"}
              </span>
              <span className="hidden sm:inline">
                {telegramStatus === "sending"
                  ? "Sending update"
                  : telegramStatus === "sent"
                    ? "Update sent"
                    : telegramStatus === "error"
                      ? "Send failed"
                      : "Send to Telegram"}
              </span>
            </Button>
            <Button
              aria-label="Log out"
              onClick={logout}
              size="icon"
              variant="ghost"
              className="rounded-sm text-muted-foreground hover:text-foreground"
            >
              <LogOut />
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1720px] px-4 py-8 sm:px-7 lg:py-12">
        <section className="reveal relative mb-10 border-b border-white/[.08] pb-8 lg:mb-12 lg:pb-10">
          <div className="flex flex-col justify-between gap-7 lg:flex-row lg:items-end">
            <div className="max-w-4xl">
              <div className="mb-5 flex items-center gap-3">
                <span className="h-px w-10 bg-primary" />
                <p className="data-label text-primary">
                  Live hostile signal observatory
                </p>
              </div>
              <h1 className="font-heading text-[clamp(3.5rem,8vw,8rem)] font-semibold uppercase leading-[.76] tracking-[-.045em]">
                Threat
                <span className="ml-[.16em] text-primary">field</span>
              </h1>
              <p className="mt-6 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
                Port 22 is exposed. Every credential, source fingerprint, and
                shell instruction is being observed in real time.
              </p>
            </div>
            <div>
              <p className="data-label mb-2 text-right">Observation window</p>
              <div className="flex rounded-sm border border-white/[.08] bg-black/25 p-1">
                {ranges.map((item) => (
                  <Button
                    className="h-8 flex-1 rounded-[2px] px-4 font-mono text-[10px] uppercase tracking-[.12em] sm:flex-none"
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
          </div>
        </section>

        <BeeconJoinBanner
          busyId={beeconBusyId}
          onApprove={(id) => void runBeeconAction(approve, id)}
          onDeny={(id) => void runBeeconAction(remove, id)}
          pending={pendingBeecons}
        />

        <section className="reveal reveal-delay-1 mb-12">
          <SectionHeading
            detail="Temporal density / live pressure"
            index="A / SIGNAL"
            title="Attack telemetry"
          />
          <div className="grid gap-3 xl:grid-cols-[.8fr_1.7fr]">
            <Card className="glass-card instrument-card cyan-instrument min-w-0 border-white/[.07]">
              <CardHeader className="grid-cols-[1fr_auto] items-center border-b border-white/[.06] pb-4">
                <div>
                  <span className="data-label">Immediate pressure</span>
                  <CardTitle className="mt-1 font-heading text-xl uppercase tracking-wide">
                    Live intensity
                  </CardTitle>
                </div>
                <Crosshair className="size-4 text-secondary" />
              </CardHeader>
              <CardContent className="flex h-full flex-col px-2 pb-3 pt-1">
                <AttackGauge data={data} />
                <div className="mt-auto grid grid-cols-3 divide-x divide-white/[.06] border-t border-white/[.06] px-2 pt-3">
                  <GaugeStat
                    icon={Activity}
                    label="1h peak / min"
                    value={`${data.gaugeMaximum}/m`}
                  />
                  <GaugeStat
                    icon={
                      delta > 0 ? TrendingUp : delta < 0 ? TrendingDown : Minus
                    }
                    label="vs prev min"
                    tone={
                      delta > 0
                        ? "text-[#ff8f6b]"
                        : delta < 0
                          ? "text-emerald-300"
                          : "text-muted-foreground"
                    }
                    value={`${delta >= 0 ? "+" : ""}${delta}`}
                  />
                  <GaugeStat
                    icon={ShieldAlert}
                    label={`${range} total`}
                    value={COMPACT_COUNTS.format(data.totalAttacks)}
                  />
                </div>
              </CardContent>
            </Card>
            <Card className="glass-card instrument-card min-w-0 border-white/[.07]">
              <CardHeader className="grid-cols-[1fr_auto] items-center border-b border-white/[.06] pb-4">
                <div>
                  <span className="data-label">Historical ingress</span>
                  <CardTitle className="mt-1 font-heading text-xl uppercase tracking-wide">
                    Attack volume
                  </CardTitle>
                </div>
                <Activity className="size-4 text-primary" />
              </CardHeader>
              <CardContent className="px-2 pb-2 sm:px-4">
                <AttackTrend data={data} />
              </CardContent>
            </Card>
          </div>
        </section>

        <section className="reveal reveal-delay-2 mb-12 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            index="01 / RATE"
            detail={`${delta >= 0 ? "+" : ""}${delta} vs previous minute`}
            icon={Activity}
            label="Current attack rate"
            value={`${data.currentRate}/m`}
          />
          <MetricCard
            index="02 / VOLUME"
            detail={`During the selected ${range} window`}
            icon={ShieldAlert}
            label="Observed attacks"
            value={data.totalAttacks.toLocaleString()}
          />
          <MetricCard
            accent="cyan"
            index="03 / ORIGIN"
            detail="Distinct sources in top rankings"
            icon={Globe2}
            label="Tracked sources"
            value={data.topIps.length}
          />
          <MetricCard
            accent="cyan"
            index="04 / UPLINK"
            detail={uplinkDetail}
            icon={Radio}
            label="Telemetry status"
            value={uplinkValue}
          />
        </section>

        <section className="reveal reveal-delay-2 mb-12">
          <SectionHeading
            detail={`${data.mapAttacks.length} geolocated signals`}
            index="B / TERRAIN"
            title="Global attack origin"
          />
          <Card className="glass-card relative min-w-0 overflow-hidden border-white/[.07]">
            <div className="pointer-events-none absolute left-5 top-5 z-10 hidden border-l border-primary/40 pl-3 sm:block">
              <span className="data-label block text-primary">Live map</span>
              <span className="mt-1 block font-mono text-[10px] text-muted-foreground">
                Drag to pan / scroll to zoom
              </span>
            </div>
            <div className="pointer-events-none absolute bottom-4 left-5 z-10 flex items-center gap-4 border-l border-secondary/40 pl-3">
              <span className="data-label flex items-center gap-1.5">
                <svg
                  aria-hidden
                  className="size-2.5 fill-emerald-400 drop-shadow-[0_0_3px_rgba(52,211,153,.8)]"
                  viewBox="0 0 10 9"
                >
                  <path d="M5 0 10 9H0Z" />
                </svg>
                Tower / beecon
              </span>
              <span className="data-label flex items-center gap-1.5">
                <span className="size-2 rounded-full bg-primary shadow-[0_0_6px_rgba(255,194,71,.8)]" />
                Attack origin
              </span>
              {data.mapSignals.length > 0 ? (
                <span className="data-label flex items-center gap-1.5">
                  <span className="size-2 rounded-full bg-secondary/80 shadow-[0_0_6px_rgba(98,200,220,.8)]" />
                  Recon source
                </span>
              ) : null}
            </div>
            <CardContent className="px-0 pb-0">
              <AttackMap data={data} />
            </CardContent>
          </Card>
        </section>

        <section className="reveal reveal-delay-3 mb-12">
          <SectionHeading
            detail={`${COMPACT_COUNTS.format(
              data.signalTrend.reduce((sum, point) => sum + point.count, 0),
            )} signals across selected ${range} window`}
            index="C / RECON"
            title="Recon activity"
          />
          <div className="grid gap-3 xl:grid-cols-3">
            <ReconShell index="C.1" tag="Most probed" title="Targeted ports">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-5 text-[10px] uppercase tracking-[.14em] text-muted-foreground">
                      Port
                    </TableHead>
                    <TableHead className="text-right text-[10px] uppercase tracking-[.14em] text-muted-foreground">
                      Probes
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.topTargetedPorts.length ? (
                    data.topTargetedPorts.map((port) => (
                      <TableRow key={port.port} className="border-white/[.05]">
                        <TableCell className="pl-5 font-mono text-xs text-secondary">
                          {port.port}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs text-primary">
                          {port.count}
                        </TableCell>
                      </TableRow>
                    ))
                  ) : (
                    <TableRow>
                      <TableCell
                        className="h-16 text-center text-muted-foreground"
                        colSpan={2}
                      >
                        No port probes captured
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </ReconShell>
            <ReconShell index="C.2" tag="Raw requests" title="HTTP probes">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-5 text-[10px] uppercase tracking-[.14em] text-muted-foreground">
                      Path
                    </TableHead>
                    <TableHead className="text-[10px] uppercase tracking-[.14em] text-muted-foreground">
                      Source
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.recentHttp.length ? (
                    data.recentHttp.map((probe, index) => (
                      <TableRow
                        key={`${probe.occurredAt}-${probe.sourceIp}-${index}`}
                        className="border-white/[.05]"
                      >
                        <TableCell
                          className="max-w-[12rem] truncate pl-5 font-mono text-xs text-secondary"
                          title={probe.path}
                        >
                          {probe.path || "/"}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {probe.sourceIp}
                        </TableCell>
                      </TableRow>
                    ))
                  ) : (
                    <TableRow>
                      <TableCell
                        className="h-16 text-center text-muted-foreground"
                        colSpan={2}
                      >
                        No HTTP probes captured
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </ReconShell>
            <ReconShell index="C.3" tag="Loudest sources" title="Top scanners">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-5 text-[10px] uppercase tracking-[.14em] text-muted-foreground">
                      Source
                    </TableHead>
                    <TableHead className="text-right text-[10px] uppercase tracking-[.14em] text-muted-foreground">
                      Signals
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.topScannerIps.length ? (
                    data.topScannerIps.map((scanner) => (
                      <TableRow
                        key={scanner.value}
                        className="border-white/[.05]"
                      >
                        <TableCell className="pl-5 font-mono text-xs text-secondary">
                          {scanner.value}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs text-primary">
                          {scanner.count}
                        </TableCell>
                      </TableRow>
                    ))
                  ) : (
                    <TableRow>
                      <TableCell
                        className="h-16 text-center text-muted-foreground"
                        colSpan={2}
                      >
                        No scanners captured
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </ReconShell>
          </div>
        </section>

        <section className="reveal reveal-delay-3 mb-12">
          <SectionHeading
            detail={`Ranked across selected ${range} window`}
            index="D / PATTERNS"
            title="Credential intelligence"
          />
          <div className="grid gap-3 xl:grid-cols-3">
            <RankTable
              index="D.1"
              mono
              title="Source addresses"
              values={data.topIps}
            />
            <RankTable
              index="D.2"
              title="Usernames"
              values={data.topUsernames}
            />
            <RankTable
              index="D.3"
              mono
              title="Passwords"
              values={data.topPasswords}
            />
          </div>
        </section>

        <section className="mb-12">
          <SectionHeading
            detail="Accepted emulation sessions"
            index="E / SHELL"
            title="Command stream"
          />
          <Card className="glass-card instrument-card cyan-instrument min-w-0 border-white/[.07]">
            <CardHeader className="grid-cols-[1fr_auto] items-center border-b border-white/[.06] pb-4">
              <CardTitle className="flex items-center gap-2 font-heading text-base">
                <TerminalSquare className="size-4 text-secondary" />
                Commands
              </CardTitle>
              <Badge
                className="rounded-sm font-mono text-[10px]"
                variant="outline"
              >
                {data.recentCommands.length} captured
              </Badge>
            </CardHeader>
            <CardContent className="overflow-x-auto px-0">
              <Table className="min-w-[700px]">
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-6">Time</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Username</TableHead>
                    <TableHead>Command</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.recentCommands.length ? (
                    data.recentCommands.map((command) => (
                      <TableRow key={command.id}>
                        <TableCell className="pl-6 font-mono text-xs text-muted-foreground">
                          {new Date(command.occurredAt).toLocaleString()}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-primary">
                          {command.sourceIp}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {command.username || "Unknown"}
                        </TableCell>
                        <TableCell
                          className="max-w-xl whitespace-normal break-all font-mono text-xs text-secondary"
                          title={command.command}
                        >
                          <span className="line-clamp-3">
                            {command.command}
                          </span>
                        </TableCell>
                      </TableRow>
                    ))
                  ) : (
                    <TableRow>
                      <TableCell
                        className="h-28 text-center text-muted-foreground"
                        colSpan={4}
                      >
                        Commands entered in emulated shells appear here.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </section>

        <section>
          <SectionHeading
            detail="Raw credential and fingerprint feed"
            index="F / EVENTS"
            title="Recent attacks"
          />
          <Card className="glass-card instrument-card min-w-0 border-white/[.07]">
            <CardHeader className="grid-cols-[1fr_auto] items-center border-b border-white/[.06] pb-4">
              <div>
                <span className="data-label">Unfiltered observations</span>
                <CardTitle className="mt-1 font-heading text-xl uppercase tracking-wide">
                  20 most recent attacks
                </CardTitle>
              </div>
              <Database className="size-4 text-primary" />
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
        </section>

        <section className="reveal mb-12">
          <SectionHeading
            detail={
              fleet
                ? `${liveBeecons(fleet).length} of ${fleet.length} beecons online`
                : "Fleet telemetry"
            }
            index="G / FLEET"
            title="Beecon fleet"
          />
          <BeeconTable
            beecons={fleet}
            busyId={beeconBusyId}
            error={beeconError}
            onApprove={(id) => void runBeeconAction(approve, id)}
            onRemove={(id) => void runBeeconAction(remove, id)}
          />
        </section>

        <footer className="mt-12 flex flex-col gap-3 border-t border-white/[.07] py-6 text-[10px] uppercase tracking-[.14em] text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <span>Honey Spire / passive SSH observation node</span>
          <span>Geolocation intelligence by GeoLite2</span>
        </footer>
      </div>
    </main>
  );
}

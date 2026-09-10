"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Radio, Radar } from "lucide-react";
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
import type { SensorSummary } from "@/lib/types";

export function sensorLabel(sensor: SensorSummary) {
  return sensor.id === "local" ? "This server (built-in)" : sensor.name;
}

/** Build refs injected into the shipper image — noise rather than a release version. */
const GENERIC_VERSIONS = new Set(["main", "master", "dev"]);

function isRealVersion(version: string | null) {
  return version !== null && !GENERIC_VERSIONS.has(version);
}

/** When the sensor joined the hive: on approval, or creation for built-in. */
export function joinedAt(sensor: SensorSummary) {
  return sensor.approvedAt ?? sensor.createdAt;
}

export function formatJoined(timestamp: number) {
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function liveSensors(sensors: SensorSummary[] | null) {
  return (sensors ?? []).filter((sensor) => sensor.online);
}

export function useSensors(range: string, refreshSignal: number) {
  const router = useRouter();
  const [sensors, setSensors] = useState<SensorSummary[] | null>(null);
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    try {
      const response = await fetch(`/api/sensors?range=${range}`, {
        cache: "no-store",
      });
      if (response.status === 401) {
        router.replace("/login");
        router.refresh();
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { sensors: SensorSummary[] };
      setSensors(body.sensors);
      setError("");
    } catch {
      setError("Could not load the sensor fleet.");
    }
  }, [range, router]);

  useEffect(() => {
    const initial = setTimeout(() => void reload(), 0);
    const interval = setInterval(() => void reload(), 30_000);
    return () => {
      clearTimeout(initial);
      clearInterval(interval);
    };
  }, [reload, refreshSignal]);

  const approve = useCallback(
    async (id: string) => {
      const response = await fetch(`/api/sensors/${id}/approve`, {
        method: "POST",
      });
      if (response.ok) {
        void reload();
        return true;
      }
      return false;
    },
    [reload],
  );

  const remove = useCallback(
    async (id: string) => {
      const response = await fetch(`/api/sensors/${id}`, { method: "DELETE" });
      if (response.ok) {
        void reload();
        return true;
      }
      return false;
    },
    [reload],
  );

  const pending = (sensors ?? []).filter(
    (sensor) => sensor.status === "pending",
  );
  return { sensors, pending, error, approve, remove };
}

export function SensorJoinBanner({
  pending,
  busyId,
  onApprove,
  onDeny,
}: {
  pending: SensorSummary[];
  busyId: string | null;
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
}) {
  if (!pending.length) return null;
  return (
    <section className="reveal reveal-delay-1 mb-10 space-y-2">
      {pending.map((sensor) => (
        <div
          className="glass-card flex flex-col gap-3 border-primary/25 bg-primary/[.05] px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
          key={sensor.id}
        >
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Radio className="size-4 animate-pulse text-primary" />
            <p className="text-sm">
              <span className="font-semibold text-primary">
                Sensor {sensor.name}
              </span>{" "}
              wants to join this hive
            </p>
            <span className="data-label">
              first seen {formatJoined(sensor.createdAt)}
            </span>
          </div>
          <div className="flex gap-2">
            <Button
              disabled={busyId === sensor.id}
              onClick={() => onApprove(sensor.id)}
              size="sm"
            >
              Approve
            </Button>
            <Button
              disabled={busyId === sensor.id}
              onClick={() => onDeny(sensor.id)}
              size="sm"
              variant="outline"
            >
              Deny
            </Button>
          </div>
        </div>
      ))}
    </section>
  );
}

function StatusBadge({ sensor }: { sensor: SensorSummary }) {
  if (sensor.status === "pending") {
    return (
      <Badge
        className="h-6 animate-pulse rounded-sm border-primary/30 bg-primary/[.08] font-mono text-[10px] uppercase tracking-[.12em] text-primary"
        variant="outline"
      >
        Awaiting approval
      </Badge>
    );
  }
  if (sensor.status === "revoked") {
    return (
      <Badge
        className="h-6 rounded-sm border-white/10 bg-white/5 font-mono text-[10px] uppercase tracking-[.12em] text-muted-foreground line-through"
        variant="outline"
      >
        Removed
      </Badge>
    );
  }
  return sensor.online ? (
    <Badge
      className="h-6 rounded-sm border-emerald-400/20 bg-emerald-400/[.08] font-mono text-[10px] uppercase tracking-[.12em] text-emerald-300"
      variant="outline"
    >
      Online
    </Badge>
  ) : (
    <Badge
      className="h-6 rounded-sm border-white/10 bg-white/5 font-mono text-[10px] uppercase tracking-[.12em] text-muted-foreground"
      variant="outline"
    >
      Offline
    </Badge>
  );
}

export function SensorTable({
  sensors,
  error,
  busyId,
  onApprove,
  onRemove,
}: {
  sensors: SensorSummary[] | null;
  error: string;
  busyId: string | null;
  onApprove: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  return (
    <Card className="glass-card instrument-card min-w-0 border-white/[.07]">
      <CardHeader className="grid-cols-[1fr_auto] items-center border-b border-white/[.06] pb-4">
        <div>
          <span className="data-label">
            Remote sensors reporting to this hive
          </span>
          <CardTitle className="mt-1 flex items-center gap-2 font-heading text-xl uppercase tracking-wide">
            <Radar className="size-4 text-primary" />
            Sensor fleet
          </CardTitle>
        </div>
        <Badge className="rounded-sm font-mono text-[10px]" variant="outline">
          {sensors
            ? `${liveSensors(sensors).length}/${sensors.length} live`
            : "—"}
        </Badge>
      </CardHeader>
      <CardContent className="overflow-x-auto px-0">
        {error ? (
          <p className="px-6 py-6 text-sm text-muted-foreground">{error}</p>
        ) : (
          <Table className="min-w-[760px]">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">Sensor</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Joined</TableHead>
                <TableHead className="text-right">Attacks</TableHead>
                <TableHead className="text-right">Commands</TableHead>
                <TableHead>Last seen</TableHead>
                <TableHead className="pr-6 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sensors?.length ? (
                sensors.map((sensor) => (
                  <TableRow key={sensor.id} className="border-white/[.05]">
                    <TableCell className="pl-6">
                      <span className="text-sm">{sensorLabel(sensor)}</span>
                      {isRealVersion(sensor.version) ? (
                        <span className="ml-2 font-mono text-[10px] text-muted-foreground">
                          v{sensor.version}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <StatusBadge sensor={sensor} />
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {formatJoined(joinedAt(sensor))}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs text-primary">
                      {sensor.attacks.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {sensor.commands.toLocaleString()}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {sensor.lastSeenAt
                        ? new Date(sensor.lastSeenAt).toLocaleString()
                        : "Never"}
                    </TableCell>
                    <TableCell className="pr-6 text-right">
                      {sensor.status === "pending" ? (
                        <div className="flex justify-end gap-2">
                          <Button
                            disabled={busyId === sensor.id}
                            onClick={() => onApprove(sensor.id)}
                            size="sm"
                          >
                            Approve
                          </Button>
                          <Button
                            disabled={busyId === sensor.id}
                            onClick={() => onRemove(sensor.id)}
                            size="sm"
                            variant="outline"
                          >
                            Deny
                          </Button>
                        </div>
                      ) : sensor.status === "active" &&
                        sensor.id !== "local" ? (
                        confirmingId === sensor.id ? (
                          <div className="flex items-center justify-end gap-2">
                            <span className="text-xs text-muted-foreground">
                              Remove?
                            </span>
                            <Button
                              disabled={busyId === sensor.id}
                              onClick={() => {
                                setConfirmingId(null);
                                onRemove(sensor.id);
                              }}
                              size="sm"
                              variant="destructive"
                            >
                              Yes
                            </Button>
                            <Button
                              onClick={() => setConfirmingId(null)}
                              size="sm"
                              variant="ghost"
                            >
                              No
                            </Button>
                          </div>
                        ) : (
                          <Button
                            onClick={() => setConfirmingId(sensor.id)}
                            size="sm"
                            variant="outline"
                          >
                            Remove
                          </Button>
                        )
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell
                    className="h-24 text-center text-muted-foreground"
                    colSpan={7}
                  >
                    {sensors
                      ? "No sensors yet. Run the installer on a sensor and choose SENSOR."
                      : "Loading the fleet…"}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

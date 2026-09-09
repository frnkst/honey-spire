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
import type { BeeconSummary } from "@/lib/types";

export function beeconLabel(beecon: BeeconSummary) {
  return beecon.id === "local" ? "This server (built-in)" : beecon.name;
}

/** When the beecon joined the tower: on approval, or creation for built-in. */
export function joinedAt(beecon: BeeconSummary) {
  return beecon.approvedAt ?? beecon.createdAt;
}

export function formatJoined(timestamp: number) {
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function liveBeecons(beecons: BeeconSummary[] | null) {
  return (beecons ?? []).filter((beecon) => beecon.online);
}

export function useBeecons(range: string, refreshSignal: number) {
  const router = useRouter();
  const [beecons, setBeecons] = useState<BeeconSummary[] | null>(null);
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    try {
      const response = await fetch(`/api/beecons?range=${range}`, {
        cache: "no-store",
      });
      if (response.status === 401) {
        router.replace("/login");
        router.refresh();
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { beecons: BeeconSummary[] };
      setBeecons(body.beecons);
      setError("");
    } catch {
      setError("Could not load the beecon fleet.");
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
      const response = await fetch(`/api/beecons/${id}/approve`, {
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
      const response = await fetch(`/api/beecons/${id}`, { method: "DELETE" });
      if (response.ok) {
        void reload();
        return true;
      }
      return false;
    },
    [reload],
  );

  const pending = (beecons ?? []).filter(
    (beecon) => beecon.status === "pending",
  );
  return { beecons, pending, error, approve, remove };
}

/** The header status pill: live state plus which beecons are reporting. */
export function LiveRosterBadge({
  connected,
  beecons,
}: {
  connected: boolean;
  beecons: BeeconSummary[] | null;
}) {
  const roster = liveBeecons(beecons).map(
    (beecon) => `${beeconLabel(beecon)} (since ${formatJoined(joinedAt(beecon))})`,
  );
  const shown = roster.slice(0, 3);
  const hidden = roster.length - shown.length;
  const label = !connected
    ? "Reconnecting"
    : roster.length === 0
      ? "Live"
      : `Live · ${shown.join(" · ")}${hidden > 0 ? ` +${hidden}` : ""}`;

  return (
    <Badge
      className={
        connected
          ? "h-7 rounded-sm border-emerald-400/20 bg-emerald-400/[.08] px-2.5 font-mono text-[10px] uppercase tracking-[.12em] text-emerald-300"
          : "h-7 rounded-sm border-white/10 bg-white/5 px-2.5 font-mono text-[10px] uppercase tracking-[.12em] text-muted-foreground"
      }
      title={roster.length ? roster.join("\n") : undefined}
      variant="outline"
    >
      <Radio className={connected ? "animate-pulse" : ""} />
      <span className="max-w-[52vw] truncate sm:max-w-[420px]">{label}</span>
    </Badge>
  );
}

export function BeeconJoinBanner({
  pending,
  busyId,
  onApprove,
  onDeny,
}: {
  pending: BeeconSummary[];
  busyId: string | null;
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
}) {
  if (!pending.length) return null;
  return (
    <section className="reveal reveal-delay-1 mb-10 space-y-2">
      {pending.map((beecon) => (
        <div
          className="glass-card flex flex-col gap-3 border-primary/25 bg-primary/[.05] px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
          key={beecon.id}
        >
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Radio className="size-4 animate-pulse text-primary" />
            <p className="text-sm">
              <span className="font-semibold text-primary">
                Beecon {beecon.name}
              </span>{" "}
              wants to join this tower
            </p>
            <span className="data-label">
              first seen {formatJoined(beecon.createdAt)}
            </span>
          </div>
          <div className="flex gap-2">
            <Button
              disabled={busyId === beecon.id}
              onClick={() => onApprove(beecon.id)}
              size="sm"
            >
              Approve
            </Button>
            <Button
              disabled={busyId === beecon.id}
              onClick={() => onDeny(beecon.id)}
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

function StatusBadge({ beecon }: { beecon: BeeconSummary }) {
  if (beecon.status === "pending") {
    return (
      <Badge
        className="h-6 animate-pulse rounded-sm border-primary/30 bg-primary/[.08] font-mono text-[10px] uppercase tracking-[.12em] text-primary"
        variant="outline"
      >
        Awaiting approval
      </Badge>
    );
  }
  if (beecon.status === "revoked") {
    return (
      <Badge
        className="h-6 rounded-sm border-white/10 bg-white/5 font-mono text-[10px] uppercase tracking-[.12em] text-muted-foreground line-through"
        variant="outline"
      >
        Removed
      </Badge>
    );
  }
  return beecon.online ? (
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

export function BeeconTable({
  beecons,
  error,
  busyId,
  onApprove,
  onRemove,
}: {
  beecons: BeeconSummary[] | null;
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
          <span className="data-label">Remote sensors reporting to this tower</span>
          <CardTitle className="mt-1 flex items-center gap-2 font-heading text-xl uppercase tracking-wide">
            <Radar className="size-4 text-primary" />
            Beecon fleet
          </CardTitle>
        </div>
        <Badge className="rounded-sm font-mono text-[10px]" variant="outline">
          {beecons ? `${liveBeecons(beecons).length}/${beecons.length} live` : "—"}
        </Badge>
      </CardHeader>
      <CardContent className="overflow-x-auto px-0">
        {error ? (
          <p className="px-6 py-6 text-sm text-muted-foreground">{error}</p>
        ) : (
          <Table className="min-w-[760px]">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">Beecon</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Joined</TableHead>
                <TableHead className="text-right">Attacks</TableHead>
                <TableHead className="text-right">Commands</TableHead>
                <TableHead>Last seen</TableHead>
                <TableHead className="pr-6 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {beecons?.length ? (
                beecons.map((beecon) => (
                  <TableRow key={beecon.id} className="border-white/[.05]">
                    <TableCell className="pl-6">
                      <span className="text-sm">{beeconLabel(beecon)}</span>
                      {beecon.version ? (
                        <span className="ml-2 font-mono text-[10px] text-muted-foreground">
                          v{beecon.version}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <StatusBadge beecon={beecon} />
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {formatJoined(joinedAt(beecon))}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs text-primary">
                      {beecon.attacks.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {beecon.commands.toLocaleString()}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {beecon.lastSeenAt
                        ? new Date(beecon.lastSeenAt).toLocaleString()
                        : "Never"}
                    </TableCell>
                    <TableCell className="pr-6 text-right">
                      {beecon.status === "pending" ? (
                        <div className="flex justify-end gap-2">
                          <Button
                            disabled={busyId === beecon.id}
                            onClick={() => onApprove(beecon.id)}
                            size="sm"
                          >
                            Approve
                          </Button>
                          <Button
                            disabled={busyId === beecon.id}
                            onClick={() => onRemove(beecon.id)}
                            size="sm"
                            variant="outline"
                          >
                            Deny
                          </Button>
                        </div>
                      ) : beecon.status === "active" && beecon.id !== "local" ? (
                        confirmingId === beecon.id ? (
                          <div className="flex items-center justify-end gap-2">
                            <span className="text-xs text-muted-foreground">
                              Remove?
                            </span>
                            <Button
                              disabled={busyId === beecon.id}
                              onClick={() => {
                                setConfirmingId(null);
                                onRemove(beecon.id);
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
                            onClick={() => setConfirmingId(beecon.id)}
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
                    {beecons
                      ? "No beecons yet. Run the installer on a sensor and choose BEECON."
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

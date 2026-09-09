import { createHash, randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";
import { getBeeconSummaries, getDatabase } from "@/lib/db";
import { geolocateIp } from "@/lib/geolocation";
import type { BeeconStatus, BeeconSummary, MapSensor } from "@/lib/types";

export const LOCAL_BEECON_ID = "local";
export const BEECON_OFFLINE_AFTER_MS = 15 * 60_000;
export const MAX_PENDING_BEECONS = 25;

export interface BeeconRow {
  id: string;
  name: string;
  token_hash: string | null;
  status: BeeconStatus;
  version: string | null;
  created_at: number;
  approved_at: number | null;
  revoked_at: number | null;
  last_seen_at: number | null;
  last_seen_ip: string | null;
  events_received: number;
}

export class BeeconLimitError extends Error {
  constructor() {
    super("Too many pending beecons.");
    this.name = "BeeconLimitError";
  }
}

export type BeeconAuthResult =
  | { ok: true; beecon: BeeconRow }
  | {
      ok: false;
      status: 401 | 403;
      code: "missing_token" | "unknown_token" | "pending" | "revoked";
      error: string;
    };

export function hashToken(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateBeeconId() {
  return `bc_${randomBytes(6).toString("hex")}`;
}

export interface JoinInput {
  name: string;
  token: string;
  version?: string;
  ip: string;
}

/**
 * Joins a beecon by bearer token. Idempotent: re-joining with the same token
 * refreshes the display name, advertised version, and last-seen marker.
 */
export function registerJoin({ name, token, version, ip }: JoinInput): {
  status: BeeconStatus;
  beeconId: string;
} {
  const db = getDatabase();
  const tokenHash = hashToken(token);
  const now = Date.now();
  const existing = db
    .prepare(`SELECT id, status FROM beecons WHERE token_hash = ?`)
    .get(tokenHash) as { id: string; status: BeeconStatus } | undefined;
  if (existing) {
    if (existing.status === "revoked") {
      return { status: "revoked", beeconId: existing.id };
    }
    db.prepare(
      `UPDATE beecons
       SET name = ?, version = COALESCE(?, version),
           last_seen_at = ?, last_seen_ip = ?
       WHERE id = ?`,
    ).run(name, version ?? null, now, ip, existing.id);
    return {
      status: existing.status === "active" ? "active" : "pending",
      beeconId: existing.id,
    };
  }

  const pending = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM beecons WHERE status = 'pending'`,
        )
        .get() as { count: number } | undefined
    )?.count ?? 0,
  );
  if (pending >= MAX_PENDING_BEECONS) throw new BeeconLimitError();

  const beeconId = generateBeeconId();
  db.prepare(
    `INSERT INTO beecons
      (id, name, token_hash, status, version, created_at, last_seen_at, last_seen_ip)
     VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`,
  ).run(beeconId, name, tokenHash, version ?? null, now, now, ip);
  return { status: "pending", beeconId };
}

export function approveBeecon(id: string) {
  return (
    getDatabase()
      .prepare(
        `UPDATE beecons SET status = 'active', approved_at = ?, revoked_at = NULL
         WHERE id = ? AND status = 'pending'`,
      )
      .run(Date.now(), id).changes > 0
  );
}

export function revokeBeecon(id: string) {
  if (id === LOCAL_BEECON_ID) return false;
  return (
    getDatabase()
      .prepare(
        `UPDATE beecons SET status = 'revoked', revoked_at = ?
         WHERE id = ? AND status != 'revoked'`,
      )
      .run(Date.now(), id).changes > 0
  );
}

export function touchBeecon(id: string, ip: string, events: number) {
  getDatabase()
    .prepare(
      `UPDATE beecons
       SET last_seen_at = ?, last_seen_ip = ?, events_received = events_received + ?
       WHERE id = ?`,
    )
    .run(Date.now(), ip, events, id);
}

function withOnline(summary: Omit<BeeconSummary, "online">): BeeconSummary {
  return {
    ...summary,
    online:
      summary.status === "active" &&
      summary.lastSeenAt !== null &&
      Date.now() - summary.lastSeenAt < BEECON_OFFLINE_AFTER_MS,
  };
}

export function getBeeconSummary(id: string): BeeconSummary | undefined {
  const summary = getBeeconSummaries(0).find((beecon) => beecon.id === id);
  return summary ? withOnline(summary) : undefined;
}

export function listBeecons(since = 0): BeeconSummary[] {
  return getBeeconSummaries(since).map(withOnline);
}

/**
 * Geolocates every active sensor's last-seen IP so the dashboard map can plot
 * the tower and its beecons. Sensors without a usable location are omitted.
 */
export async function getMapSensors(): Promise<MapSensor[]> {
  const sensors = await Promise.all(
    getBeeconSummaries(0)
      .map(withOnline)
      .filter((beecon) => beecon.status === "active" && beecon.lastSeenIp)
      .map(async (beecon): Promise<MapSensor | null> => {
        const geo = await geolocateIp(beecon.lastSeenIp as string);
        if (geo.latitude === null || geo.longitude === null) return null;
        return {
          id: beecon.id,
          name: beecon.name,
          local: beecon.id === LOCAL_BEECON_ID,
          online: beecon.online,
          latitude: geo.latitude,
          longitude: geo.longitude,
          location:
            [geo.city, geo.countryCode].filter(Boolean).join(", ") || null,
        };
      }),
  );
  return sensors.filter((sensor): sensor is MapSensor => sensor !== null);
}

/**
 * Authenticates a beecon via `Authorization: Bearer <token>`. The token is
 * generated by the beecon at install time and stored hashed on the tower.
 */
export function authenticateBeecon(request: NextRequest): BeeconAuthResult {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match) {
    return {
      ok: false,
      status: 401,
      code: "missing_token",
      error: "Missing bearer token.",
    };
  }
  const beecon = getDatabase()
    .prepare(`SELECT * FROM beecons WHERE token_hash = ?`)
    .get(hashToken(match[1])) as BeeconRow | undefined;
  if (!beecon) {
    return {
      ok: false,
      status: 401,
      code: "unknown_token",
      error: "Unknown beecon token.",
    };
  }
  if (beecon.status === "pending") {
    return {
      ok: false,
      status: 403,
      code: "pending",
      error: "Beecon is awaiting approval.",
    };
  }
  if (beecon.status === "revoked") {
    return {
      ok: false,
      status: 403,
      code: "revoked",
      error: "Beecon has been removed.",
    };
  }
  return { ok: true, beecon };
}

import { createHash, randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";
import { getSensorSummaries, getDatabase } from "@/lib/db";
import { geolocateIp } from "@/lib/geolocation";
import type { SensorStatus, SensorSummary, MapSensor } from "@/lib/types";

export const LOCAL_SENSOR_ID = "local";
export const SENSOR_OFFLINE_AFTER_MS = 15 * 60_000;
export const MAX_PENDING_SENSORS = 25;

export interface SensorRow {
  id: string;
  name: string;
  token_hash: string | null;
  status: SensorStatus;
  version: string | null;
  created_at: number;
  approved_at: number | null;
  revoked_at: number | null;
  last_seen_at: number | null;
  last_seen_ip: string | null;
  events_received: number;
}

export class SensorLimitError extends Error {
  constructor() {
    super("Too many pending sensors.");
    this.name = "SensorLimitError";
  }
}

export type SensorAuthResult =
  | { ok: true; sensor: SensorRow }
  | {
      ok: false;
      status: 401 | 403;
      code: "missing_token" | "unknown_token" | "pending" | "revoked";
      error: string;
    };

export function hashToken(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateSensorId() {
  return `sns_${randomBytes(6).toString("hex")}`;
}

export interface JoinInput {
  name: string;
  token: string;
  version?: string;
  ip: string;
}

/**
 * Joins a sensor by bearer token. Idempotent: re-joining with the same token
 * refreshes the display name, advertised version, and last-seen marker.
 */
export function registerJoin({ name, token, version, ip }: JoinInput): {
  status: SensorStatus;
  sensorId: string;
} {
  const db = getDatabase();
  const tokenHash = hashToken(token);
  const now = Date.now();
  const existing = db
    .prepare(`SELECT id, status FROM sensors WHERE token_hash = ?`)
    .get(tokenHash) as { id: string; status: SensorStatus } | undefined;
  if (existing) {
    if (existing.status === "revoked") {
      return { status: "revoked", sensorId: existing.id };
    }
    db.prepare(
      `UPDATE sensors
       SET name = ?, version = COALESCE(?, version),
           last_seen_at = ?, last_seen_ip = ?
       WHERE id = ?`,
    ).run(name, version ?? null, now, ip, existing.id);
    return {
      status: existing.status === "active" ? "active" : "pending",
      sensorId: existing.id,
    };
  }

  const pending = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM sensors WHERE status = 'pending'`,
        )
        .get() as { count: number } | undefined
    )?.count ?? 0,
  );
  if (pending >= MAX_PENDING_SENSORS) throw new SensorLimitError();

  const sensorId = generateSensorId();
  db.prepare(
    `INSERT INTO sensors
      (id, name, token_hash, status, version, created_at, last_seen_at, last_seen_ip)
     VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`,
  ).run(sensorId, name, tokenHash, version ?? null, now, now, ip);
  return { status: "pending", sensorId };
}

export function approveSensor(id: string) {
  return (
    getDatabase()
      .prepare(
        `UPDATE sensors SET status = 'active', approved_at = ?, revoked_at = NULL
         WHERE id = ? AND status = 'pending'`,
      )
      .run(Date.now(), id).changes > 0
  );
}

export function revokeSensor(id: string) {
  if (id === LOCAL_SENSOR_ID) return false;
  return (
    getDatabase()
      .prepare(
        `UPDATE sensors SET status = 'revoked', revoked_at = ?
         WHERE id = ? AND status != 'revoked'`,
      )
      .run(Date.now(), id).changes > 0
  );
}

export function touchSensor(id: string, ip: string | null, events: number) {
  getDatabase()
    .prepare(
      `UPDATE sensors
       SET last_seen_at = ?,
           last_seen_ip = COALESCE(?, last_seen_ip),
           events_received = events_received + ?
       WHERE id = ?`,
    )
    .run(Date.now(), ip, events, id);
}

function withOnline(summary: Omit<SensorSummary, "online">): SensorSummary {
  return {
    ...summary,
    online:
      summary.status === "active" &&
      summary.lastSeenAt !== null &&
      Date.now() - summary.lastSeenAt < SENSOR_OFFLINE_AFTER_MS,
  };
}

export function getSensorSummary(id: string): SensorSummary | undefined {
  const summary = getSensorSummaries(0).find((sensor) => sensor.id === id);
  return summary ? withOnline(summary) : undefined;
}

export function listSensors(since = 0): SensorSummary[] {
  return getSensorSummaries(since).map(withOnline);
}

/**
 * Geolocates every active sensor's last-seen IP so the dashboard map can plot
 * the hive and its sensors. Sensors without a usable location are omitted.
 */
export async function getMapSensors(): Promise<MapSensor[]> {
  const sensors = await Promise.all(
    getSensorSummaries(0)
      .map(withOnline)
      .filter((sensor) => sensor.status === "active" && sensor.lastSeenIp)
      .map(async (sensor): Promise<MapSensor | null> => {
        const geo = await geolocateIp(sensor.lastSeenIp as string);
        if (geo.latitude === null || geo.longitude === null) return null;
        return {
          id: sensor.id,
          name: sensor.name,
          local: sensor.id === LOCAL_SENSOR_ID,
          online: sensor.online,
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
 * Authenticates a sensor via `Authorization: Bearer <token>`. The token is
 * generated by the sensor at install time and stored hashed on the hive.
 */
export function authenticateSensor(request: NextRequest): SensorAuthResult {
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
  const sensor = getDatabase()
    .prepare(`SELECT * FROM sensors WHERE token_hash = ?`)
    .get(hashToken(match[1])) as SensorRow | undefined;
  if (!sensor) {
    return {
      ok: false,
      status: 401,
      code: "unknown_token",
      error: "Unknown sensor token.",
    };
  }
  if (sensor.status === "pending") {
    return {
      ok: false,
      status: 403,
      code: "pending",
      error: "Sensor is awaiting approval.",
    };
  }
  if (sensor.status === "revoked") {
    return {
      ok: false,
      status: 403,
      code: "revoked",
      error: "Sensor has been removed.",
    };
  }
  return { ok: true, sensor };
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { NextRequest } from "next/server";
import {
  approveSensor,
  authenticateSensor,
  SensorLimitError,
  hashToken,
  listSensors,
  LOCAL_SENSOR_ID,
  MAX_PENDING_SENSORS,
  registerJoin,
  revokeSensor,
  touchSensor,
} from "@/lib/sensors";
import { getDatabase } from "@/lib/db";

function sensorRequest(token?: string) {
  return new Request("http://hive/api/ingest", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  }) as unknown as NextRequest;
}

beforeAll(() => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "neonhive-sensors-"));
  process.env.DATABASE_PATH = path.join(directory, "test.db");
  process.env.GEOLITE_DIR = path.join(directory, "geolite");
});

function makeSensor(name = "edge-sensor") {
  const token = randomBytes(32).toString("hex");
  return { token, join: () => registerJoin({ name, token, ip: "10.0.0.1" }) };
}

describe("database schema", () => {
  it("creates the sensors table and the built-in local sensor once", () => {
    getDatabase();
    getDatabase(); // second open must be a no-op
    const local = getDatabase()
      .prepare(`SELECT id, status FROM sensors WHERE id = 'local'`)
      .get() as { id: string; status: string } | undefined;
    expect(local).toMatchObject({ id: "local", status: "active" });
  });
});

describe("sensor lifecycle", () => {
  it("hashes tokens deterministically", () => {
    expect(hashToken("a")).toBe(hashToken("a"));
    expect(hashToken("a")).not.toBe(hashToken("b"));
  });

  it("joins a pending sensor and stays idempotent per token", () => {
    const { token, join } = makeSensor("display name");
    const first = join();
    expect(first.status).toBe("pending");
    expect(first.sensorId).toMatch(/^sns_[0-9a-f]{12}$/);

    const second = registerJoin({
      name: "renamed",
      token,
      version: "1.2.3",
      ip: "10.0.0.2",
    });
    expect(second).toEqual(first);
    const row = getDatabase()
      .prepare(`SELECT name, version, status FROM sensors WHERE id = ?`)
      .get(first.sensorId) as { name: string; version: string; status: string };
    expect(row).toMatchObject({ name: "renamed", version: "1.2.3" });
  });

  it("approves a pending sensor so its token authenticates", () => {
    const { token, join } = makeSensor();
    const { sensorId } = join();
    expect(approveSensor(sensorId)).toBe(true);
    expect(approveSensor(sensorId)).toBe(false); // already active

    const auth = authenticateSensor(sensorRequest(token));
    expect(auth).toMatchObject({ ok: true });
  });

  it("rejects unauthenticated and pending tokens", () => {
    const missing = authenticateSensor(sensorRequest());
    expect(missing).toMatchObject({ ok: false, status: 401 });

    const { token, join } = makeSensor(); // stays pending
    join();
    const pending = authenticateSensor(sensorRequest(token));
    expect(pending).toMatchObject({ ok: false, status: 403, code: "pending" });

    const unknown = authenticateSensor(sensorRequest("a".repeat(64)));
    expect(unknown).toMatchObject({
      ok: false,
      status: 401,
      code: "unknown_token",
    });
  });

  it("revokes sensors and blocks their tokens", () => {
    const { token, join } = makeSensor();
    const { sensorId } = join();
    expect(revokeSensor(sensorId)).toBe(true);
    expect(revokeSensor(sensorId)).toBe(false);

    const revoked = authenticateSensor(sensorRequest(token));
    expect(revoked).toMatchObject({ ok: false, status: 403, code: "revoked" });
    expect(registerJoin({ name: "zombie", token, ip: "10.0.0.3" })).toEqual({
      status: "revoked",
      sensorId,
    });
  });

  it("never approves or revokes the built-in local sensor", () => {
    expect(approveSensor(LOCAL_SENSOR_ID)).toBe(false);
    expect(revokeSensor(LOCAL_SENSOR_ID)).toBe(false);
  });

  it("derives the online flag from last_seen_at", () => {
    const { join } = makeSensor("heartbeat");
    const { sensorId } = join();
    approveSensor(sensorId);

    touchSensor(sensorId, "10.0.0.9", 3);
    const online = listSensors(0).find((b) => b.id === sensorId);
    expect(online).toMatchObject({ online: true, eventsReceived: 3 });

    getDatabase()
      .prepare(`UPDATE sensors SET last_seen_at = ? WHERE id = ?`)
      .run(Date.now() - 16 * 60_000, sensorId);
    const offline = listSensors(0).find((b) => b.id === sensorId);
    expect(offline?.online).toBe(false);
  });

  it("caps the number of pending sensors", () => {
    const pendingCount = () =>
      listSensors(0).filter((sensor) => sensor.status === "pending").length;
    for (let index = pendingCount(); index < MAX_PENDING_SENSORS; index += 1) {
      makeSensor().join();
    }
    expect(pendingCount()).toBe(MAX_PENDING_SENSORS);
    expect(() => makeSensor().join()).toThrow(SensorLimitError);
  });
});

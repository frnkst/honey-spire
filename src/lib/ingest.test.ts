import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { approveSensor, registerJoin } from "@/lib/sensors";
import { getDashboardData } from "@/lib/db";
import { ingestBatch, MAX_EVENT_BYTES } from "@/lib/ingest";

beforeAll(() => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "neonhive-ingest-"));
  process.env.DATABASE_PATH = path.join(directory, "test.db");
  process.env.GEOLITE_DIR = path.join(directory, "geolite");
});

function approvedSensor(name: string) {
  const token = randomBytes(32).toString("hex");
  const { sensorId } = registerJoin({ name, token, ip: "192.0.2.1" });
  approveSensor(sensorId);
  return sensorId;
}

function loginRecord(session: string) {
  return JSON.stringify({
    eventid: "cowrie.login.failed",
    session,
    timestamp: new Date().toISOString(),
    src_ip: "203.0.113.50",
    src_port: 40000,
    username: "root",
    password: "hunter2",
  });
}

describe("ingestBatch", () => {
  it("accepts valid events, skips bad ones, and tags the sensor", async () => {
    const sensorId = approvedSensor("edge-a");
    const result = await ingestBatch(
      sensorId,
      [
        // fingerprints arrive before the login, matching real Cowrie ordering
        '{"eventid":"cowrie.client.version","session":"100","version":"SSH-2.0-dropbear"}',
        loginRecord("100"),
        "not json at all",
        `{"eventid":"cowrie.command.input","session":"100","input":"id"}`,
        "x".repeat(MAX_EVENT_BYTES + 1),
      ],
      "192.0.2.1",
    );
    expect(result).toEqual({ accepted: 3, skipped: 2 });

    const sensorOnly = getDashboardData("1h", sensorId);
    expect(sensorOnly.totalAttacks).toBe(1);
    expect(sensorOnly.recentAttacks[0]).toMatchObject({
      sensorId,
      username: "root",
      clientVersion: "SSH-2.0-dropbear",
    });
    expect(sensorOnly.recentCommands[0]).toMatchObject({
      sensorId,
      command: "id",
    });
    expect(getDashboardData("1h", "local").totalAttacks).toBe(0);
  });

  it("namespaces session ids so equal cowrie sessions never collide", async () => {
    const a = approvedSensor("edge-a2");
    const b = approvedSensor("edge-b");
    await ingestBatch(a, [loginRecord("42")], "192.0.2.1");
    await ingestBatch(b, [loginRecord("42")], "192.0.2.2");

    expect(getDashboardData("1h", a).totalAttacks).toBe(1);
    expect(getDashboardData("1h", b).totalAttacks).toBe(1);
    // the first test in this file already stored one attack for edge-a
    expect(getDashboardData("1h").totalAttacks).toBe(3);
    expect(getDashboardData("1h", a).recentAttacks[0].sessionId).toMatch(
      new RegExp(`^${a}:42$`),
    );
  });

  it("accepts an empty batch as a heartbeat", async () => {
    const sensorId = approvedSensor("edge-c");
    const result = await ingestBatch(sensorId, [], "192.0.2.9");
    expect(result).toEqual({ accepted: 0, skipped: 0 });
  });
});

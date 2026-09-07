import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { approveBeecon, registerJoin } from "@/lib/beecons";
import { getDashboardData } from "@/lib/db";
import { ingestBatch, MAX_EVENT_BYTES } from "@/lib/ingest";

beforeAll(() => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "honey-spire-ingest-"));
  process.env.DATABASE_PATH = path.join(directory, "test.db");
  process.env.GEOLITE_DIR = path.join(directory, "geolite");
});

function approvedBeecon(name: string) {
  const token = randomBytes(32).toString("hex");
  const { beeconId } = registerJoin({ name, token, ip: "192.0.2.1" });
  approveBeecon(beeconId);
  return beeconId;
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
  it("accepts valid events, skips bad ones, and tags the beecon", async () => {
    const beeconId = approvedBeecon("edge-a");
    const result = await ingestBatch(
      beeconId,
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

    const beeconOnly = getDashboardData("1h", beeconId);
    expect(beeconOnly.totalAttacks).toBe(1);
    expect(beeconOnly.recentAttacks[0]).toMatchObject({
      beeconId,
      username: "root",
      clientVersion: "SSH-2.0-dropbear",
    });
    expect(beeconOnly.recentCommands[0]).toMatchObject({
      beeconId,
      command: "id",
    });
    expect(getDashboardData("1h", "local").totalAttacks).toBe(0);
  });

  it("namespaces session ids so equal cowrie sessions never collide", async () => {
    const a = approvedBeecon("edge-a2");
    const b = approvedBeecon("edge-b");
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
    const beeconId = approvedBeecon("edge-c");
    const result = await ingestBatch(beeconId, [], "192.0.2.9");
    expect(result).toEqual({ accepted: 0, skipped: 0 });
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { processCowrieRecord } from "@/lib/cowrie";
import { getDashboardData, getTelegramDetails } from "@/lib/db";

beforeAll(() => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "honey-spire-test-"));
  process.env.DATABASE_PATH = path.join(directory, "test.db");
  process.env.GEOLITE_DIR = path.join(directory, "geolite");
  process.env.COWRIE_JSON_LOG = path.join(directory, "cowrie.json");
});

describe("Cowrie telemetry", () => {
  it("correlates SSH fingerprints and stores login attempts", async () => {
    const session = "test-session";
    await processCowrieRecord({
      eventid: "cowrie.client.version",
      session,
      version: "SSH-2.0-OpenSSH_9.8",
    });
    await processCowrieRecord({
      eventid: "cowrie.client.kex",
      session,
      hassh: "f00dcafe",
      kexAlgs: ["curve25519-sha256"],
      keyAlgs: ["ssh-ed25519"],
    });
    await processCowrieRecord({
      eventid: "cowrie.login.failed",
      session,
      timestamp: new Date().toISOString(),
      src_ip: "203.0.113.10",
      src_port: 42123,
      username: "root",
      password: "toor",
    });

    const dashboard = getDashboardData("1h");
    expect(dashboard.totalAttacks).toBe(1);
    expect(dashboard.currentRate).toBe(1);
    expect(dashboard.topIps[0]).toEqual({
      value: "203.0.113.10",
      count: 1,
    });
    expect(dashboard.recentAttacks[0]).toMatchObject({
      sourceIp: "203.0.113.10",
      username: "root",
      password: "toor",
      clientVersion: "SSH-2.0-OpenSSH_9.8",
      hassh: "f00dcafe",
    });

    await processCowrieRecord({
      eventid: "cowrie.command.input",
      session,
      timestamp: new Date().toISOString(),
      src_ip: "203.0.113.10",
      input: "uname -a",
    });
    expect(getDashboardData("1h").recentCommands[0]).toMatchObject({
      sourceIp: "203.0.113.10",
      username: "root",
      command: "uname -a",
    });
    for (let index = 2; index <= 12; index += 1) {
      await processCowrieRecord({
        eventid: "cowrie.command.input",
        session,
        timestamp: new Date(Date.now() + index).toISOString(),
        src_ip: "203.0.113.10",
        input: `command-${index}`,
      });
    }
    expect(getDashboardData("1h").recentCommands).toHaveLength(10);
    expect(getDashboardData("1h").recentCommands[0].command).toBe("command-10");
    expect(getTelegramDetails(Date.now() - 60_000)).toMatchObject({
      attempts: 1,
      uniqueIps: 1,
      successfulLogins: 0,
      commandTotal: 10,
    });

    await processCowrieRecord({
      eventid: "cowrie.login.failed",
      session,
      timestamp: new Date(dashboard.recentAttacks[0].occurredAt).toISOString(),
      src_ip: "203.0.113.10",
      src_port: 42123,
      username: "root",
      password: "toor",
    });
    expect(getDashboardData("1h").totalAttacks).toBe(1);
  });
});

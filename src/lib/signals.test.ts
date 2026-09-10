import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { getDashboardData } from "@/lib/db";
import { processSignal } from "@/lib/signals";

beforeAll(() => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "neonhive-test-"));
  process.env.DATABASE_PATH = path.join(directory, "test.db");
  process.env.GEOLITE_DIR = path.join(directory, "geolite");
  process.env.COWRIE_JSON_LOG = path.join(directory, "cowrie.json");
});

describe("recon signals", () => {
  it("stores scan envelopes with sampled ports", async () => {
    await processSignal({
      kind: "scan",
      timestamp: Date.now(),
      sourceIp: "198.51.100.7",
      scanType: "syn",
      protocol: "tcp",
      ports: [21, 22, 23, 3306, 3389],
      count: 42,
    });

    const dashboard = getDashboardData("1h");
    expect(dashboard.recentSignals[0]).toMatchObject({
      kind: "scan",
      sourceIp: "198.51.100.7",
      scanType: "syn",
      summary: "syn scan · 42 ports",
    });
    expect(dashboard.recentSignals[0].ports).toEqual([21, 22, 23, 3306, 3389]);
    expect(dashboard.topScannerIps[0]).toEqual({
      value: "198.51.100.7",
      count: 1,
    });
  });

  it("stores decoy connections and ranks targeted ports", async () => {
    await processSignal({
      kind: "decoy",
      timestamp: Date.now(),
      sourceIp: "198.51.100.7",
      sourcePort: 55501,
      port: 6379,
      captured: "PING\r\n",
    });

    const dashboard = getDashboardData("1h");
    expect(dashboard.recentSignals[0]).toMatchObject({
      kind: "decoy",
      summary: "decoy port 6379 · payload",
      detail: "PING  ",
    });
    expect(dashboard.topTargetedPorts[0]).toEqual({ port: 6379, count: 1 });
  });

  it("maps opencanary records for credentials and HTTP paths", async () => {
    await processSignal({
      kind: "opencanary",
      record: {
        svc_name: "mysql",
        src_ip: "203.0.113.99",
        dst_port: 3306,
        logdata: { USERNAME: "root", PASSWORD: "hunter2" },
      },
    });
    await processSignal({
      kind: "opencanary",
      record: {
        svc_name: "http",
        src_ip: "203.0.113.99",
        dst_port: 8080,
        logdata: { PATH: "/.env", HEADER: "curl/8.0" },
      },
    });

    const dashboard = getDashboardData("1h");
    expect(dashboard.recentSignals[0]).toMatchObject({
      kind: "http",
      summary: "http /.env",
      ports: [8080],
    });
    expect(dashboard.recentHttp[0]).toMatchObject({
      sourceIp: "203.0.113.99",
      path: "/.env",
    });
    expect(dashboard.recentSignals[1]).toMatchObject({
      kind: "service",
      summary: "mysql root:hunter2",
    });
    expect(dashboard.signalTrend.reduce((sum, p) => sum + p.count, 0)).toBe(4);
  });

  it("ignores unknown kinds and malformed records", async () => {
    await processSignal({ kind: "future-kind", sourceIp: "10.0.0.1" });
    await processSignal({ kind: "scan", timestamp: Date.now() });
    await processSignal({ kind: "opencanary", record: { svc_name: "http" } });
    expect(getDashboardData("1h").recentSignals).toHaveLength(4);
  });
});

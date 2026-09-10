import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

// The honey-spire schema the migration must upgrade in place.
const LEGACY_SCHEMA = `
  CREATE TABLE beecons (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'active', 'revoked')),
    version TEXT,
    created_at INTEGER NOT NULL,
    approved_at INTEGER,
    revoked_at INTEGER,
    last_seen_at INTEGER,
    last_seen_ip TEXT,
    events_received INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE attacks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    occurred_at INTEGER NOT NULL,
    beecon_id TEXT REFERENCES beecons(id),
    session_id TEXT NOT NULL,
    source_ip TEXT NOT NULL,
    source_port INTEGER,
    username TEXT NOT NULL,
    password TEXT NOT NULL,
    country_code TEXT,
    country_name TEXT,
    city TEXT,
    latitude REAL,
    longitude REAL,
    asn INTEGER,
    organization TEXT,
    client_version TEXT,
    hassh TEXT,
    algorithms TEXT,
    successful INTEGER NOT NULL DEFAULT 0,
    UNIQUE (occurred_at, session_id, source_ip, username, password, successful)
  );
  CREATE INDEX attacks_beecon_idx ON attacks(beecon_id, occurred_at);
`;

beforeAll(() => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "neonhive-migrate-"));
  process.env.DATABASE_PATH = path.join(directory, "legacy.db");
  process.env.GEOLITE_DIR = path.join(directory, "geolite");
  process.env.COWRIE_JSON_LOG = path.join(directory, "cowrie.json");

  const legacy = new Database(process.env.DATABASE_PATH);
  legacy.exec(LEGACY_SCHEMA);
  legacy
    .prepare(
      `INSERT INTO beecons (id, name, status, created_at) VALUES ('sns_old', 'edge', 'active', 1)`,
    )
    .run();
  legacy
    .prepare(
      `INSERT INTO attacks (occurred_at, beecon_id, session_id, source_ip, username, password)
       VALUES (2, 'sns_old', 's1', '203.0.113.5', 'root', 'toor')`,
    )
    .run();
  legacy.close();
});

describe("legacy honey-spire database migration", () => {
  it("renames beecon tables and columns while keeping the data", async () => {
    const { getDatabase, getSensorSummaries, getDashboardData } = await import(
      "@/lib/db"
    );
    const db = getDatabase();

    const tables = (
      db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name IN ('beecons', 'sensors')`,
        )
        .all() as { name: string }[]
    ).map((row) => row.name);
    expect(tables).toEqual(["sensors"]);

    const attacksColumns = (
      db.prepare(`PRAGMA table_info(attacks)`).all() as { name: string }[]
    ).map((column) => column.name);
    expect(attacksColumns).toContain("sensor_id");
    expect(attacksColumns).not.toContain("beecon_id");

    // The renamed fleet row and its attack survive (alongside the built-in
    // local sensor the schema bootstraps), the FK still holds, and the
    // schema block recreated the dropped index under the new name.
    expect(getSensorSummaries(0)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "sns_old",
          name: "edge",
          status: "active",
        }),
      ]),
    );
    expect(getDashboardData("24h").recentAttacks[0]).toMatchObject({
      sensorId: "sns_old",
      sourceIp: "203.0.113.5",
    });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    const indexes = (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`)
        .all() as { name: string }[]
    ).map((row) => row.name);
    expect(indexes).toContain("attacks_sensor_idx");
    expect(indexes).not.toContain("attacks_beecon_idx");
  });
});

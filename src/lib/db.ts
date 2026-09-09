import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { getConfig } from "@/lib/config";
import type {
  AttackEvent,
  BeeconSummary,
  CommandEvent,
  DashboardData,
  RankedValue,
} from "@/lib/types";

let database: Database.Database | undefined;

function rowToAttack(row: Record<string, unknown>): AttackEvent {
  return {
    id: Number(row.id),
    occurredAt: Number(row.occurred_at),
    beeconId: String(row.beecon_id ?? "local"),
    sessionId: String(row.session_id),
    sourceIp: String(row.source_ip),
    sourcePort: row.source_port === null ? null : Number(row.source_port),
    username: String(row.username),
    password: String(row.password),
    countryCode: row.country_code ? String(row.country_code) : null,
    countryName: row.country_name ? String(row.country_name) : null,
    city: row.city ? String(row.city) : null,
    latitude: row.latitude === null ? null : Number(row.latitude),
    longitude: row.longitude === null ? null : Number(row.longitude),
    asn: row.asn === null ? null : Number(row.asn),
    organization: row.organization ? String(row.organization) : null,
    clientVersion: row.client_version ? String(row.client_version) : null,
    hassh: row.hassh ? String(row.hassh) : null,
    algorithms: row.algorithms ? String(row.algorithms) : null,
    successful: Boolean(row.successful),
  };
}

function rowToCommand(row: Record<string, unknown>): CommandEvent {
  return {
    id: Number(row.id),
    occurredAt: Number(row.occurred_at),
    beeconId: String(row.beecon_id ?? "local"),
    sessionId: String(row.session_id),
    sourceIp: String(row.source_ip),
    username: String(row.username),
    command: String(row.command),
  };
}

export function getDatabase(): Database.Database {
  if (database) return database;

  const databasePath = getConfig().DATABASE_PATH;
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  database = new Database(databasePath);
  database.pragma("journal_mode = WAL");
  database.pragma("synchronous = NORMAL");
  database.pragma("busy_timeout = 5000");
  database.pragma("foreign_keys = ON");
  database.pragma("cache_size = -8192");
  database.exec(`
    CREATE TABLE IF NOT EXISTS beecons (
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

    CREATE TABLE IF NOT EXISTS attacks (
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
      UNIQUE (
        occurred_at, session_id, source_ip, username, password, successful
      )
    );
    CREATE INDEX IF NOT EXISTS attacks_occurred_at_idx ON attacks(occurred_at);
    CREATE INDEX IF NOT EXISTS attacks_source_ip_idx ON attacks(source_ip, occurred_at);
    CREATE INDEX IF NOT EXISTS attacks_username_idx ON attacks(username, occurred_at);
    CREATE INDEX IF NOT EXISTS attacks_password_idx ON attacks(password, occurred_at);
    CREATE INDEX IF NOT EXISTS attacks_beecon_idx
      ON attacks(beecon_id, occurred_at);

    CREATE TABLE IF NOT EXISTS command_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      occurred_at INTEGER NOT NULL,
      beecon_id TEXT REFERENCES beecons(id),
      session_id TEXT NOT NULL,
      source_ip TEXT NOT NULL,
      command TEXT NOT NULL,
      UNIQUE (occurred_at, session_id, command)
    );
    CREATE INDEX IF NOT EXISTS command_events_occurred_at_idx
      ON command_events(occurred_at);
    CREATE INDEX IF NOT EXISTS command_events_session_id_idx
      ON command_events(session_id, occurred_at);
    CREATE INDEX IF NOT EXISTS command_events_beecon_idx
      ON command_events(beecon_id, occurred_at);

    CREATE TABLE IF NOT EXISTS minute_stats (
      bucket INTEGER PRIMARY KEY,
      attack_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS session_fingerprints (
      session_id TEXT PRIMARY KEY,
      client_version TEXT,
      hassh TEXT,
      algorithms TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // The built-in beecon represents this server's local honeypot (full mode).
  database
    .prepare(
      `INSERT INTO beecons (id, name, token_hash, status, created_at, approved_at)
       VALUES ('local', 'local', NULL, 'active', ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .run(Date.now(), Date.now());

  return database;
}

export function upsertFingerprint(
  sessionId: string,
  values: {
    clientVersion?: string | null;
    hassh?: string | null;
    algorithms?: string | null;
  },
) {
  getDatabase()
    .prepare(
      `INSERT INTO session_fingerprints
        (session_id, client_version, hassh, algorithms, updated_at)
       VALUES (@sessionId, @clientVersion, @hassh, @algorithms, @updatedAt)
       ON CONFLICT(session_id) DO UPDATE SET
        client_version = COALESCE(excluded.client_version, client_version),
        hassh = COALESCE(excluded.hassh, hassh),
        algorithms = COALESCE(excluded.algorithms, algorithms),
        updated_at = excluded.updated_at`,
    )
    .run({
      sessionId,
      clientVersion: values.clientVersion ?? null,
      hassh: values.hassh ?? null,
      algorithms: values.algorithms ?? null,
      updatedAt: Date.now(),
    });
}

export function getFingerprint(sessionId: string) {
  return getDatabase()
    .prepare(
      `SELECT client_version AS clientVersion, hassh, algorithms
       FROM session_fingerprints WHERE session_id = ?`,
    )
    .get(sessionId) as
    | {
        clientVersion: string | null;
        hassh: string | null;
        algorithms: string | null;
      }
    | undefined;
}

export function insertAttack(
  attack: Omit<AttackEvent, "id">,
): AttackEvent | null {
  const db = getDatabase();
  const insert = db.transaction(() => {
    const result = db
      .prepare(
        `INSERT OR IGNORE INTO attacks (
          occurred_at, beecon_id, session_id, source_ip, source_port,
          username, password, country_code, country_name, city, latitude,
          longitude, asn, organization, client_version, hassh, algorithms,
          successful
        ) VALUES (
          @occurredAt, @beeconId, @sessionId, @sourceIp, @sourcePort,
          @username, @password, @countryCode, @countryName, @city, @latitude,
          @longitude, @asn, @organization, @clientVersion, @hassh,
          @algorithms, @successful
        )`,
      )
      .run({ ...attack, successful: attack.successful ? 1 : 0 });
    if (result.changes === 0) return null;
    const bucket = Math.floor(attack.occurredAt / 60_000) * 60_000;
    db.prepare(
      `INSERT INTO minute_stats (bucket, attack_count) VALUES (?, 1)
       ON CONFLICT(bucket) DO UPDATE SET attack_count = attack_count + 1`,
    ).run(bucket);
    return Number(result.lastInsertRowid);
  });

  const id = insert();
  return id === null ? null : { ...attack, id };
}

export function getSessionContext(sessionId: string) {
  return getDatabase()
    .prepare(
      `SELECT source_ip AS sourceIp, username
       FROM attacks
       WHERE session_id = ?
       ORDER BY occurred_at DESC
       LIMIT 1`,
    )
    .get(sessionId) as
    | { sourceIp: string; username: string }
    | undefined;
}

export function insertCommand(
  command: Omit<CommandEvent, "id" | "username">,
): CommandEvent | null {
  const result = getDatabase()
    .prepare(
      `INSERT OR IGNORE INTO command_events
        (occurred_at, beecon_id, session_id, source_ip, command)
       SELECT @occurredAt, @beeconId, @sessionId, @sourceIp, @command
       WHERE (
         SELECT COUNT(*) FROM command_events WHERE session_id = @sessionId
       ) < 10`,
    )
    .run(command);
  if (result.changes === 0) return null;
  const context = getSessionContext(command.sessionId);
  return {
    ...command,
    id: Number(result.lastInsertRowid),
    username: context?.username ?? "",
  };
}

const rangeMilliseconds: Record<string, number> = {
  "1h": 60 * 60_000,
  "24h": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
  "30d": 30 * 24 * 60 * 60_000,
};

function topValues(
  column: "source_ip" | "username" | "password",
  since: number,
  beeconId?: string,
): RankedValue[] {
  return getDatabase()
    .prepare(
      `SELECT ${column} AS value, COUNT(*) AS count
       FROM attacks
       WHERE occurred_at >= ?${beeconId ? " AND beecon_id = ?" : ""}
       GROUP BY ${column}
       ORDER BY count DESC, value ASC
       LIMIT 20`,
    )
    .all(...(beeconId ? [since, beeconId] : [since]))
    .map((row) => {
      const typed = row as { value: string; count: number };
      return { value: typed.value, count: Number(typed.count) };
    });
}

export function getDashboardData(
  range = "24h",
  beeconId?: string,
): Omit<DashboardData, "sensors"> {
  const db = getDatabase();
  const normalizedRange = range in rangeMilliseconds ? range : "24h";
  const now = Date.now();
  const since = now - rangeMilliseconds[normalizedRange];
  const currentMinute = Math.floor(now / 60_000) * 60_000;
  const bucketSize =
    normalizedRange === "1h"
      ? 5 * 60_000
      : normalizedRange === "24h"
        ? 60 * 60_000
        : 24 * 60 * 60_000;

  const minuteRows = db
    .prepare(
      `SELECT bucket, attack_count FROM minute_stats
       WHERE bucket >= ? ORDER BY bucket ASC`,
    )
    .all(since) as { bucket: number; attack_count: number }[];

  const trendMap = new Map<number, number>();
  for (const row of minuteRows) {
    const bucket = Math.floor(row.bucket / bucketSize) * bucketSize;
    trendMap.set(bucket, (trendMap.get(bucket) ?? 0) + row.attack_count);
  }

  const recentRows = db
    .prepare(
      `SELECT * FROM attacks
       ${beeconId ? "WHERE beecon_id = ?" : ""}
       ORDER BY occurred_at DESC LIMIT 20`,
    )
    .all(...(beeconId ? [beeconId] : [])) as Record<string, unknown>[];
  const commandRows = db
    .prepare(
      `SELECT
        c.*,
        COALESCE((
          SELECT a.username
          FROM attacks a
          WHERE a.session_id = c.session_id
          ORDER BY a.occurred_at DESC
          LIMIT 1
        ), '') AS username
       FROM command_events c
       ${beeconId ? "WHERE c.beecon_id = ?" : ""}
       ORDER BY c.occurred_at DESC
       LIMIT 200`,
    )
    .all(...(beeconId ? [beeconId] : [])) as Record<string, unknown>[];
  const mapRows = db
    .prepare(
      `SELECT * FROM attacks
       WHERE occurred_at >= ? AND latitude IS NOT NULL AND longitude IS NOT NULL${beeconId ? " AND beecon_id = ?" : ""}
       ORDER BY occurred_at DESC LIMIT 200`,
    )
    .all(...(beeconId ? [since, beeconId] : [since])) as Record<string, unknown>[];
  const total = db
    .prepare(
      `SELECT COUNT(*) AS count FROM attacks
       WHERE occurred_at >= ?${beeconId ? " AND beecon_id = ?" : ""}`,
    )
    .get(...(beeconId ? [since, beeconId] : [since])) as { count: number };
  const peak = db
    .prepare(
      `SELECT COALESCE(MAX(attack_count), 0) AS count
       FROM minute_stats WHERE bucket >= ?`,
    )
    .get(now - 60 * 60_000) as { count: number };
  const countFor = (bucket: number) =>
    minuteRows.find((row) => row.bucket === bucket)?.attack_count ?? 0;

  return {
    generatedAt: now,
    range: normalizedRange,
    currentRate: countFor(currentMinute),
    previousRate: countFor(currentMinute - 60_000),
    totalAttacks: Number(total.count),
    gaugeMaximum: Math.max(10, Number(peak.count)),
    trend: Array.from(trendMap, ([timestamp, count]) => ({ timestamp, count })),
    topIps: topValues("source_ip", since, beeconId),
    topUsernames: topValues("username", since, beeconId),
    topPasswords: topValues("password", since, beeconId),
    recentCommands: commandRows.map(rowToCommand),
    recentAttacks: recentRows.map(rowToAttack),
    mapAttacks: mapRows.map(rowToAttack),
  };
}

export function rangeToMilliseconds(range: string): number {
  return rangeMilliseconds[range] ?? 0;
}

export function getBeeconSummaries(
  since = 0,
): Omit<BeeconSummary, "online">[] {
  return (
    getDatabase()
      .prepare(
        `SELECT
          b.id, b.name, b.status, b.version, b.created_at AS createdAt,
          b.approved_at AS approvedAt, b.revoked_at AS revokedAt,
          b.last_seen_at AS lastSeenAt, b.last_seen_ip AS lastSeenIp,
          b.events_received AS eventsReceived,
          (SELECT COUNT(*) FROM attacks a
            WHERE a.beecon_id = b.id AND a.occurred_at >= ?) AS attacks,
          (SELECT COUNT(*) FROM command_events c
            WHERE c.beecon_id = b.id AND c.occurred_at >= ?) AS commands
         FROM beecons b
         ORDER BY b.created_at ASC, b.id ASC`,
      )
      .all(since, since) as Omit<BeeconSummary, "online">[]
  ).map((summary) => ({
    ...summary,
    createdAt: Number(summary.createdAt),
    eventsReceived: Number(summary.eventsReceived),
    attacks: Number(summary.attacks),
    commands: Number(summary.commands),
  }));
}

export function getMetadata(key: string): string | undefined {
  const row = getDatabase()
    .prepare(`SELECT value FROM metadata WHERE key = ?`)
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setMetadata(key: string, value: string) {
  getDatabase()
    .prepare(
      `INSERT INTO metadata (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value);
}

export function cleanupDatabase(retentionDays: number) {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60_000;
  const db = getDatabase();
  db.transaction(() => {
    db.prepare(`DELETE FROM attacks WHERE occurred_at < ?`).run(cutoff);
    db.prepare(`DELETE FROM command_events WHERE occurred_at < ?`).run(cutoff);
    db.prepare(`DELETE FROM minute_stats WHERE bucket < ?`).run(cutoff);
    db.prepare(`DELETE FROM session_fingerprints WHERE updated_at < ?`).run(
      Date.now() - 24 * 60 * 60_000,
    );
  })();
  db.pragma("optimize");
}

export function getAttackCountSince(since: number): number {
  const row = getDatabase()
    .prepare(`SELECT COUNT(*) AS count FROM attacks WHERE occurred_at >= ?`)
    .get(since) as { count: number };
  return Number(row.count);
}

export function getTelegramDetails(since: number) {
  const db = getDatabase();
  const totals = db
    .prepare(
      `SELECT
         COUNT(*) AS attempts,
         COUNT(DISTINCT source_ip) AS unique_ips,
         SUM(successful) AS successful_logins
       FROM attacks
       WHERE occurred_at >= ?`,
    )
    .get(since) as {
    attempts: number;
    unique_ips: number;
    successful_logins: number | null;
  };
  const commandTotal = db
    .prepare(
      `SELECT COUNT(*) AS count FROM command_events WHERE occurred_at >= ?`,
    )
    .get(since) as { count: number };
  const topCountries = db
    .prepare(
      `SELECT COALESCE(country_name, 'Unknown') AS value, COUNT(*) AS count
       FROM attacks
       WHERE occurred_at >= ?
       GROUP BY COALESCE(country_name, 'Unknown')
       ORDER BY count DESC, value ASC
       LIMIT 5`,
    )
    .all(since)
    .map((row) => {
      const value = row as { value: string; count: number };
      return { value: value.value, count: Number(value.count) };
    });
  const recentAttacks = db
    .prepare(
      `SELECT * FROM attacks
       WHERE occurred_at >= ?
       ORDER BY occurred_at DESC
       LIMIT 5`,
    )
    .all(since)
    .map((row) => rowToAttack(row as Record<string, unknown>));
  const recentCommands = db
    .prepare(
      `SELECT
         c.*,
         COALESCE((
           SELECT a.username FROM attacks a
           WHERE a.session_id = c.session_id
           ORDER BY a.occurred_at DESC LIMIT 1
         ), '') AS username
       FROM command_events c
       WHERE c.occurred_at >= ?
       ORDER BY c.occurred_at DESC
       LIMIT 5`,
    )
    .all(since)
    .map((row) => rowToCommand(row as Record<string, unknown>));

  return {
    attempts: Number(totals.attempts),
    uniqueIps: Number(totals.unique_ips),
    successfulLogins: Number(totals.successful_logins ?? 0),
    commandTotal: Number(commandTotal.count),
    topCountries,
    recentAttacks,
    recentCommands,
  };
}

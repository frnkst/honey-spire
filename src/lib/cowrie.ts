import fs from "node:fs";
import path from "node:path";
import { getConfig } from "@/lib/config";
import { LOCAL_SENSOR_ID, touchSensor } from "@/lib/sensors";
import {
  getFingerprint,
  getMetadata,
  getSessionContext,
  insertAttack,
  insertCommand,
  setMetadata,
  upsertFingerprint,
} from "@/lib/db";
import { geolocateIp } from "@/lib/geolocation";
import { liveEvents } from "@/lib/live-events";

type CowrieRecord = Record<string, unknown> & {
  eventid?: string;
  session?: string;
  timestamp?: string;
  src_ip?: string;
  src_port?: number;
  username?: string;
  password?: string;
};

function parseTimestamp(timestamp: unknown) {
  const parsed = timestamp ? new Date(String(timestamp)).getTime() : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function serializeAlgorithms(record: CowrieRecord): string | null {
  const keys = [
    "kexAlgs",
    "keyAlgs",
    "encCS",
    "encSC",
    "macCS",
    "macSC",
    "compCS",
    "compSC",
  ];
  const values = Object.fromEntries(
    keys
      .filter((key) => record[key] !== undefined)
      .map((key) => [key, record[key]]),
  );
  return Object.keys(values).length ? JSON.stringify(values) : null;
}

export interface IngestContext {
  sensorId: string;
}

/**
 * Processes a raw Cowrie JSON record. Session ids are namespaced with the
 * sensor id (`<sensorId>:<cowrieSession>`) so events from different sensors
 * never collide; the local file tailer ingests as the built-in "local" sensor.
 */
export async function processCowrieRecord(
  record: CowrieRecord,
  { sensorId }: IngestContext = { sensorId: LOCAL_SENSOR_ID },
) {
  const cowrieSession = String(record.session ?? "");
  if (!cowrieSession) return;
  const sessionId = `${sensorId}:${cowrieSession}`;

  if (record.eventid === "cowrie.client.version") {
    upsertFingerprint(sessionId, {
      clientVersion: String(record.version ?? "").slice(0, 512) || null,
    });
    return;
  }

  if (record.eventid === "cowrie.client.kex") {
    upsertFingerprint(sessionId, {
      hassh: String(record.hassh ?? "").slice(0, 128) || null,
      algorithms: serializeAlgorithms(record),
    });
    return;
  }

  if (record.eventid === "cowrie.command.input") {
    const commandText = String(record.input ?? "")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .slice(0, 4096);
    if (!commandText) return;
    const context = getSessionContext(sessionId);
    const sourceIp = String(record.src_ip ?? context?.sourceIp ?? "");
    if (!sourceIp) return;
    const command = insertCommand({
      occurredAt: parseTimestamp(record.timestamp),
      sensorId,
      sessionId,
      sourceIp,
      command: commandText,
    });
    if (command) liveEvents.emit("command", command);
    return;
  }

  if (
    record.eventid !== "cowrie.login.failed" &&
    record.eventid !== "cowrie.login.success"
  ) {
    return;
  }

  const sourceIp = String(record.src_ip ?? "");
  if (!sourceIp) return;

  const [geo, fingerprint] = await Promise.all([
    geolocateIp(sourceIp),
    Promise.resolve(getFingerprint(sessionId)),
  ]);
  const attack = insertAttack({
    occurredAt: parseTimestamp(record.timestamp),
    sensorId,
    sessionId,
    sourceIp,
    sourcePort: typeof record.src_port === "number" ? record.src_port : null,
    username: String(record.username ?? "").slice(0, 512),
    password: String(record.password ?? "").slice(0, 1024),
    ...geo,
    clientVersion: fingerprint?.clientVersion ?? null,
    hassh: fingerprint?.hassh ?? null,
    algorithms: fingerprint?.algorithms ?? null,
    successful: record.eventid === "cowrie.login.success",
  });
  if (attack) liveEvents.emit("attack", attack);
}

/**
 * Streams complete JSON lines that appeared in a log file since the last call,
 * resuming from a durable per-file offset and following rotations. The
 * namespace keeps each source's offsets separate in the metadata table.
 */
export async function tailJsonLogFile(
  logPath: string,
  namespace: string,
  onRecord: (record: Record<string, unknown>) => void | Promise<void>,
) {
  const baseName = path.basename(logPath);
  const metadataKey = `${namespace}_offset_${baseName}`;
  const identityKey = `${namespace}_identity_${baseName}`;
  const stat = fs.statSync(logPath);
  const size = stat.size;
  const identity = `${stat.dev}:${stat.ino}`;
  const previousIdentity = getMetadata(identityKey);
  if (previousIdentity !== identity) {
    setMetadata(identityKey, identity);
    setMetadata(metadataKey, "0");
  }
  const storedOffset = Number(getMetadata(metadataKey) ?? "0");
  let offset =
    Number.isFinite(storedOffset) && storedOffset <= size ? storedOffset : 0;
  if (size === offset) return;

  const stream = fs.createReadStream(logPath, {
    start: offset,
    highWaterMark: 64 * 1024,
  });
  let pending = Buffer.alloc(0);
  try {
    for await (const chunk of stream) {
      pending = Buffer.concat([pending, chunk as Buffer]);
      let newline = pending.indexOf(0x0a);
      while (newline >= 0) {
        const line = pending.subarray(0, newline).toString("utf8");
        const bytesConsumed = newline + 1;
        if (line.trim()) {
          let record: CowrieRecord;
          try {
            record = JSON.parse(line) as CowrieRecord;
          } catch (error) {
            console.warn(`Skipping malformed ${namespace} JSON record:`, error);
            offset += bytesConsumed;
            setMetadata(metadataKey, String(offset));
            pending = pending.subarray(bytesConsumed);
            newline = pending.indexOf(0x0a);
            continue;
          }
          await onRecord(record);
        }
        offset += bytesConsumed;
        setMetadata(metadataKey, String(offset));
        pending = pending.subarray(bytesConsumed);
        newline = pending.indexOf(0x0a);
      }
    }
  } finally {
    stream.destroy();
  }
}

/** Reads every (possibly rotated) log file of one source, oldest first. */
export async function tailJsonLogSource(
  configuredPath: string,
  namespace: string,
  onRecord: (record: Record<string, unknown>) => void | Promise<void>,
) {
  const directory = path.dirname(configuredPath);
  const baseName = path.basename(configuredPath);
  if (!fs.existsSync(directory)) return;

  const logPaths = (await fs.promises.readdir(directory))
    .filter((name) => name === baseName || name.startsWith(`${baseName}.`))
    .sort()
    .map((name) => path.join(directory, name));

  for (const logPath of logPaths) {
    await tailJsonLogFile(logPath, namespace, onRecord);
  }
}

export async function readNewCowrieEvents() {
  await tailJsonLogSource(getConfig().COWRIE_JSON_LOG, "cowrie", (record) =>
    processCowrieRecord(record),
  );
  // Keep the built-in sensor's presence fresh for the fleet view without
  // clobbering its last-seen address (there is no meaningful local IP).
  touchSensor(LOCAL_SENSOR_ID, null, 0);
}

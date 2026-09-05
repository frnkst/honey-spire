import fs from "node:fs";
import path from "node:path";
import { getConfig } from "@/lib/config";
import {
  getFingerprint,
  getMetadata,
  insertAttack,
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

export async function processCowrieRecord(record: CowrieRecord) {
  const sessionId = String(record.session ?? "");
  if (!sessionId) return;

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
  const parsedTimestamp = record.timestamp
    ? new Date(record.timestamp).getTime()
    : Number.NaN;
  const attack = insertAttack({
    occurredAt: Number.isFinite(parsedTimestamp) ? parsedTimestamp : Date.now(),
    sessionId,
    sourceIp,
    sourcePort:
      typeof record.src_port === "number" ? record.src_port : null,
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

async function readLogFile(logPath: string) {
  const baseName = path.basename(logPath);
  const metadataKey = `cowrie_offset_${baseName}`;
  const identityKey = `cowrie_identity_${baseName}`;
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
            console.warn("Skipping malformed Cowrie JSON record:", error);
            offset += bytesConsumed;
            setMetadata(metadataKey, String(offset));
            pending = pending.subarray(bytesConsumed);
            newline = pending.indexOf(0x0a);
            continue;
          }
          await processCowrieRecord(record);
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

export async function readNewCowrieEvents() {
  const configuredPath = getConfig().COWRIE_JSON_LOG;
  const directory = path.dirname(configuredPath);
  const baseName = path.basename(configuredPath);
  if (!fs.existsSync(directory)) return;

  const logPaths = (await fs.promises.readdir(directory))
    .filter((name) => name === baseName || name.startsWith(`${baseName}.`))
    .sort()
    .map((name) => path.join(directory, name));

  for (const logPath of logPaths) {
    await readLogFile(logPath);
  }
}

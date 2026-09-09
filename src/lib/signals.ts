import { LOCAL_BEECON_ID } from "@/lib/beecons";
import { getConfig } from "@/lib/config";
import { tailJsonLogSource } from "@/lib/cowrie";
import { insertSignal } from "@/lib/db";
import { geolocateIp } from "@/lib/geolocation";
import { liveEvents } from "@/lib/live-events";
import type { SignalEvent, SignalKind } from "@/lib/types";

const SCAN_TYPES = new Set([
  "syn",
  "connect",
  "null",
  "fin",
  "xmas",
  "ack",
  "ping_sweep",
]);
const MAX_PORTS = 16;
const MAX_SUMMARY = 256;
const MAX_DETAIL = 2048;

export interface SignalContext {
  beeconId: string;
}

function parseTimestamp(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = value ? new Date(String(value)).getTime() : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function truncate(value: string, max: number) {
  return value.length > max ? value.slice(0, max) : value;
}

function normalizePorts(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const ports = value
    .map((port) => Number(port))
    .filter((port) => Number.isInteger(port) && port > 0 && port <= 65535);
  return [...new Set(ports)].sort((a, b) => a - b).slice(0, MAX_PORTS);
}

function parseIp(value: unknown) {
  const ip = String(value ?? "").trim();
  return ip ? ip : null;
}

type SignalDraft = Pick<
  SignalEvent,
  | "occurredAt"
  | "kind"
  | "sourceIp"
  | "sourcePort"
  | "protocol"
  | "scanType"
  | "ports"
  | "summary"
  | "detail"
>;

async function storeSignal(draft: SignalDraft, { beeconId }: SignalContext) {
  const geo = await geolocateIp(draft.sourceIp);
  const signal: Omit<SignalEvent, "id"> = {
    ...draft,
    summary: truncate(draft.summary, MAX_SUMMARY),
    detail: draft.detail ? truncate(draft.detail, MAX_DETAIL) : null,
    beeconId,
    countryCode: geo.countryCode,
    countryName: geo.countryName,
    city: geo.city,
    latitude: geo.latitude,
    longitude: geo.longitude,
    asn: geo.asn,
    organization: geo.organization,
  };
  const stored = insertSignal(signal);
  if (stored) liveEvents.emit("signal", stored);
}

/**
 * Handles one enveloped recon event from a beecon or the sensor sidecar:
 * {"kind":"scan"|"decoy", ...} or {"kind":"opencanary","record":{...}}.
 * Unknown kinds are ignored so old towers survive newer sensors.
 */
export async function processSignal(
  record: Record<string, unknown>,
  context: SignalContext = { beeconId: LOCAL_BEECON_ID },
) {
  switch (String(record.kind ?? "")) {
    case "scan":
      return storeScan(record, context);
    case "decoy":
      return storeDecoy(record, context);
    case "opencanary": {
      const inner = record.record;
      if (!inner || typeof inner !== "object") return;
      return storeOpencanary(inner as Record<string, unknown>, context);
    }
    default:
      return;
  }
}

async function storeScan(
  record: Record<string, unknown>,
  context: SignalContext,
) {
  const sourceIp = parseIp(record.sourceIp);
  if (!sourceIp) return;
  const scanType = SCAN_TYPES.has(String(record.scanType))
    ? String(record.scanType)
    : "syn";
  const ports = normalizePorts(record.ports);
  const count = Math.max(ports.length, Number(record.count) || 0);
  await storeSignal(
    {
      occurredAt: parseTimestamp(record.timestamp),
      kind: "scan",
      sourceIp,
      sourcePort:
        typeof record.sourcePort === "number" ? record.sourcePort : null,
      protocol: String(record.protocol ?? "tcp"),
      scanType,
      ports,
      summary: `${scanType} scan · ${count} ports`,
      detail: null,
    },
    context,
  );
}

async function storeDecoy(
  record: Record<string, unknown>,
  context: SignalContext,
) {
  const sourceIp = parseIp(record.sourceIp);
  const port = Number(record.port);
  if (!sourceIp || !Number.isInteger(port) || port <= 0) return;
  const captured = String(record.captured ?? "")
     
    .replace(/[\u0000-\u001f\u007f]/g, " ");
  await storeSignal(
    {
      occurredAt: parseTimestamp(record.timestamp),
      kind: "decoy",
      sourceIp,
      sourcePort:
        typeof record.sourcePort === "number" ? record.sourcePort : null,
      protocol: String(record.protocol ?? "tcp"),
      scanType: null,
      ports: [port],
      summary: `decoy port ${port}${captured ? " · payload" : ""}`,
      detail: captured ? truncate(captured, MAX_DETAIL) : null,
    },
    context,
  );
}

/**
 * Maps an Opencanary JSON record. Service modules report a `svc_name` plus a
 * `logdata` dictionary (USERNAME/PASSWORD for credential protocols, PATH and
 * friends for HTTP); the mapping stays tolerant so unknown modules still land
 * as generic service probes instead of being dropped.
 */
async function storeOpencanary(
  record: Record<string, unknown>,
  context: SignalContext,
) {
  const sourceIp = parseIp(record.src_ip ?? record.src_host);
  if (!sourceIp) return;
  const service = String(record.svc_name ?? "service").toLowerCase();
  const kind: SignalKind =
    service === "http" || service === "https" ? "http" : "service";
  const logdata =
    record.logdata && typeof record.logdata === "object"
      ? (record.logdata as Record<string, unknown>)
      : {};
  const path = String(logdata.PATH ?? "").slice(0, 512);
  const username = String(logdata.USERNAME ?? "");
  const password = String(logdata.PASSWORD ?? "");

  let summary = `${service} probe`;
  if (kind === "http" && path) summary = `${service} ${path}`;
  else if (username || password) summary = `${service} ${username}:${password}`;
  else if (logdata.ARGUMENTS)
    summary = `${service} ${String(logdata.ARGUMENTS)}`;

  await storeSignal(
    {
      occurredAt: parseTimestamp(
        record.utc_time ?? record.local_time ?? record.timestamp,
      ),
      kind,
      sourceIp,
      sourcePort: null,
      protocol: service,
      scanType: null,
      ports: normalizePorts([record.dst_port]),
      summary: truncate(summary, MAX_SUMMARY),
      detail: JSON.stringify(logdata).slice(0, MAX_DETAIL),
    },
    context,
  );
}

/**
 * Tails the tower-local recon sources: the sensor sidecar's enveloped event
 * log and Opencanary's JSON log. Both are optional (empty path = disabled);
 * beecon-side equivalents flow through the ingest API instead.
 */
export async function readNewSensorEvents() {
  const config = getConfig();
  if (config.SENSOR_EVENTS_LOG) {
    await tailJsonLogSource(config.SENSOR_EVENTS_LOG, "sensor", (record) =>
      processSignal(record),
    );
  }
  if (config.OPENCANARY_JSON_LOG) {
    await tailJsonLogSource(
      config.OPENCANARY_JSON_LOG,
      "opencanary",
      (record) => processSignal({ kind: "opencanary", record }),
    );
  }
}

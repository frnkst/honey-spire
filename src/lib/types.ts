export interface AttackEvent {
  id: number;
  occurredAt: number;
  sensorId: string;
  sessionId: string;
  sourceIp: string;
  sourcePort: number | null;
  username: string;
  password: string;
  countryCode: string | null;
  countryName: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  asn: number | null;
  organization: string | null;
  clientVersion: string | null;
  hassh: string | null;
  algorithms: string | null;
  successful: boolean;
}

export interface CommandEvent {
  id: number;
  occurredAt: number;
  sensorId: string;
  sessionId: string;
  sourceIp: string;
  username: string;
  command: string;
}

export type SensorStatus = "pending" | "active" | "revoked";

export interface SensorSummary {
  id: string;
  name: string;
  status: SensorStatus;
  version: string | null;
  createdAt: number;
  approvedAt: number | null;
  revokedAt: number | null;
  lastSeenAt: number | null;
  lastSeenIp: string | null;
  eventsReceived: number;
  attacks: number;
  commands: number;
  online: boolean;
}

export interface JoinResponse {
  status: "pending" | "active";
  sensorId: string;
}

export interface IngestResponse {
  ok: true;
  accepted: number;
  skipped: number;
}

export interface RankedValue {
  value: string;
  count: number;
}

export interface TrendPoint {
  timestamp: number;
  count: number;
}

/** Per-sensor attack counts aligned with the trend bucket grid. */
export interface TrendSensor {
  id: string;
  name: string;
  counts: number[];
}

/** A hive/sensor plotted on the attack origin map. */
export interface MapSensor {
  id: string;
  name: string;
  /** True for the hive's built-in honeypot. */
  local: boolean;
  online: boolean;
  latitude: number;
  longitude: number;
  location: string | null;
}

/**
 * Recon activity beyond SSH logins: port scans, decoy-port connections,
 * HTTP probes, and low-interaction service honeypot hits.
 */
export type SignalKind = "scan" | "decoy" | "http" | "service";

export interface SignalEvent {
  id: number;
  occurredAt: number;
  sensorId: string;
  kind: SignalKind;
  sourceIp: string;
  /** The attacker's ephemeral source port, when known. */
  sourcePort: number | null;
  /** Transport or application protocol, e.g. tcp, icmp, mysql, http. */
  protocol: string | null;
  /** Classifier result for scans: syn, null, fin, xmas, ack, ping_sweep. */
  scanType: string | null;
  /** Sampled target ports for scan events. */
  ports: number[] | null;
  summary: string;
  /** Captured bytes or the raw probe record, truncated. */
  detail: string | null;
  countryCode: string | null;
  countryName: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  asn: number | null;
  organization: string | null;
}

export interface MapSignalPoint {
  sourceIp: string;
  count: number;
  latitude: number;
  longitude: number;
}

export interface PortRank {
  port: number;
  count: number;
}

export interface HttpProbe {
  occurredAt: number;
  sourceIp: string;
  sourcePort: number | null;
  path: string;
  userAgent: string | null;
}

export interface DashboardData {
  generatedAt: number;
  range: string;
  currentRate: number;
  previousRate: number;
  totalAttacks: number;
  gaugeMaximum: number;
  trend: TrendPoint[];
  trendSensors: TrendSensor[];
  topIps: RankedValue[];
  topUsernames: RankedValue[];
  topPasswords: RankedValue[];
  recentCommands: CommandEvent[];
  recentAttacks: AttackEvent[];
  mapAttacks: AttackEvent[];
  sensors: MapSensor[];
  signalTrend: TrendPoint[];
  topScannerIps: RankedValue[];
  topTargetedPorts: PortRank[];
  recentHttp: HttpProbe[];
  recentSignals: SignalEvent[];
  mapSignals: MapSignalPoint[];
}

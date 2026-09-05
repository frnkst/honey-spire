export interface AttackEvent {
  id: number;
  occurredAt: number;
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
  sessionId: string;
  sourceIp: string;
  username: string;
  command: string;
}

export interface RankedValue {
  value: string;
  count: number;
}

export interface TrendPoint {
  timestamp: number;
  count: number;
}

export interface DashboardData {
  generatedAt: number;
  range: string;
  currentRate: number;
  previousRate: number;
  totalAttacks: number;
  gaugeMaximum: number;
  trend: TrendPoint[];
  topIps: RankedValue[];
  topUsernames: RankedValue[];
  topPasswords: RankedValue[];
  recentCommands: CommandEvent[];
  recentAttacks: AttackEvent[];
  mapAttacks: AttackEvent[];
}

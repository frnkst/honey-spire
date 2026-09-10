import { EventEmitter } from "node:events";
import type {
  AttackEvent,
  SensorSummary,
  CommandEvent,
  SignalEvent,
} from "@/lib/types";

const globalEvents = globalThis as typeof globalThis & {
  neonHiveEvents?: EventEmitter;
};

export const liveEvents =
  globalEvents.neonHiveEvents ??
  new EventEmitter<{
    attack: [AttackEvent];
    command: [CommandEvent];
    sensor: [SensorSummary];
    signal: [SignalEvent];
  }>();

liveEvents.setMaxListeners(100);
globalEvents.neonHiveEvents = liveEvents;

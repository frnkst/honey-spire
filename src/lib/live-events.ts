import { EventEmitter } from "node:events";
import type {
  AttackEvent,
  BeeconSummary,
  CommandEvent,
  SignalEvent,
} from "@/lib/types";

const globalEvents = globalThis as typeof globalThis & {
  honeySpireEvents?: EventEmitter;
};

export const liveEvents =
  globalEvents.honeySpireEvents ??
  new EventEmitter<{
    attack: [AttackEvent];
    command: [CommandEvent];
    beecon: [BeeconSummary];
    signal: [SignalEvent];
  }>();

liveEvents.setMaxListeners(100);
globalEvents.honeySpireEvents = liveEvents;

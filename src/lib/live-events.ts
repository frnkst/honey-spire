import { EventEmitter } from "node:events";
import type { AttackEvent, BeeconSummary, CommandEvent } from "@/lib/types";

const globalEvents = globalThis as typeof globalThis & {
  honeySpireEvents?: EventEmitter;
};

export const liveEvents =
  globalEvents.honeySpireEvents ??
  new EventEmitter<{
    attack: [AttackEvent];
    command: [CommandEvent];
    beecon: [BeeconSummary];
  }>();

liveEvents.setMaxListeners(100);
globalEvents.honeySpireEvents = liveEvents;

import { EventEmitter } from "node:events";
import type { AttackEvent } from "@/lib/types";

const globalEvents = globalThis as typeof globalThis & {
  honeySpireEvents?: EventEmitter;
};

export const liveEvents =
  globalEvents.honeySpireEvents ?? new EventEmitter<{ attack: [AttackEvent] }>();

liveEvents.setMaxListeners(100);
globalEvents.honeySpireEvents = liveEvents;

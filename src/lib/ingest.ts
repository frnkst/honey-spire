import { touchSensor } from "@/lib/sensors";
import { processCowrieRecord } from "@/lib/cowrie";
import { processSignal } from "@/lib/signals";

export const MAX_INGEST_EVENTS = 500;
export const MAX_EVENT_BYTES = 16 * 1024;

export interface IngestResult {
  accepted: number;
  skipped: number;
}

/**
 * Feeds a batch of raw JSON lines from a sensor through the ingestion
 * pipeline, tagged with the sensor's id. Lines carrying a `kind` envelope are
 * recon signals (scan/decoy/opencanary); everything else is treated as a raw
 * Cowrie record. Malformed lines count as skipped and never fail the batch —
 * the hive's UNIQUE constraints make the shipper's at-least-once delivery
 * safe to dedupe.
 */
export async function ingestBatch(
  sensorId: string,
  events: string[],
  ip: string,
): Promise<IngestResult> {
  let accepted = 0;
  let skipped = 0;
  for (const raw of events) {
    if (raw.length > MAX_EVENT_BYTES) {
      skipped += 1;
      continue;
    }
    try {
      const record = JSON.parse(raw);
      if (record && typeof record === "object" && "kind" in record) {
        await processSignal(record as Record<string, unknown>, { sensorId });
      } else {
        await processCowrieRecord(record, { sensorId });
      }
      accepted += 1;
    } catch (error) {
      console.warn(
        "Skipping malformed sensor event:",
        error instanceof Error ? error.message : error,
      );
      skipped += 1;
    }
  }
  touchSensor(sensorId, ip, events.length);
  return { accepted, skipped };
}

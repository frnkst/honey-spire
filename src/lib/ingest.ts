import { touchBeecon } from "@/lib/beecons";
import { processCowrieRecord } from "@/lib/cowrie";

export const MAX_INGEST_EVENTS = 500;
export const MAX_EVENT_BYTES = 16 * 1024;

export interface IngestResult {
  accepted: number;
  skipped: number;
}

/**
 * Feeds a batch of raw Cowrie JSON lines from a beecon through the regular
 * ingestion pipeline, tagged with the beecon's id. Malformed lines count as
 * skipped and never fail the batch — the tower's UNIQUE constraints make
 * the shipper's at-least-once delivery safe to dedupe.
 */
export async function ingestBatch(
  beeconId: string,
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
      await processCowrieRecord(JSON.parse(raw), { beeconId });
      accepted += 1;
    } catch (error) {
      console.warn(
        "Skipping malformed beecon event:",
        error instanceof Error ? error.message : error,
      );
      skipped += 1;
    }
  }
  touchBeecon(beeconId, ip, events.length);
  return { accepted, skipped };
}

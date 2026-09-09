import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { authenticateBeecon } from "@/lib/beecons";
import { clientIp } from "@/lib/http";
import { ingestBatch, MAX_INGEST_EVENTS } from "@/lib/ingest";

export const dynamic = "force-dynamic";

const eventSchema = z.array(z.string().max(16_384));
const MAX_BODY_CHARS = 4 * 1024 * 1024;

export async function POST(request: NextRequest) {
  const auth = authenticateBeecon(request);
  if (!auth.ok) {
    return NextResponse.json(
      { error: auth.error, code: auth.code },
      { status: auth.status },
    );
  }

  const body: unknown = await request.json().catch(() => null);
  const events = (body as { events?: unknown } | null)?.events;
  if (!Array.isArray(events)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  if (events.length > MAX_INGEST_EVENTS || JSON.stringify(body).length > MAX_BODY_CHARS) {
    return NextResponse.json({ error: "Batch too large." }, { status: 413 });
  }
  const parsed = eventSchema.safeParse(events);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const result = await ingestBatch(
    auth.beecon.id,
    parsed.data,
    clientIp(request),
  );
  return NextResponse.json({ ok: true, ...result });
}

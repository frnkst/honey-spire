import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  BeeconLimitError,
  getBeeconSummary,
  registerJoin,
} from "@/lib/beecons";
import { clientIp, hasValidOrigin, rateLimit } from "@/lib/http";
import { liveEvents } from "@/lib/live-events";

export const dynamic = "force-dynamic";

const joinSchema = z.object({
  name: z
    .string()
    .trim()
    .regex(/^[\w .-]{1,64}$/),
  token: z.string().regex(/^[a-f0-9]{64}$/i),
  version: z.string().max(64).optional(),
});

export async function POST(request: NextRequest) {
  // The beecon shipper is a machine client and sends no Origin header, so
  // only reject when a browser-style Origin is present and forged.
  if (!hasValidOrigin(request, { required: false })) {
    return NextResponse.json({ error: "Invalid origin." }, { status: 403 });
  }
  const ip = clientIp(request);
  if (!rateLimit(`join:${ip}`, 90, 15 * 60_000)) {
    return NextResponse.json(
      { error: "Too many join requests." },
      { status: 429 },
    );
  }

  const parsed = joinSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  try {
    const join = registerJoin({ ...parsed.data, ip });
    if (join.status === "revoked") {
      return NextResponse.json(
        { error: "Beecon has been removed.", code: "revoked" },
        { status: 403 },
      );
    }
    const summary = getBeeconSummary(join.beeconId);
    if (summary) liveEvents.emit("beecon", summary);
    return NextResponse.json({
      status: join.status,
      beeconId: join.beeconId,
    });
  } catch (error) {
    if (error instanceof BeeconLimitError) {
      return NextResponse.json(
        { error: "Too many pending beecons." },
        { status: 503 },
      );
    }
    throw error;
  }
}

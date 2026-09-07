import { NextResponse, type NextRequest } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { approveBeecon, getBeeconSummary } from "@/lib/beecons";
import { hasValidOrigin } from "@/lib/http";
import { liveEvents } from "@/lib/live-events";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  if (!hasValidOrigin(request)) {
    return NextResponse.json({ error: "Invalid origin." }, { status: 403 });
  }

  const { id } = await params;
  if (!getBeeconSummary(id)) {
    return NextResponse.json({ error: "Unknown beecon." }, { status: 404 });
  }
  if (!approveBeecon(id)) {
    return NextResponse.json(
      { error: "This beecon cannot be approved." },
      { status: 409 },
    );
  }
  const summary = getBeeconSummary(id);
  if (summary) liveEvents.emit("beecon", summary);
  return NextResponse.json({ ok: true });
}

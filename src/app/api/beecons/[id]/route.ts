import { NextResponse, type NextRequest } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getBeeconSummary, LOCAL_BEECON_ID, revokeBeecon } from "@/lib/beecons";
import { hasValidOrigin } from "@/lib/http";
import { liveEvents } from "@/lib/live-events";

export const dynamic = "force-dynamic";

export async function DELETE(
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
  if (id === LOCAL_BEECON_ID) {
    return NextResponse.json(
      { error: "The built-in local beecon cannot be removed." },
      { status: 409 },
    );
  }
  if (!getBeeconSummary(id)) {
    return NextResponse.json({ error: "Unknown beecon." }, { status: 404 });
  }
  if (!revokeBeecon(id)) {
    return NextResponse.json(
      { error: "This beecon has already been removed." },
      { status: 409 },
    );
  }
  const summary = getBeeconSummary(id);
  if (summary) liveEvents.emit("beecon", summary);
  return NextResponse.json({ ok: true });
}

import { NextResponse, type NextRequest } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getSensorSummary, LOCAL_SENSOR_ID, revokeSensor } from "@/lib/sensors";
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
  if (id === LOCAL_SENSOR_ID) {
    return NextResponse.json(
      { error: "The built-in local sensor cannot be removed." },
      { status: 409 },
    );
  }
  if (!getSensorSummary(id)) {
    return NextResponse.json({ error: "Unknown sensor." }, { status: 404 });
  }
  if (!revokeSensor(id)) {
    return NextResponse.json(
      { error: "This sensor has already been removed." },
      { status: 409 },
    );
  }
  const summary = getSensorSummary(id);
  if (summary) liveEvents.emit("sensor", summary);
  return NextResponse.json({ ok: true });
}

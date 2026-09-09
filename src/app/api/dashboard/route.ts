import { NextResponse, type NextRequest } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getMapSensors } from "@/lib/beecons";
import { getDashboardData } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const range = request.nextUrl.searchParams.get("range") ?? "24h";
  const beeconId = request.nextUrl.searchParams.get("beecon") ?? undefined;
  const [data, sensors] = await Promise.all([
    getDashboardData(range, beeconId),
    getMapSensors(),
  ]);
  return NextResponse.json(
    { ...data, sensors },
    {
      headers: { "cache-control": "no-store" },
    },
  );
}

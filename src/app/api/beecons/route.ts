import { NextResponse, type NextRequest } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { listBeecons } from "@/lib/beecons";
import { rangeToMilliseconds } from "@/lib/db";

export const dynamic = "force-dynamic";

const RANGES = ["1h", "24h", "7d", "30d", "all"];

export async function GET(request: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const requested = request.nextUrl.searchParams.get("range") ?? "24h";
  const range = RANGES.includes(requested) ? requested : "24h";
  const since = range === "all" ? 0 : Date.now() - rangeToMilliseconds(range);
  const beecons = listBeecons(since);
  return NextResponse.json(
    {
      beecons,
      pendingCount: beecons.filter((beecon) => beecon.status === "pending")
        .length,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

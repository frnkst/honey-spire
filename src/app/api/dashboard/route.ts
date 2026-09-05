import { NextResponse, type NextRequest } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getDashboardData } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const range = request.nextUrl.searchParams.get("range") ?? "24h";
  return NextResponse.json(getDashboardData(range), {
    headers: { "cache-control": "no-store" },
  });
}

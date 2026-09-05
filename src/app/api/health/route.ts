import { NextResponse } from "next/server";
import { getDatabase } from "@/lib/db";

export const dynamic = "force-dynamic";

export function GET() {
  getDatabase().prepare("SELECT 1").get();
  return NextResponse.json({ status: "ok" });
}

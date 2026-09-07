import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { getDatabase } from "@/lib/db";

export const dynamic = "force-dynamic";

export function GET() {
  getDatabase().prepare("SELECT 1").get();
  return NextResponse.json({
    status: "ok",
    mode: getConfig().HONEY_SPIRE_MODE,
  });
}

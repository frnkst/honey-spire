import { NextResponse, type NextRequest } from "next/server";
import { clearSession } from "@/lib/auth";

export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (
    process.env.NODE_ENV === "production" &&
    (!origin || new URL(origin).host !== request.headers.get("host"))
  ) {
    return NextResponse.json({ error: "Invalid origin." }, { status: 403 });
  }
  await clearSession();
  return NextResponse.json({ ok: true });
}

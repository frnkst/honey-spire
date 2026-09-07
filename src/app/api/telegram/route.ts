import { NextResponse, type NextRequest } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { hasValidOrigin } from "@/lib/http";
import { sendTelegramSummary } from "@/lib/telegram";

export async function POST(request: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  if (!hasValidOrigin(request)) {
    return NextResponse.json({ error: "Invalid origin." }, { status: 403 });
  }

  try {
    const sent = await sendTelegramSummary("ad-hoc");
    if (!sent) {
      return NextResponse.json(
        { error: "Telegram is not configured." },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Manual Telegram summary failed:", error);
    return NextResponse.json(
      { error: "Telegram rejected the update." },
      { status: 502 },
    );
  }
}

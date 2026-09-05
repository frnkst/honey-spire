import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createSession, verifyCredentials } from "@/lib/auth";

const loginSchema = z.object({
  username: z.string().min(1).max(128),
  password: z.string().min(1).max(1024),
});

const attempts = new Map<string, { count: number; resetAt: number }>();

export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (
    process.env.NODE_ENV === "production" &&
    (!origin || new URL(origin).host !== request.headers.get("host"))
  ) {
    return NextResponse.json({ error: "Invalid origin." }, { status: 403 });
  }
  const ip =
    request.headers.get("x-real-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown";
  const now = Date.now();
  if (attempts.size >= 1_000) {
    for (const [address, attempt] of attempts) {
      if (attempt.resetAt <= now) attempts.delete(address);
    }
    if (attempts.size >= 1_000) {
      attempts.delete(attempts.keys().next().value as string);
    }
  }
  const current = attempts.get(ip);
  if (current && current.resetAt > now && current.count >= 5) {
    return NextResponse.json(
      { error: "Too many login attempts." },
      { status: 429 },
    );
  }

  const parsed = loginSchema.safeParse(await request.json().catch(() => null));
  if (
    !parsed.success ||
    !(await verifyCredentials(parsed.data.username, parsed.data.password))
  ) {
    attempts.set(ip, {
      count: current && current.resetAt > now ? current.count + 1 : 1,
      resetAt: now + 15 * 60_000,
    });
    return NextResponse.json({ error: "Invalid credentials." }, { status: 401 });
  }

  attempts.delete(ip);
  await createSession();
  return NextResponse.json({ ok: true });
}

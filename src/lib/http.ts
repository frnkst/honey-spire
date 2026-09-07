import type { NextRequest } from "next/server";

/**
 * Origin check for browser-facing mutations. Machine clients (the beecon
 * shipper) send no Origin header at all, so they can opt out of the
 * requirement — a present-but-forged Origin is still rejected.
 */
export function hasValidOrigin(
  request: NextRequest,
  { required = true }: { required?: boolean } = {},
) {
  if (process.env.NODE_ENV !== "production") return true;
  const origin = request.headers.get("origin");
  if (!origin) return !required;
  try {
    return new URL(origin).host === request.headers.get("host");
  } catch {
    return false;
  }
}

const windows = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(key: string, limit: number, windowMs: number) {
  const now = Date.now();
  if (windows.size >= 5_000) {
    for (const [entry, window] of windows) {
      if (window.resetAt <= now) windows.delete(entry);
    }
    if (windows.size >= 5_000) {
      windows.delete(windows.keys().next().value as string);
    }
  }
  const window = windows.get(key);
  if (!window || window.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  window.count += 1;
  return window.count <= limit;
}

export function clientIp(request: NextRequest) {
  return (
    request.headers.get("x-real-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

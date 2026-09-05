import { cookies } from "next/headers";
import { jwtVerify, SignJWT } from "jose";
import { verify } from "@node-rs/argon2";
import { requireAuthConfig } from "@/lib/config";

const COOKIE_NAME = "honey_spire_session";

function secretKey(secret: string) {
  return new TextEncoder().encode(secret);
}

export async function verifyCredentials(username: string, password: string) {
  const config = requireAuthConfig();
  if (username !== config.username) return false;
  return verify(config.passwordHash, password);
}

export async function createSession() {
  const config = requireAuthConfig();
  const token = await new SignJWT({ role: "admin" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(config.username)
    .setIssuedAt()
    .setExpirationTime("12h")
    .sign(secretKey(config.sessionSecret));

  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "strict",
    path: "/",
    maxAge: 12 * 60 * 60,
  });
}

export async function clearSession() {
  const cookieStore = await cookies();
  cookieStore.delete(COOKIE_NAME);
}

export async function isAuthenticated() {
  try {
    const config = requireAuthConfig();
    const token = (await cookies()).get(COOKIE_NAME)?.value;
    if (!token) return false;
    await jwtVerify(token, secretKey(config.sessionSecret), {
      algorithms: ["HS256"],
      subject: config.username,
    });
    return true;
  } catch {
    return false;
  }
}

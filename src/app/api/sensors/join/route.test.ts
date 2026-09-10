import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/sensors/join/route";
import { approveSensor, revokeSensor } from "@/lib/sensors";

beforeAll(() => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "neonhive-join-route-"),
  );
  process.env.DATABASE_PATH = path.join(directory, "test.db");
  process.env.GEOLITE_DIR = path.join(directory, "geolite");
});

function joinRequest(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/sensors/join", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }) satisfies NextRequest;
}

function joinBody(overrides: Record<string, unknown> = {}) {
  return {
    name: "garden sensor",
    token: randomBytes(32).toString("hex"),
    version: "1.0.0",
    ...overrides,
  };
}

describe("POST /api/sensors/join", () => {
  it("registers a new sensor as pending", async () => {
    const body = joinBody();
    const response = await POST(joinRequest(body));
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      status: string;
      sensorId: string;
    };
    expect(payload.status).toBe("pending");
    expect(payload.sensorId).toMatch(/^sns_[0-9a-f]{12}$/);
  });

  it("reports active once the sensor is approved", async () => {
    const body = joinBody();
    const first = await POST(joinRequest(body));
    const { sensorId } = (await first.json()) as { sensorId: string };
    expect(approveSensor(sensorId)).toBe(true);

    const second = await POST(joinRequest(body));
    expect(await second.json()).toMatchObject({ status: "active", sensorId });
  });

  it("rejects malformed requests", async () => {
    expect((await POST(joinRequest(joinBody({ token: "short" })))).status).toBe(
      400,
    );
    expect(
      (await POST(joinRequest(joinBody({ name: "bad name!" })))).status,
    ).toBe(400);
    expect((await POST(joinRequest({ name: "no token" }))).status).toBe(400);
  });

  it("signals removal for revoked tokens", async () => {
    const body = joinBody();
    const first = await POST(joinRequest(body));
    const { sensorId } = (await first.json()) as { sensorId: string };
    expect(revokeSensor(sensorId)).toBe(true);

    const response = await POST(joinRequest(body));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "revoked" });
  });

  it("rejects forged browser origins but allows machine clients", async () => {
    const env = process.env as { NODE_ENV?: string };
    const previous = env.NODE_ENV;
    env.NODE_ENV = "production";
    try {
      const forged = await POST(
        joinRequest(joinBody(), { origin: "https://evil.example" }),
      );
      expect(forged.status).toBe(403);

      const machine = await POST(joinRequest(joinBody()));
      expect(machine.status).toBe(200);
    } finally {
      env.NODE_ENV = previous;
    }
  });
});

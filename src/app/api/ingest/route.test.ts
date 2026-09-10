import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/ingest/route";
import { approveSensor, registerJoin } from "@/lib/sensors";

beforeAll(() => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "neonhive-ingest-route-"),
  );
  process.env.DATABASE_PATH = path.join(directory, "test.db");
  process.env.GEOLITE_DIR = path.join(directory, "geolite");
});

function approvedToken() {
  const token = randomBytes(32).toString("hex");
  const { sensorId } = registerJoin({
    name: "route-sensor",
    token,
    ip: "192.0.2.7",
  });
  return { token, sensorId, approve: () => approveSensor(sensorId) };
}

function ingestRequest(
  body: unknown,
  token = "missing",
): NextRequest {
  return new NextRequest("http://localhost/api/ingest", {
    method: "POST",
    headers:
      token === "missing" ? {} : { authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  }) satisfies NextRequest;
}

const loginRecord = JSON.stringify({
  eventid: "cowrie.login.failed",
  session: "7",
  timestamp: new Date().toISOString(),
  src_ip: "203.0.113.99",
  username: "admin",
  password: "123456",
});

describe("POST /api/ingest", () => {
  it("requires a bearer token", async () => {
    const missing = await POST(ingestRequest({ events: [] }));
    expect(missing.status).toBe(401);

    const unknown = await POST(ingestRequest({ events: [] }, "f".repeat(64)));
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toMatchObject({ code: "unknown_token" });
  });

  it("holds batches from pending sensors", async () => {
    const { token } = approvedToken(); // not approved
    const response = await POST(ingestRequest({ events: [loginRecord] }, token));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "pending" });
  });

  it("accepts batches from approved sensors", async () => {
    const { token, approve } = approvedToken();
    approve();
    const response = await POST(
      ingestRequest({ events: [loginRecord, "broken json"] }, token),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, accepted: 1, skipped: 1 });
  });

  it("treats an empty batch as a heartbeat", async () => {
    const { token, approve } = approvedToken();
    approve();
    const response = await POST(ingestRequest({ events: [] }, token));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, accepted: 0, skipped: 0 });
  });

  it("rejects invalid payloads and oversized batches", async () => {
    const { token, approve } = approvedToken();
    approve();

    const notArray = await POST(ingestRequest({ events: "nope" }, token));
    expect(notArray.status).toBe(400);

    const oversized = await POST(
      ingestRequest(
        { events: Array.from({ length: 501 }, () => loginRecord) },
        token,
      ),
    );
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ error: "Batch too large." });
  });
});

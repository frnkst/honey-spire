import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { NextRequest } from "next/server";
import {
  approveBeecon,
  authenticateBeecon,
  BeeconLimitError,
  hashToken,
  listBeecons,
  LOCAL_BEECON_ID,
  MAX_PENDING_BEECONS,
  registerJoin,
  revokeBeecon,
  touchBeecon,
} from "@/lib/beecons";
import { getDatabase } from "@/lib/db";

function beeconRequest(token?: string) {
  return new Request("http://tower/api/ingest", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  }) as unknown as NextRequest;
}

beforeAll(() => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "honey-spire-beecons-"));
  process.env.DATABASE_PATH = path.join(directory, "test.db");
  process.env.GEOLITE_DIR = path.join(directory, "geolite");
});

function makeBeecon(name = "edge-beecon") {
  const token = randomBytes(32).toString("hex");
  return { token, join: () => registerJoin({ name, token, ip: "10.0.0.1" }) };
}

describe("database schema", () => {
  it("creates the beecons table and the built-in local beecon once", () => {
    getDatabase();
    getDatabase(); // second open must be a no-op
    const local = getDatabase()
      .prepare(`SELECT id, status FROM beecons WHERE id = 'local'`)
      .get() as { id: string; status: string } | undefined;
    expect(local).toMatchObject({ id: "local", status: "active" });
  });
});

describe("beecon lifecycle", () => {
  it("hashes tokens deterministically", () => {
    expect(hashToken("a")).toBe(hashToken("a"));
    expect(hashToken("a")).not.toBe(hashToken("b"));
  });

  it("joins a pending beecon and stays idempotent per token", () => {
    const { token, join } = makeBeecon("display name");
    const first = join();
    expect(first.status).toBe("pending");
    expect(first.beeconId).toMatch(/^bc_[0-9a-f]{12}$/);

    const second = registerJoin({
      name: "renamed",
      token,
      version: "1.2.3",
      ip: "10.0.0.2",
    });
    expect(second).toEqual(first);
    const row = getDatabase()
      .prepare(`SELECT name, version, status FROM beecons WHERE id = ?`)
      .get(first.beeconId) as { name: string; version: string; status: string };
    expect(row).toMatchObject({ name: "renamed", version: "1.2.3" });
  });

  it("approves a pending beecon so its token authenticates", () => {
    const { token, join } = makeBeecon();
    const { beeconId } = join();
    expect(approveBeecon(beeconId)).toBe(true);
    expect(approveBeecon(beeconId)).toBe(false); // already active

    const auth = authenticateBeecon(beeconRequest(token));
    expect(auth).toMatchObject({ ok: true });
  });

  it("rejects unauthenticated and pending tokens", () => {
    const missing = authenticateBeecon(beeconRequest());
    expect(missing).toMatchObject({ ok: false, status: 401 });

    const { token, join } = makeBeecon(); // stays pending
    join();
    const pending = authenticateBeecon(beeconRequest(token));
    expect(pending).toMatchObject({ ok: false, status: 403, code: "pending" });

    const unknown = authenticateBeecon(beeconRequest("a".repeat(64)));
    expect(unknown).toMatchObject({
      ok: false,
      status: 401,
      code: "unknown_token",
    });
  });

  it("revokes beecons and blocks their tokens", () => {
    const { token, join } = makeBeecon();
    const { beeconId } = join();
    expect(revokeBeecon(beeconId)).toBe(true);
    expect(revokeBeecon(beeconId)).toBe(false);

    const revoked = authenticateBeecon(beeconRequest(token));
    expect(revoked).toMatchObject({ ok: false, status: 403, code: "revoked" });
    expect(registerJoin({ name: "zombie", token, ip: "10.0.0.3" })).toEqual({
      status: "revoked",
      beeconId,
    });
  });

  it("never approves or revokes the built-in local beecon", () => {
    expect(approveBeecon(LOCAL_BEECON_ID)).toBe(false);
    expect(revokeBeecon(LOCAL_BEECON_ID)).toBe(false);
  });

  it("derives the online flag from last_seen_at", () => {
    const { join } = makeBeecon("heartbeat");
    const { beeconId } = join();
    approveBeecon(beeconId);

    touchBeecon(beeconId, "10.0.0.9", 3);
    const online = listBeecons(0).find((b) => b.id === beeconId);
    expect(online).toMatchObject({ online: true, eventsReceived: 3 });

    getDatabase()
      .prepare(`UPDATE beecons SET last_seen_at = ? WHERE id = ?`)
      .run(Date.now() - 16 * 60_000, beeconId);
    const offline = listBeecons(0).find((b) => b.id === beeconId);
    expect(offline?.online).toBe(false);
  });

  it("caps the number of pending beecons", () => {
    const pendingCount = () =>
      listBeecons(0).filter((beecon) => beecon.status === "pending").length;
    for (let index = pendingCount(); index < MAX_PENDING_BEECONS; index += 1) {
      makeBeecon().join();
    }
    expect(pendingCount()).toBe(MAX_PENDING_BEECONS);
    expect(() => makeBeecon().join()).toThrow(BeeconLimitError);
  });
});

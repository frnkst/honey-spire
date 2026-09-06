import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  buildDownloadRequest,
  resolveMaxMindCredentials,
  writeFully,
} from "@/lib/geolite-updater";

describe("buildDownloadRequest", () => {
  it("uses the current MaxMind permalink with Basic authentication", () => {
    const request = buildDownloadRequest(
      "GeoLite2-City",
      "123456",
      "license-key",
    );

    expect(request.url.toString()).toBe(
      "https://download.maxmind.com/geoip/databases/GeoLite2-City/download?suffix=tar.gz",
    );
    expect(request.init.headers.Authorization).toBe(
      `Basic ${Buffer.from("123456:license-key").toString("base64")}`,
    );
    expect(request.url.toString()).not.toContain("license-key");
  });

  it("supports combined credentials from older installations", () => {
    expect(resolveMaxMindCredentials("", "123456:license-key")).toEqual({
      accountId: "123456",
      licenseKey: "license-key",
    });
  });

  it("retries partial writes until a complete response chunk is stored", async () => {
    const writes: Buffer[] = [];
    const writer = {
      async write(
        chunk: Uint8Array,
        offset: number,
        length: number,
      ): Promise<{ bytesWritten: number }> {
        const bytesWritten = Math.min(2, length);
        writes.push(Buffer.from(chunk.subarray(offset, offset + bytesWritten)));
        return { bytesWritten };
      },
    };

    await expect(writeFully(writer, Buffer.from("abcdef"))).resolves.toBe(6);
    expect(Buffer.concat(writes).toString()).toBe("abcdef");
  });
});

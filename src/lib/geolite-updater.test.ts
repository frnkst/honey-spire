import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  buildDownloadRequest,
  resolveMaxMindCredentials,
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
});

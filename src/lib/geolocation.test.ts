import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("geolocateIp", () => {
  const originalDirectory = process.env.GEOLITE_DIR;

  afterEach(() => {
    if (originalDirectory === undefined) {
      delete process.env.GEOLITE_DIR;
    } else {
      process.env.GEOLITE_DIR = originalDirectory;
    }
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("continues without enrichment when GeoLite databases are invalid", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "neonhive-geolocation-"),
    );
    process.env.GEOLITE_DIR = directory;
    fs.writeFileSync(path.join(directory, "GeoLite2-City.mmdb"), "invalid");
    fs.writeFileSync(path.join(directory, "GeoLite2-ASN.mmdb"), "invalid");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const { geolocateIp } = await import("@/lib/geolocation");
      await expect(geolocateIp("192.0.2.1")).resolves.toEqual({
        countryCode: null,
        countryName: null,
        city: null,
        latitude: null,
        longitude: null,
        asn: null,
        organization: null,
      });
      expect(error).toHaveBeenCalledTimes(2);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

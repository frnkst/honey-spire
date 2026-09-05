import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { getConfig } from "@/lib/config";

const editions = ["GeoLite2-City", "GeoLite2-ASN"] as const;

async function findFile(directory: string, name: string): Promise<string | null> {
  for (const entry of await fs.promises.readdir(directory, {
    withFileTypes: true,
  })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await findFile(fullPath, name);
      if (nested) return nested;
    } else if (entry.name === name) {
      return fullPath;
    }
  }
  return null;
}

async function downloadEdition(
  edition: (typeof editions)[number],
  licenseKey: string,
) {
  const destination = getConfig().GEOLITE_DIR;
  await fs.promises.mkdir(destination, { recursive: true });
  const temporaryDirectory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "honey-spire-geolite-"),
  );
  const archivePath = path.join(temporaryDirectory, `${edition}.tar.gz`);

  try {
    const url = new URL("https://download.maxmind.com/app/geoip_download");
    url.searchParams.set("edition_id", edition);
    url.searchParams.set("license_key", licenseKey);
    url.searchParams.set("suffix", "tar.gz");
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok || !response.body) {
      throw new Error(`GeoLite download returned HTTP ${response.status}`);
    }
    const archive = await fs.promises.open(archivePath, "w", 0o600);
    try {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await archive.write(value);
      }
    } finally {
      await archive.close();
    }
    await tar.x({ file: archivePath, cwd: temporaryDirectory });
    const database = await findFile(temporaryDirectory, `${edition}.mmdb`);
    if (!database) throw new Error(`${edition}.mmdb was not in the archive`);
    await fs.promises.copyFile(
      database,
      path.join(destination, `${edition}.mmdb.next`),
    );
    await fs.promises.rename(
      path.join(destination, `${edition}.mmdb.next`),
      path.join(destination, `${edition}.mmdb`),
    );
  } finally {
    await fs.promises.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function updateGeoLiteDatabases() {
  const licenseKey = getConfig().MAXMIND_LICENSE_KEY;
  if (!licenseKey) return;
  for (const edition of editions) {
    await downloadEdition(edition, licenseKey);
  }
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import maxmind from "maxmind";
import * as tar from "tar";
import { getConfig } from "@/lib/config";

const editions = ["GeoLite2-City", "GeoLite2-ASN"] as const;

export function resolveMaxMindCredentials(accountId: string, licenseKey: string) {
  if (!accountId && licenseKey.includes(":")) {
    const separator = licenseKey.indexOf(":");
    return {
      accountId: licenseKey.slice(0, separator),
      licenseKey: licenseKey.slice(separator + 1),
    };
  }
  return { accountId, licenseKey };
}

export function buildDownloadRequest(
  edition: (typeof editions)[number],
  accountId: string,
  licenseKey: string,
) {
  const url = new URL(
    `https://download.maxmind.com/geoip/databases/${edition}/download`,
  );
  url.searchParams.set("suffix", "tar.gz");
  return {
    url,
    init: {
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountId}:${licenseKey}`).toString("base64")}`,
      },
      signal: AbortSignal.timeout(60_000),
    },
  };
}

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
  accountId: string,
  licenseKey: string,
) {
  const destination = getConfig().GEOLITE_DIR;
  await fs.promises.mkdir(destination, { recursive: true });
  const temporaryDirectory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "honey-spire-geolite-"),
  );
  const archivePath = path.join(temporaryDirectory, `${edition}.tar.gz`);

  try {
    const request = buildDownloadRequest(edition, accountId, licenseKey);
    const response = await fetch(request.url, request.init);
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
    await maxmind.open(database);
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
  const config = getConfig();
  const { accountId, licenseKey } = resolveMaxMindCredentials(
    config.MAXMIND_ACCOUNT_ID,
    config.MAXMIND_LICENSE_KEY ?? "",
  );
  if (!accountId && !licenseKey) return;
  if (!accountId || !licenseKey) {
    throw new Error(
      "GeoLite updates require both MAXMIND_ACCOUNT_ID and MAXMIND_LICENSE_KEY",
    );
  }
  for (const edition of editions) {
    await downloadEdition(edition, accountId, licenseKey);
  }
}

import fs from "node:fs";
import path from "node:path";
import { getConfig } from "@/lib/config";
import { readNewCowrieEvents } from "@/lib/cowrie";
import { cleanupDatabase, getDatabase, getMetadata, setMetadata } from "@/lib/db";
import { updateGeoLiteDatabases } from "@/lib/geolite-updater";
import { sendTelegramSummary } from "@/lib/telegram";

const runtimeGlobal = globalThis as typeof globalThis & {
  honeySpireRuntimeStarted?: boolean;
};

function schedule(name: string, intervalMs: number, task: () => Promise<void> | void) {
  let running = false;
  const execute = async () => {
    if (running) return;
    running = true;
    try {
      await task();
    } catch (error) {
      console.error(`${name} failed:`, error);
    } finally {
      running = false;
    }
  };
  void execute();
  const timer = setInterval(execute, intervalMs);
  timer.unref();
}

async function removeExpiredFiles(
  directory: string,
  retentionDays: number,
  include: (filePath: string) => boolean = () => true,
) {
  if (!fs.existsSync(directory)) return;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60_000;
  const entries = await fs.promises.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await removeExpiredFiles(fullPath, retentionDays, include);
      continue;
    }
    const stat = await fs.promises.stat(fullPath);
    if (include(fullPath) && stat.mtimeMs < cutoff) {
      await fs.promises.unlink(fullPath);
    }
  }
}

function isDue(key: string, intervalMs: number) {
  const previous = Number(getMetadata(key) ?? "0");
  return Date.now() - previous >= intervalMs;
}

function markRun(key: string) {
  setMetadata(key, String(Date.now()));
}

export function startRuntime() {
  if (runtimeGlobal.honeySpireRuntimeStarted) return;
  runtimeGlobal.honeySpireRuntimeStarted = true;
  getDatabase();
  const config = getConfig();

  // The local Cowrie tailer only exists in full installs; towers receive
  // remote beecon events over the ingest API instead.
  if (config.HONEY_SPIRE_MODE === "full") {
    schedule("Cowrie ingestion", 1_000, readNewCowrieEvents);
  }
  schedule("GeoLite update", 6 * 60 * 60_000, async () => {
    if (!isDue("last_geolite_update", 7 * 24 * 60 * 60_000)) return;
    await updateGeoLiteDatabases();
    markRun("last_geolite_update");
  });
  schedule("Retention cleanup", 60 * 60_000, async () => {
    if (!isDue("last_cleanup", 24 * 60 * 60_000)) return;
    cleanupDatabase(config.RETENTION_DAYS);
    if (config.HONEY_SPIRE_MODE === "full") {
      await removeExpiredFiles(
        config.COWRIE_TTY_DIR,
        config.RAW_SESSION_RETENTION_DAYS,
        (filePath) =>
          /^(?:\d{8}-\d{6}-[a-f0-9]+-\d+i\.log|[a-f0-9]{64})$/.test(
            path.basename(filePath),
          ),
      );
      await removeExpiredFiles(
        path.dirname(config.COWRIE_JSON_LOG),
        config.RAW_SESSION_RETENTION_DAYS,
        (filePath) => path.basename(filePath).startsWith("cowrie.json."),
      );
    }
    markRun("last_cleanup");
  });
  schedule("Hourly Telegram summary", 5 * 60_000, async () => {
    const interval = config.TELEGRAM_HOURLY_INTERVAL_MINUTES * 60_000;
    if (!isDue("last_hourly_telegram", interval)) return;
    await sendTelegramSummary("hourly");
    markRun("last_hourly_telegram");
  });
  schedule("Daily Telegram summary", 60 * 60_000, async () => {
    const interval = config.TELEGRAM_DAILY_INTERVAL_HOURS * 60 * 60_000;
    if (!isDue("last_daily_telegram", interval)) return;
    await sendTelegramSummary("daily");
    markRun("last_daily_telegram");
  });
}

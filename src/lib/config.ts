import { z } from "zod";

const environmentSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  NEON_HIVE_MODE: z.enum(["full", "hive"]).default("full"),
  DATABASE_PATH: z.string().default("./data/neonhive.db"),
  COWRIE_JSON_LOG: z.string().default("./data/cowrie/cowrie.json"),
  COWRIE_TTY_DIR: z.string().default("./data/cowrie/tty"),
  // Recon sources: Opencanary's JSON log and the sensor sidecar's event log.
  // Empty disables the local tailer (sensors ship these through ingest).
  OPENCANARY_JSON_LOG: z.string().default(""),
  SENSOR_EVENTS_LOG: z.string().default(""),
  GEOLITE_DIR: z.string().default("./data/geolite"),
  MAXMIND_ACCOUNT_ID: z
    .string()
    .regex(/^$|^\d+$/, "MAXMIND_ACCOUNT_ID must be numeric")
    .default(""),
  MAXMIND_LICENSE_KEY: z.string().optional(),
  ADMIN_USERNAME: z.string().min(1).default("admin"),
  ADMIN_PASSWORD_HASH: z.string().optional(),
  SESSION_SECRET: z.string().min(32).optional(),
  SECURE_COOKIES: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  TELEGRAM_HOURLY_INTERVAL_MINUTES: z.coerce
    .number()
    .int()
    .min(15)
    .max(1440)
    .default(60),
  TELEGRAM_DAILY_INTERVAL_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .max(168)
    .default(24),
  RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(90),
  RAW_SESSION_RETENTION_DAYS: z.coerce.number().int().min(1).max(30).default(7),
});

export type AppConfig = z.infer<typeof environmentSchema>;

let cachedConfig: AppConfig | undefined;

export function getConfig(): AppConfig {
  cachedConfig ??= environmentSchema.parse(process.env);
  return cachedConfig;
}

export function requireAuthConfig() {
  const config = getConfig();
  if (!config.ADMIN_PASSWORD_HASH || !config.SESSION_SECRET) {
    throw new Error(
      "ADMIN_PASSWORD_HASH and SESSION_SECRET must be configured before login is available.",
    );
  }
  return {
    username: config.ADMIN_USERNAME,
    passwordHash: config.ADMIN_PASSWORD_HASH,
    sessionSecret: config.SESSION_SECRET,
    secureCookies: config.SECURE_COOKIES,
  };
}

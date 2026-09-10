import { getConfig } from "@/lib/config";
import { getDashboardData, getTelegramDetails } from "@/lib/db";

type TelegramPeriod = "hourly" | "daily" | "ad-hoc";

function rankedLines(
  values: { value: string; count: number }[],
  emptyMessage: string,
) {
  return values.length
    ? values
        .slice(0, 5)
        .map(
          (item, index) =>
            `${index + 1}. ${item.value || "(empty)"} — ${item.count}`,
        )
    : [emptyMessage];
}

export async function sendTelegramSummary(period: TelegramPeriod) {
  const config = getConfig();
  if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_CHAT_ID) return false;

  const hourly = period === "hourly";
  const range = hourly ? "1h" : "24h";
  const duration = hourly ? 60 * 60_000 : 24 * 60 * 60_000;
  const data = getDashboardData(range);
  const details = getTelegramDetails(Date.now() - duration);
  const title = period === "ad-hoc" ? "on-demand report" : `${period} summary`;
  const recentAttempts = details.recentAttacks.map((attack) => {
    const location = [attack.city, attack.countryCode]
      .filter(Boolean)
      .join(", ");
    const client = attack.clientVersion ?? "unknown client";
    return `${attack.successful ? "✅" : "❌"} ${attack.sourceIp} · ${attack.username || "(empty)"} · ${location || "unknown location"} · ${client}`;
  });
  const recentCommands = details.recentCommands.map(
    (command) =>
      `${command.sourceIp} · ${command.username || "(unknown)"} · ${command.command}`,
  );
  const signalCount = data.signalTrend.reduce(
    (sum, point) => sum + point.count,
    0,
  );
  const recentSignals = data.recentSignals.slice(0, 5).map((signal) => {
    const location = [signal.city, signal.countryCode]
      .filter(Boolean)
      .join(", ");
    return `🛰️ ${signal.sourceIp} · ${signal.summary}${
      location ? ` · ${location}` : ""
    }`;
  });
  const message = [
    `🍯 neonhive ${title}`,
    `Window: last ${hourly ? "60 minutes" : "24 hours"}`,
    `Generated: ${new Date().toISOString()}`,
    "",
    "📊 Activity",
    `Login attempts: ${details.attempts}`,
    `Unique source IPs: ${details.uniqueIps}`,
    `Accepted honeypot sessions: ${details.successfulLogins}`,
    `Commands captured: ${details.commandTotal}`,
    `Current rate: ${data.currentRate}/min (previous: ${data.previousRate}/min)`,
    `Recon signals: ${signalCount}`,
    "",
    "🌐 Top source IPs",
    ...rankedLines(data.topIps, "No source IPs"),
    "",
    "👤 Top usernames",
    ...rankedLines(data.topUsernames, "No usernames"),
    "",
    "🎯 Top targeted ports",
    ...(data.topTargetedPorts.length
      ? data.topTargetedPorts
          .slice(0, 5)
          .map((port) => `${port.port} — ${port.count}`)
      : ["No port probes"]),
    "",
    "🗺️ Top countries",
    ...rankedLines(details.topCountries, "No geolocation data"),
    "",
    "🕒 Recent login attempts",
    ...(recentAttempts.length ? recentAttempts : ["No recent login attempts"]),
    "",
    "⌨️ Recent commands",
    ...(recentCommands.length ? recentCommands : ["No commands captured"]),
    "",
    "🛰️ Recent recon signals",
    ...(recentSignals.length ? recentSignals : ["No recon signals"]),
  ].join("\n");

  const response = await fetch(
    `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: config.TELEGRAM_CHAT_ID,
        text: message.slice(0, 4096),
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) {
    throw new Error(`Telegram returned HTTP ${response.status}`);
  }
  return true;
}

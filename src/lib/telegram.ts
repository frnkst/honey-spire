import { getConfig } from "@/lib/config";
import { getAttackCountSince, getDashboardData } from "@/lib/db";

export async function sendTelegramSummary(period: "hourly" | "daily") {
  const config = getConfig();
  if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_CHAT_ID) return;

  const duration = period === "hourly" ? 60 * 60_000 : 24 * 60 * 60_000;
  const data = getDashboardData(period === "hourly" ? "1h" : "24h");
  const count = getAttackCountSince(Date.now() - duration);
  const topIp = data.topIps[0];
  const topUsername = data.topUsernames[0];
  const message = [
    `🍯 Honey Spire ${period} summary`,
    `Attacks: ${count}`,
    `Current rate: ${data.currentRate}/min`,
    `Top IP: ${topIp ? `${topIp.value} (${topIp.count})` : "none"}`,
    `Top username: ${topUsername ? `${topUsername.value} (${topUsername.count})` : "none"}`,
  ].join("\n");

  const response = await fetch(
    `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: config.TELEGRAM_CHAT_ID,
        text: message,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) {
    throw new Error(`Telegram returned HTTP ${response.status}`);
  }
}

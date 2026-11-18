// Discord payment alerts (staff-only channel webhook). Fire-and-forget: never affects the API response.
import type { Env } from "./types";

const short = (a: string) => (a && a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || "unknown");
const etTime = (ms: number) =>
  new Date(ms).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" }) + " ET";

export function explorerTxUrl(env: Env, network: string, tx: string): string {
  if (network.startsWith("xrpl:")) return `${env.EXPLORER_TX_URL || (network === "xrpl:0" ? "https://livenet.xrpl.org/transactions/" : "https://testnet.xrpl.org/transactions/")}${tx}`;
  if (network === "eip155:8453") return `https://basescan.org/tx/${tx}`;
  if (network === "eip155:84532") return `https://sepolia.basescan.org/tx/${tx}`;
  return tx;
}

async function postDiscord(env: Env, body: unknown): Promise<void> {
  const url = env.DISCORD_WEBHOOK_URL;
  if (!url) return;
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    if (!r.ok) console.warn("discord webhook", r.status);
  } catch (e) {
    console.warn("discord webhook failed", String(e).slice(0, 120));
  }
}

export interface PaymentInfo { service: string; amount: string; asset: string; network: string; payer: string; tx: string; at: number }

export function notifyPayment(env: Env, ctx: ExecutionContext | undefined, p: PaymentInfo): void {
  if (!env.DISCORD_WEBHOOK_URL) return;
  const testnet = p.network === "xrpl:1" || p.network === "eip155:84532";
  const link = explorerTxUrl(env, p.network, p.tx);
  const task = postDiscord(env, {
    username: "Glitter Agent Gate",
    allowed_mentions: { parse: [] },
    embeds: [{
      title: `${testnet ? "🧪 TESTNET payment" : "💸 Payment received"}: ${p.service}`,
      color: testnet ? 0x888888 : 0xffd76a,
      fields: [
        { name: "Amount", value: `${p.amount} ${p.asset}`, inline: true },
        { name: "Network", value: p.network, inline: true },
        { name: "Payer", value: `\`${short(p.payer)}\``, inline: true },
        { name: "Tx", value: p.tx ? `[${short(p.tx)}](${link})` : "n/a", inline: false },
      ],
      footer: { text: etTime(p.at) },
    }],
  }).catch(() => {});
  if (ctx) ctx.waitUntil(task);
}

/** Daily summary (cron). Posts only if there were settled payments in the last 24h. */
export async function dailySummary(env: Env): Promise<void> {
  if (!env.DISCORD_WEBHOOK_URL || env.DAILY_SUMMARY !== "true") return;
  const since = Date.now() - 24 * 3600_000;
  const rows = (await env.DB.prepare("SELECT service_slug, asset_symbol, COUNT(*) AS n, SUM(CAST(amount_display AS REAL)) AS total FROM settlements WHERE created_at >= ? GROUP BY service_slug, asset_symbol ORDER BY n DESC").bind(since).all<any>()).results ?? [];
  if (!rows.length) return;
  const calls = rows.reduce((a: number, r: any) => a + Number(r.n), 0);
  const byAsset: Record<string, number> = {};
  for (const r of rows) byAsset[r.asset_symbol] = (byAsset[r.asset_symbol] ?? 0) + Number(r.total);
  await postDiscord(env, {
    username: "Glitter Agent Gate", allowed_mentions: { parse: [] },
    embeds: [{
      title: `📊 Last 24h: ${calls} paid call${calls === 1 ? "" : "s"}`, color: 0xc77dff,
      description: rows.map((r: any) => `• **${r.service_slug}**: ${r.n} call${Number(r.n) === 1 ? "" : "s"}, ${Number(r.total).toFixed(6).replace(/\.?0+$/, "")} ${r.asset_symbol}`).join("\n"),
      fields: Object.entries(byAsset).map(([a, t]) => ({ name: a, value: t.toFixed(6).replace(/\.?0+$/, ""), inline: true })),
      footer: { text: etTime(Date.now()) },
    }],
  });
}

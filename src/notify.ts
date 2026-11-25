// Discord alerts for the private x402 section. Fire-and-forget: never affects the API response.
// DISCORD_WEBHOOK_URL (#stats) stays bound and is not written to by this module.
import type { Env } from "./types";
import { NOT_SELF_TEST } from "./selftest";

const short = (a: string) => (a && a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || "unknown");
const etTime = (ms: number) =>
  new Date(ms).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" }) + " ET";

const ALERT_WINDOW_MS = 15 * 60_000;
const ALERT_MAX_PER_WINDOW = 6;
const ALERT_DEDUPE_MS = 10 * 60_000;

export function explorerTxUrl(env: Env, network: string, tx: string): string {
  if (network.startsWith("xrpl:")) return `${env.EXPLORER_TX_URL || (network === "xrpl:0" ? "https://livenet.xrpl.org/transactions/" : "https://testnet.xrpl.org/transactions/")}${tx}`;
  if (network === "eip155:8453") return `https://basescan.org/tx/${tx}`;
  if (network === "eip155:84532") return `https://sepolia.basescan.org/tx/${tx}`;
  return tx;
}

async function postDiscord(url: string | undefined, body: unknown): Promise<boolean> {
  if (!url) return false;
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    if (!r.ok) console.warn("discord webhook", r.status);
    return r.ok;
  } catch (e) {
    console.warn("discord webhook failed", String(e).slice(0, 120));
    return false;
  }
}

const discordBody = (embeds: unknown[]) => ({
  username: "Glitter Agent Gate",
  allowed_mentions: { parse: [] as string[] },
  embeds,
});

export interface PaymentInfo { service: string; amount: string; asset: string; network: string; payer: string; tx: string; at: number }

export function notifyPayment(env: Env, ctx: ExecutionContext | undefined, p: PaymentInfo): void {
  // Private #agent-gate-payments only. Do not fall back to DISCORD_WEBHOOK_URL (#stats).
  if (!env.DISCORD_WEBHOOK_PAYMENTS) return;
  const testnet = p.network === "xrpl:1" || p.network === "eip155:84532";
  const link = explorerTxUrl(env, p.network, p.tx);
  const task = postDiscord(env.DISCORD_WEBHOOK_PAYMENTS, discordBody([{
    title: `${testnet ? "🧪 TESTNET payment" : "💸 Payment received"}: ${p.service}`,
    color: testnet ? 0x888888 : 0xffd76a,
    fields: [
      { name: "Amount", value: `${p.amount} ${p.asset}`, inline: true },
      { name: "Network", value: p.network, inline: true },
      { name: "Payer", value: `\`${short(p.payer)}\``, inline: true },
      { name: "Tx", value: p.tx ? `[${short(p.tx)}](${link})` : "n/a", inline: false },
    ],
    footer: { text: etTime(p.at) },
  }])).catch(() => false);
  if (ctx) ctx.waitUntil(task);
}

export type AlertKind = "settle_failed" | "settle_status_unknown" | "facilitator_error" | "internal_error";
export interface AlertInfo {
  kind: AlertKind;
  service?: string;
  network?: string;
  status?: number;
  detail?: string;
  test?: boolean;
}

const ALERT_TITLE: Record<AlertKind, string> = {
  settle_failed: "Settle failed",
  settle_status_unknown: "Settle status unknown",
  facilitator_error: "Facilitator error",
  internal_error: "Internal error (500)",
};

function fingerprint(a: AlertInfo): string {
  const raw = `${a.kind}|${a.service ?? ""}|${a.status ?? ""}|${(a.detail ?? "").slice(0, 80)}`;
  let h = 2166136261;
  for (let i = 0; i < raw.length; i++) h = Math.imul(h ^ raw.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16);
}

/** In-memory fallback if D1 is unavailable, so a tight 500 loop cannot spam Discord from one isolate. */
const memLimit = { windowId: 0, n: 0, last: new Map<string, number>(), suppressed: 0 };

async function bumpSuppressed(env: Env, key: string): Promise<number> {
  await env.DB.prepare("INSERT INTO gate_kv(k,v) VALUES(?,1) ON CONFLICT(k) DO UPDATE SET v=v+1").bind(key).run();
  const row = await env.DB.prepare("SELECT v FROM gate_kv WHERE k=?").bind(key).first<{ v: number }>();
  return Number(row?.v ?? 1);
}

export async function allowAlert(env: Env, fp: string, now = Date.now()): Promise<{ allow: boolean; suppressed: number }> {
  const windowId = Math.floor(now / ALERT_WINDOW_MS);
  const winKey = `discord_alert_win:${windowId}`;
  const dedupeKey = `discord_alert_dedupe:${fp}`;
  const suppKey = "discord_alert_suppressed";
  try {
    const last = await env.DB.prepare("SELECT v FROM gate_kv WHERE k=?").bind(dedupeKey).first<{ v: number }>();
    if (last && now - Number(last.v) < ALERT_DEDUPE_MS) return { allow: false, suppressed: await bumpSuppressed(env, suppKey) };
    const row = await env.DB.prepare("SELECT v FROM gate_kv WHERE k=?").bind(winKey).first<{ v: number }>();
    if (Number(row?.v ?? 0) >= ALERT_MAX_PER_WINDOW) return { allow: false, suppressed: await bumpSuppressed(env, suppKey) };
    await env.DB.batch([
      env.DB.prepare("INSERT INTO gate_kv(k,v) VALUES(?,1) ON CONFLICT(k) DO UPDATE SET v=v+1").bind(winKey),
      env.DB.prepare("INSERT INTO gate_kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(dedupeKey, now),
    ]);
    const supp = await env.DB.prepare("SELECT v FROM gate_kv WHERE k=?").bind(suppKey).first<{ v: number }>();
    await env.DB.prepare("INSERT INTO gate_kv(k,v) VALUES(?,0) ON CONFLICT(k) DO UPDATE SET v=0").bind(suppKey).run();
    return { allow: true, suppressed: Number(supp?.v ?? 0) };
  } catch (e) {
    console.warn("alert rate-limit check failed", String(e).slice(0, 120));
    if (memLimit.windowId !== windowId) { memLimit.windowId = windowId; memLimit.n = 0; }
    const prev = memLimit.last.get(fp) ?? 0;
    if (now - prev < ALERT_DEDUPE_MS || memLimit.n >= ALERT_MAX_PER_WINDOW) {
      memLimit.suppressed += 1;
      return { allow: false, suppressed: memLimit.suppressed };
    }
    memLimit.n += 1;
    memLimit.last.set(fp, now);
    const suppressed = memLimit.suppressed;
    memLimit.suppressed = 0;
    return { allow: true, suppressed };
  }
}

export function alertEmbed(a: AlertInfo, suppressed: number, at = Date.now()) {
  const fields: { name: string; value: string; inline?: boolean }[] = [
    { name: "Kind", value: a.kind, inline: true },
  ];
  if (a.service) fields.push({ name: "Service", value: a.service, inline: true });
  if (a.network) fields.push({ name: "Network", value: a.network, inline: true });
  if (a.status != null) fields.push({ name: "Status", value: String(a.status), inline: true });
  if (a.detail) fields.push({ name: "Detail", value: a.detail.slice(0, 1000), inline: false });
  if (suppressed > 0) fields.push({ name: "Suppressed since last alert", value: String(suppressed), inline: true });
  const title = `${a.test ? "TEST — " : "⚠️ "}${ALERT_TITLE[a.kind]}`;
  return {
    title,
    description: a.test ? "Operator-triggered test. This is not a real outage or failed payment." : undefined,
    color: a.test ? 0x5865f2 : 0xe74c3c,
    fields,
    footer: { text: etTime(at) },
  };
}

/** Settle failures, facilitator errors, uncaught 500s. Never called for unpaid probes. Rate-limited. */
export function notifyAlert(env: Env, ctx: ExecutionContext | undefined, a: AlertInfo, opts?: { skipRateLimit?: boolean }): void {
  if (!env.DISCORD_WEBHOOK_ALERTS) return;
  const task = (async () => {
    let suppressed = 0;
    if (!a.test && !opts?.skipRateLimit) {
      const gate = await allowAlert(env, fingerprint(a));
      if (!gate.allow) return;
      suppressed = gate.suppressed;
    }
    await postDiscord(env.DISCORD_WEBHOOK_ALERTS, discordBody([alertEmbed(a, suppressed)]));
  })().catch(() => {});
  if (ctx) ctx.waitUntil(task);
  else void task;
}

export function isFacilitatorOutage(v: { ok: boolean; status: number; data?: any }): boolean {
  if (v.data?.error === "facilitator_unreachable") return true;
  if (v.data?.retryable === true && (v.data?.phase === "verify" || v.data?.phase === "settle" || v.data?.error === "facilitator_unreachable")) return true;
  if (!v.ok && v.status >= 500) return true;
  return false;
}

type Row = Record<string, unknown>;

export function summaryEmbed(input: {
  test?: boolean;
  since: number;
  at?: number;
  calls: number;
  probes: number;
  attempts: number;
  paid: number;
  failures: { outcome: string; n: number }[];
  tools: { service_slug: string; calls: number; attempts: number; paid: number }[];
  volume?: { asset_symbol: string; n: number; total: number }[];
  selfTests?: { calls: number; attempts: number };
}) {
  const unpaid = Math.max(0, input.attempts - input.paid);
  const failLines = input.failures.length
    ? input.failures.map((f) => `• **${f.outcome}**: ${f.n}`).join("\n")
    : "None";
  const toolLines = input.tools.length
    ? input.tools.map((t) => `• **${t.service_slug}**: ${t.calls} call${t.calls === 1 ? "" : "s"}, ${t.attempts} attempt${t.attempts === 1 ? "" : "s"}, ${t.paid} paid`).join("\n")
    : "None";
  const vol = (input.volume ?? []).filter((v) => v.n > 0);
  const fields: { name: string; value: string; inline?: boolean }[] = [
    { name: "Calls", value: String(input.calls), inline: true },
    { name: "Probes (unpaid 402)", value: String(input.probes), inline: true },
    { name: "Payment attempts", value: `${input.attempts} (excl. probes)`, inline: true },
    { name: "Paid", value: String(input.paid), inline: true },
    { name: "Unpaid attempts", value: String(unpaid), inline: true },
    { name: "Self-tests", value: `${input.selfTests?.calls ?? 0} (excluded above; ${input.selfTests?.attempts ?? 0} test payment attempt${input.selfTests?.attempts === 1 ? "" : "s"})`, inline: true },
    { name: "Failures by outcome", value: failLines.slice(0, 1024), inline: false },
    { name: "Top tools", value: toolLines.slice(0, 1024), inline: false },
  ];
  if (vol.length) {
    fields.push({
      name: "Settled volume",
      value: vol.map((v) => `• ${Number(v.total).toFixed(6).replace(/\.?0+$/, "")} ${v.asset_symbol} (${v.n})`).join("\n").slice(0, 1024),
      inline: false,
    });
  }
  return {
    title: `${input.test ? "TEST — " : ""}📊 Last 24h: ${input.calls} call${input.calls === 1 ? "" : "s"}, ${input.paid} paid`,
    description: input.test
      ? "Operator-triggered test summary (same query as the 9:00 AM ET cron). Not the scheduled daily post."
      : (input.paid === 0 && input.attempts === 0 ? "No payment attempts in the last 24 hours." : undefined),
    color: input.test ? 0x5865f2 : 0xc77dff,
    fields,
    footer: { text: etTime(input.at ?? Date.now()) },
  };
}

/** Daily summary (cron). Posts to #agent-gate-activity even on $0 days. No IPs, payers, or user agents. */
export async function dailySummary(env: Env, opts?: { test?: boolean }): Promise<void> {
  if (!env.DISCORD_WEBHOOK_ACTIVITY || (env.DAILY_SUMMARY !== "true" && !opts?.test)) return;
  const since = Date.now() - 24 * 3600_000;
  const q = <T,>(sql: string, ...bind: unknown[]) =>
    env.DB.prepare(sql).bind(...bind).all<T>().then((r) => r.results ?? []).catch(() => [] as T[]);
  const [totals, failures, tools, volume, self] = await Promise.all([
    q<Row>(`SELECT COUNT(*) AS calls, SUM(CASE WHEN stage = 'probe' THEN 1 ELSE 0 END) AS probes, SUM(CASE WHEN stage != 'probe' THEN 1 ELSE 0 END) AS attempts, SUM(CASE WHEN outcome = 'paid' THEN 1 ELSE 0 END) AS paid FROM payment_attempts WHERE created_at >= ? AND ${NOT_SELF_TEST}`, since),
    q<{ outcome: string; n: number }>(`SELECT outcome, COUNT(*) AS n FROM payment_attempts WHERE created_at >= ? AND stage != 'probe' AND outcome != 'paid' AND ${NOT_SELF_TEST} GROUP BY outcome ORDER BY n DESC`, since),
    q<{ service_slug: string; calls: number; attempts: number; paid: number }>(`SELECT service_slug, COUNT(*) AS calls, SUM(CASE WHEN stage != 'probe' THEN 1 ELSE 0 END) AS attempts, SUM(CASE WHEN outcome = 'paid' THEN 1 ELSE 0 END) AS paid FROM payment_attempts WHERE created_at >= ? AND ${NOT_SELF_TEST} GROUP BY service_slug ORDER BY calls DESC LIMIT 10`, since),
    q<{ asset_symbol: string; n: number; total: number }>("SELECT asset_symbol, COUNT(*) AS n, SUM(CAST(amount_display AS REAL)) AS total FROM settlements WHERE created_at >= ? GROUP BY asset_symbol ORDER BY n DESC", since),
    q<Row>("SELECT COUNT(*) AS calls, SUM(CASE WHEN stage != 'probe' THEN 1 ELSE 0 END) AS attempts FROM payment_attempts WHERE created_at >= ? AND caller_kind = 'self-test'", since),
  ]);
  const t = totals[0] ?? {};
  const body = discordBody([summaryEmbed({
    test: opts?.test,
    since,
    calls: Number(t.calls ?? 0),
    probes: Number(t.probes ?? 0),
    attempts: Number(t.attempts ?? 0),
    paid: Number(t.paid ?? 0),
    failures,
    tools: tools.map((x) => ({ service_slug: String(x.service_slug), calls: Number(x.calls), attempts: Number(x.attempts), paid: Number(x.paid) })),
    volume: volume.map((x) => ({ asset_symbol: String(x.asset_symbol), n: Number(x.n), total: Number(x.total) })),
    selfTests: { calls: Number(self[0]?.calls ?? 0), attempts: Number(self[0]?.attempts ?? 0) },
  })]);
  await postDiscord(env.DISCORD_WEBHOOK_ACTIVITY, body);
}

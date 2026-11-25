// Local tests for Discord notify helpers: $0-day summary, probe exclusion, rate limits, no IPs.
import assert from "node:assert/strict";
import { allowAlert, alertEmbed, dailySummary, isFacilitatorOutage, notifyAlert, notifyPayment, summaryEmbed } from "../src/notify.ts";
import type { Env } from "../src/types.ts";

type Row = Record<string, unknown>;

class MemD1 {
  kv = new Map<string, number>();
  attempts: Row[] = [];
  settlements: Row[] = [];
  prepare(sql: string) {
    const self = this;
    const binds: unknown[] = [];
    const stmt = {
      bind(...args: unknown[]) { binds.length = 0; binds.push(...args); return stmt; },
      async first<T extends Row>() {
        const all = await stmt.all<T>();
        return (all.results[0] ?? null) as T | null;
      },
      async run() {
        self.exec(sql, binds);
        return { success: true };
      },
      async all<T extends Row>() {
        return { results: self.select(sql, binds) as T[] };
      },
    };
    return stmt;
  }
  async batch(stmts: { run: () => Promise<unknown> }[]) {
    for (const s of stmts) await s.run();
  }
  exec(sql: string, binds: unknown[]) {
    if (sql.includes("INSERT INTO gate_kv") && sql.includes("v=v+1")) {
      const k = String(binds[0]);
      this.kv.set(k, (this.kv.get(k) ?? 0) + 1);
      return;
    }
    if (sql.includes("INSERT INTO gate_kv") && sql.includes("v=excluded.v")) {
      this.kv.set(String(binds[0]), Number(binds[1]));
      return;
    }
    if (sql.includes("INSERT INTO gate_kv") && sql.includes("v=0")) {
      this.kv.set(String(binds[0]), 0);
      return;
    }
  }
  select(sql: string, binds: unknown[]): Row[] {
    if (sql.includes("FROM gate_kv")) {
      const v = this.kv.get(String(binds[0]));
      return v == null ? [] : [{ v }];
    }
    const since = Number(binds[0] ?? 0);
    const attempts = this.attempts.filter((r) => Number(r.created_at) >= since);
    if (sql.includes("FROM payment_attempts") && sql.includes("COUNT(*) AS calls")) {
      const calls = attempts.length;
      const probes = attempts.filter((r) => r.stage === "probe").length;
      const att = attempts.filter((r) => r.stage !== "probe").length;
      const paid = attempts.filter((r) => r.outcome === "paid").length;
      return [{ calls, probes, attempts: att, paid }];
    }
    if (sql.includes("FROM payment_attempts") && sql.includes("GROUP BY outcome")) {
      const map = new Map<string, number>();
      for (const r of attempts) {
        if (r.stage === "probe" || r.outcome === "paid") continue;
        map.set(String(r.outcome), (map.get(String(r.outcome)) ?? 0) + 1);
      }
      return [...map.entries()].map(([outcome, n]) => ({ outcome, n })).sort((a, b) => b.n - a.n);
    }
    if (sql.includes("FROM payment_attempts") && sql.includes("GROUP BY service_slug")) {
      const map = new Map<string, { calls: number; attempts: number; paid: number }>();
      for (const r of attempts) {
        const s = String(r.service_slug);
        const row = map.get(s) ?? { calls: 0, attempts: 0, paid: 0 };
        row.calls += 1;
        if (r.stage !== "probe") row.attempts += 1;
        if (r.outcome === "paid") row.paid += 1;
        map.set(s, row);
      }
      return [...map.entries()].map(([service_slug, v]) => ({ service_slug, ...v })).sort((a, b) => b.calls - a.calls).slice(0, 10);
    }
    if (sql.includes("FROM settlements")) {
      const map = new Map<string, { n: number; total: number }>();
      for (const r of this.settlements.filter((x) => Number(x.created_at) >= since)) {
        const k = String(r.asset_symbol);
        const row = map.get(k) ?? { n: 0, total: 0 };
        row.n += 1;
        row.total += Number(r.amount_display ?? 0);
        map.set(k, row);
      }
      return [...map.entries()].map(([asset_symbol, v]) => ({ asset_symbol, ...v }));
    }
    throw new Error("unhandled sql: " + sql);
  }
}

const posted: { url: string; body: any }[] = [];
const origFetch = globalThis.fetch;
function installFetch() {
  posted.length = 0;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    posted.push({ url, body: JSON.parse(init.body) });
    return new Response(null, { status: 204 });
  }) as typeof fetch;
}

function envFor(db: MemD1, hooks: Partial<Record<"PAYMENTS" | "ALERTS" | "ACTIVITY" | "STATS", string>> = {}): Env {
  return {
    DB: db as unknown as D1Database,
    DAILY_SUMMARY: "true",
    DISCORD_WEBHOOK_PAYMENTS: hooks.PAYMENTS,
    DISCORD_WEBHOOK_ALERTS: hooks.ALERTS,
    DISCORD_WEBHOOK_ACTIVITY: hooks.ACTIVITY,
    DISCORD_WEBHOOK_URL: hooks.STATS,
    EXPLORER_TX_URL: "https://livenet.xrpl.org/transactions/",
  } as unknown as Env;
}

let failed = 0;
function check(name: string, fn: () => Promise<void> | void) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log("ok  ", name))
    .catch((e) => { failed++; console.log("FAIL", name, e); });
}

await check("$0-day summary embed still posts and has zero counts", () => {
  const e = summaryEmbed({ since: 0, calls: 0, probes: 0, attempts: 0, paid: 0, failures: [], tools: [] });
  assert.match(e.title, /0 calls, 0 paid/);
  assert.match(e.description ?? "", /No payment attempts/);
  const names = e.fields.map((f) => f.name);
  assert.deepEqual(names, ["Calls", "Probes (unpaid 402)", "Payment attempts", "Paid", "Unpaid attempts", "Failures by outcome", "Top tools"]);
});

await check("summary excludes probes from attempts and lists failures + top tools", () => {
  const e = summaryEmbed({
    since: 0, calls: 10, probes: 8, attempts: 2, paid: 1,
    failures: [{ outcome: "settle_failed", n: 1 }],
    tools: [{ service_slug: "hello", calls: 9, attempts: 1, paid: 1 }, { service_slug: "web-markdown", calls: 1, attempts: 1, paid: 0 }],
    volume: [{ asset_symbol: "USDC", n: 1, total: 0.001 }],
  });
  assert.match(e.title, /10 calls, 1 paid/);
  assert.match(e.fields.find((f) => f.name === "Payment attempts")!.value, /2 \(excl. probes\)/);
  assert.match(e.fields.find((f) => f.name === "Unpaid attempts")!.value, /^1$/);
  assert.match(e.fields.find((f) => f.name === "Failures by outcome")!.value, /settle_failed/);
  assert.match(e.fields.find((f) => f.name === "Top tools")!.value, /hello/);
  assert.match(e.fields.find((f) => f.name === "Settled volume")!.value, /USDC/);
  const blob = JSON.stringify(e);
  assert.doesNotMatch(blob, /\b(?:\d{1,3}\.){3}\d{1,3}\b/);
  assert.doesNotMatch(blob, /as_org|user_agent|cf-connecting-ip|payer/i);
});

await check("test summary and test alert are labelled TEST", () => {
  const s = summaryEmbed({ test: true, since: 0, calls: 0, probes: 0, attempts: 0, paid: 0, failures: [], tools: [] });
  const a = alertEmbed({ kind: "internal_error", detail: "Operator-triggered test. Not a real outage.", test: true }, 0);
  assert.match(s.title, /^TEST — /);
  assert.match(s.description ?? "", /not the scheduled daily post/i);
  assert.match(a.title, /^TEST — /);
  assert.match(a.description ?? "", /not a real outage/i);
});

await check("isFacilitatorOutage: 5xx and unreachable, not client verify_failed", () => {
  assert.equal(isFacilitatorOutage({ ok: false, status: 503, data: { error: "facilitator_unreachable", retryable: true, phase: "verify" } }), true);
  assert.equal(isFacilitatorOutage({ ok: false, status: 502, data: {} }), true);
  assert.equal(isFacilitatorOutage({ ok: true, status: 200, data: { isValid: false, invalidReason: "invalid_exact_evm_payload_authorization" } }), false);
  assert.equal(isFacilitatorOutage({ ok: false, status: 400, data: { invalidReason: "bad_signature" } }), false);
});

await check("allowAlert: caps the window and dedupes, then reports suppressed", async () => {
  const db = new MemD1();
  const env = envFor(db);
  const now = 1_700_000_000_000;
  const first = await allowAlert(env, "aaa", now);
  assert.equal(first.allow, true);
  const dup = await allowAlert(env, "aaa", now + 1000);
  assert.equal(dup.allow, false);
  assert.equal(dup.suppressed, 1);
  // five more unique fingerprints fill the remaining 5 of 6 in the window (first already used 1)
  for (let i = 0; i < 5; i++) {
    const r = await allowAlert(env, "u" + i, now + 2000 + i);
    assert.equal(r.allow, true, "unique " + i);
  }
  const blocked = await allowAlert(env, "overflow", now + 3000);
  assert.equal(blocked.allow, false);
  assert.ok(blocked.suppressed >= 1);
  // next window allows again
  const later = await allowAlert(env, "aaa", now + 15 * 60_000 + 1);
  assert.equal(later.allow, true);
});

await check("notifyPayment posts only to PAYMENTS, never to #stats URL", async () => {
  installFetch();
  const env = envFor(new MemD1(), { PAYMENTS: "https://example.test/pay", STATS: "https://example.test/stats", ALERTS: "https://example.test/alerts" });
  notifyPayment(env, undefined, { service: "hello", amount: "0.001", asset: "USDC", network: "eip155:8453", payer: "0x1111111111111111111111111111111111111111", tx: "0xabc", at: Date.now() });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(posted.length, 1);
  assert.equal(posted[0].url, "https://example.test/pay");
  assert.equal(posted[0].body.allowed_mentions.parse.length, 0);
  const blob = JSON.stringify(posted[0].body);
  assert.doesNotMatch(blob, /0x1111111111111111111111111111111111111111/); // shortened
});

await check("notifyAlert posts to ALERTS; unpaid-probe-shaped payloads are never produced here", async () => {
  installFetch();
  const env = envFor(new MemD1(), { ALERTS: "https://example.test/alerts", STATS: "https://example.test/stats" });
  notifyAlert(env, undefined, { kind: "settle_failed", service: "hello", status: 402, detail: "settle_failed", test: true });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(posted.length, 1);
  assert.equal(posted[0].url, "https://example.test/alerts");
  assert.match(posted[0].body.embeds[0].title, /TEST/);
});

await check("dailySummary on $0 day still POSTs to ACTIVITY, not stats, and includes zeros", async () => {
  installFetch();
  const db = new MemD1();
  const env = envFor(db, { ACTIVITY: "https://example.test/activity", STATS: "https://example.test/stats", PAYMENTS: "https://example.test/pay" });
  await dailySummary(env);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].url, "https://example.test/activity");
  const title = posted[0].body.embeds[0].title as string;
  assert.match(title, /0 calls, 0 paid/);
  const blob = JSON.stringify(posted[0].body);
  assert.doesNotMatch(blob, /\b(?:\d{1,3}\.){3}\d{1,3}\b/);
});

await check("dailySummary counts probes separately and ignores them in attempts", async () => {
  installFetch();
  const db = new MemD1();
  const now = Date.now();
  db.attempts = [
    { created_at: now, service_slug: "hello", stage: "probe", outcome: "payment_required" },
    { created_at: now, service_slug: "hello", stage: "probe", outcome: "payment_required" },
    { created_at: now, service_slug: "hello", stage: "settle", outcome: "paid" },
    { created_at: now, service_slug: "web-markdown", stage: "settle", outcome: "settle_failed" },
  ];
  db.settlements = [{ created_at: now, asset_symbol: "USDC", amount_display: "0.001" }];
  const env = envFor(db, { ACTIVITY: "https://example.test/activity" });
  await dailySummary(env);
  const embed = posted[0].body.embeds[0];
  const field = (n: string) => embed.fields.find((f: any) => f.name === n).value;
  assert.equal(field("Calls"), "4");
  assert.equal(field("Probes (unpaid 402)"), "2");
  assert.match(field("Payment attempts"), /^2 /);
  assert.equal(field("Paid"), "1");
  assert.equal(field("Unpaid attempts"), "1");
  assert.match(field("Failures by outcome"), /settle_failed/);
  assert.doesNotMatch(JSON.stringify(embed), /\b(?:\d{1,3}\.){3}\d{1,3}\b/);
});

await check("dailySummary is a no-op when DAILY_SUMMARY is off, unless test:true", async () => {
  installFetch();
  const db = new MemD1();
  const env = envFor(db, { ACTIVITY: "https://example.test/activity" });
  (env as any).DAILY_SUMMARY = "false";
  await dailySummary(env);
  assert.equal(posted.length, 0);
  await dailySummary(env, { test: true });
  assert.equal(posted.length, 1);
  assert.match(posted[0].body.embeds[0].title, /^TEST — /);
});

globalThis.fetch = origFetch;
console.log(failed ? `\n${failed} failed` : "\nall notify tests passed");
process.exit(failed ? 1 : 0);

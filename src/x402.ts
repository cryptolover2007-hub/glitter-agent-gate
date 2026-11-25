// x402 v2 resource-server logic for the gateway.
// Wire format follows the x402 v2 spec and the x402-xrpl 0.3.4 SDK (read from its source):
//   402 body/PAYMENT-REQUIRED = base64(canonical JSON PaymentRequired)
//   PAYMENT-SIGNATURE = base64(PaymentPayload) ; XRPL payload = { signedTxBlob, invoiceId }
//   PAYMENT-RESPONSE  = base64({ success, transaction, network, payer })
// Flow (buyer-protective AND seller-protective): verify -> run handler -> settle -> release result.
//   * handler fails  => nothing is settled, buyer is not charged, invoice re-opens.
//   * settle fails   => result is withheld (402/409), so work is never given away for free.
import { notifyPayment } from "./notify";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import type { Env, PaidService, RouteDoc } from "./types";
import { corsHeaders, dropsToXrp, HttpError, json } from "./util";

export const HEADER_PAYMENT_REQUIRED = "PAYMENT-REQUIRED";
export const HEADER_PAYMENT_SIGNATURE = "PAYMENT-SIGNATURE";
export const HEADER_PAYMENT_RESPONSE = "PAYMENT-RESPONSE";
export const T54_SOURCE_TAG = 804681468; // t54 hosted facilitator tag; the XRPL AI Hub indexes volume by it
export const RLUSD_HEX = "524C555344000000000000000000000000000000";
const MAX_TIMEOUT_SECONDS = 300;

// ---------- encoding helpers (same canonicalisation as x402-xrpl) ----------
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonical((v as any)[k])]));
  return v;
}
export const canonicalJson = (v: unknown) => JSON.stringify(canonical(v));
export function b64encodeJson(v: unknown): string {
  const bytes = new TextEncoder().encode(canonicalJson(v));
  let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
export function b64decodeJson(s: string): any {
  const bin = atob(s.trim());
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
}

// ---------- requirements ----------
export interface Requirement {
  scheme: string; network: string; amount: string; asset: string; payTo: string; maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

export function isMainnetAllowed(env: Env) {
  if (env.X402_NETWORK === "xrpl:0" && env.ALLOW_MAINNET !== "true") throw new HttpError(500, "mainnet disabled: set ALLOW_MAINNET=true deliberately");
  if (env.BASE_NETWORK === "eip155:8453" && env.ALLOW_MAINNET !== "true") throw new HttpError(500, "Base mainnet disabled: set ALLOW_MAINNET=true deliberately");
}

export function usdcAtomic(v: string): string {
  if (!/^\d+(\.\d{1,6})?$/.test(v)) throw new Error("bad usdc price");
  const [w, f = ""] = v.split(".");
  return (BigInt(w) * 1_000_000n + BigInt(f.padEnd(6, "0"))).toString();
}

/** Payment options for a service. invoiceId=null builds the static listing used by discovery feeds. */
export function buildAccepts(env: Env, svc: PaidService, invoiceId: string | null): Requirement[] {
  const out: Requirement[] = [];
  const inv = invoiceId ? { invoiceId } : {};
  if (svc.price.xrpDrops) out.push({ scheme: "exact", network: env.X402_NETWORK, amount: svc.price.xrpDrops, asset: "XRP", payTo: svc.payTo, maxTimeoutSeconds: MAX_TIMEOUT_SECONDS, extra: { ...inv, sourceTag: T54_SOURCE_TAG } });
  if (svc.price.rlusd) out.push({ scheme: "exact", network: env.X402_NETWORK, amount: svc.price.rlusd, asset: RLUSD_HEX, payTo: svc.payTo, maxTimeoutSeconds: MAX_TIMEOUT_SECONDS, extra: { ...inv, issuer: env.RLUSD_ISSUER, sourceTag: T54_SOURCE_TAG, symbol: "RLUSD" } });
  // Optional Base USDC rail, only for first-party services (3rd-party listings would need their own EVM payTo).
  if (svc.price.usdc && env.BASE_PAY_TO && svc.kind === "own") out.push({ scheme: "exact", network: env.BASE_NETWORK, amount: usdcAtomic(svc.price.usdc), asset: env.BASE_USDC, payTo: env.BASE_PAY_TO, maxTimeoutSeconds: MAX_TIMEOUT_SECONDS, extra: { ...inv, name: env.BASE_NETWORK === "eip155:8453" ? "USD Coin" : "USDC", version: "2" } });
  // Solana USDC rail (PayAI facilitator), only when the payTo already has a USDC token account (else payments can't verify).
  const sol = solanaRail(env);
  if (svc.price.usdc && sol && svc.kind === "own") out.push({ scheme: "exact", network: sol.network, amount: usdcAtomic(svc.price.usdc), asset: sol.usdc, payTo: sol.payTo, maxTimeoutSeconds: MAX_TIMEOUT_SECONDS, extra: { ...inv, feePayer: sol.feePayer } });
  return out;
}

// ---------- Solana rail ----------
export const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const USDC_MINT: Record<string, string> = { [SOLANA_MAINNET]: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", [SOLANA_DEVNET]: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" };
const SOLANA_RPCS: Record<string, string[]> = { [SOLANA_MAINNET]: ["https://solana-rpc.publicnode.com", "https://api.mainnet-beta.solana.com"], [SOLANA_DEVNET]: ["https://api.devnet.solana.com"] };
// Associated token accounts (owner:mint -> ATA), precomputed with @solana-program/token findAssociatedTokenPda.
const KNOWN_ATA: Record<string, string> = {
  "BuVzde1ALzT5ChiapZxYcJ6UPCSauyLLQWbecej7uyqt:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": "G8hZ9HxmnuCVNbj3XxkmP3DbgCmE4v1BYwPD5jxQUBkf",
  "AQqnMFBwGZEoti85aTVRy8XYpKrho7GaMDx9ZB3CEeKA:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": "2V47kNnc5hpvPDuZjVKvktfZnPdk5Dac96BZkLJDYNsR", // local test only
};
// Defaults for production (mainnet) so the rail works without new Worker vars; override with SOLANA_PAY_TO / SOLANA_NETWORK.
const DEFAULT_SOLANA_PAY_TO = "BuVzde1ALzT5ChiapZxYcJ6UPCSauyLLQWbecej7uyqt";
const FEE_PAYER_FALLBACK: Record<string, string> = { [SOLANA_MAINNET]: "CjNFTjvBhbJJd2B5ePPMHRLx1ELZpa8dwQgGL727eKww", [SOLANA_DEVNET]: "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4" };
let solState: { key: string; ready: boolean; feePayer: string; checkedAt: number } | null = null;
function solConfig(env: Env) {
  const network = env.SOLANA_NETWORK || (env.X402_NETWORK === "xrpl:0" ? SOLANA_MAINNET : SOLANA_DEVNET);
  const payTo = env.SOLANA_PAY_TO ?? (env.X402_NETWORK === "xrpl:0" ? DEFAULT_SOLANA_PAY_TO : "");
  return { network, payTo, usdc: USDC_MINT[network] };
}
/** Solana rail if enabled AND verified ready (call refreshSolanaRail() first in the request). */
export function solanaRail(env: Env): { network: string; payTo: string; usdc: string; feePayer: string } | null {
  const c = solConfig(env);
  if (!c.payTo || !c.usdc || !solState || solState.key !== c.network + c.payTo || !solState.ready) return null;
  return { ...c, feePayer: solState.feePayer };
}
/** Checks (cached 10 min per isolate) that payTo owns a USDC token account and reads PayAI's Solana feePayer. Never throws. */
export async function refreshSolanaRail(env: Env, force = false): Promise<void> {
  const c = solConfig(env);
  if (!c.payTo || !c.usdc) return;
  const key = c.network + c.payTo;
  if (!force && solState && solState.key === key && Date.now() - solState.checkedAt < (solState.ready ? 600_000 : 120_000)) return;
  let ready = solState?.key === key ? solState.ready : false;
  let feePayer = solState?.key === key ? solState.feePayer : FEE_PAYER_FALLBACK[c.network];
  // Payments only verify if payTo owns a USDC token account (ATA). Check it with getAccountInfo on the known ATA (allowed on free RPCs).
  const ata = env.SOLANA_PAY_TO_ATA || KNOWN_ATA[c.payTo + ":" + c.usdc];
  const rpcs = [env.SOLANA_RPC_URL, ...(SOLANA_RPCS[c.network] ?? [])].filter(Boolean) as string[];
  for (const url of rpcs) {
    try {
      const body = ata
        ? { jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [ata, { encoding: "base64", dataSlice: { offset: 0, length: 0 }, commitment: "confirmed" }] }
        : { jsonrpc: "2.0", id: 1, method: "getTokenAccountsByOwner", params: [c.payTo, { mint: c.usdc }, { encoding: "base64", commitment: "confirmed" }] };
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "user-agent": "GlitterAgentGate/1.1 (+https://agents.glitterchainscout.trade)" }, signal: AbortSignal.timeout(4000), body: JSON.stringify(body) });
      const j: any = await r.json().catch(() => null);
      if (ata && j?.result && "value" in j.result) { ready = !!j.result.value && j.result.value.owner === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"; break; }
      if (!ata && Array.isArray(j?.result?.value)) { ready = j.result.value.length > 0; break; }
      console.warn("solana rail check: RPC", r.status, JSON.stringify(j?.error ?? null).slice(0, 120));
    } catch (e) { console.warn("solana rail check failed", String(e).slice(0, 120)); }
  }
  try {
    const s: any = await (await fetch((env.EVM_FACILITATOR_URL || "https://facilitator.payai.network").replace(/\/+$/, "") + "/supported", { signal: AbortSignal.timeout(4000) })).json();
    const k = (s?.kinds ?? []).find((x: any) => x.x402Version === 2 && x.scheme === "exact" && x.network === c.network);
    if (k?.extra?.feePayer) feePayer = k.extra.feePayer;
  } catch { /* fallback fee payer */ }
  solState = { key, ready, feePayer, checkedAt: Date.now() };
}
export function solanaStatus(env: Env) { const c = solConfig(env); return { ...c, ready: !!solanaRail(env), checkedAt: solState?.checkedAt ?? null }; }

export function assetSymbol(r: { asset: string }): "XRP" | "RLUSD" | "USDC" | string {
  if (r.asset === "XRP") return "XRP";
  if (r.asset === RLUSD_HEX) return "RLUSD";
  if (r.asset.startsWith("0x")) return "USDC";
  if (Object.values(USDC_MINT).includes(r.asset)) return "USDC";
  return r.asset;
}
export function amountDisplay(r: { asset: string; amount: string }): string {
  const s = assetSymbol(r);
  if (s === "XRP") return dropsToXrp(r.amount);
  if (s === "USDC" && /^\d+$/.test(r.amount)) { const n = BigInt(r.amount); const f = (n % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, ""); return `${n / 1_000_000n}${f ? "." + f : ""}`; }
  return r.amount;
}

/** Bazaar discovery extension (x402 v2 `bazaar`), generated with the official @x402/extensions helper. */
export function bazaarExtension(route: RouteDoc): Record<string, unknown> {
  const inputExample = Object.fromEntries(Object.entries(route.query ?? {}).filter(([, v]) => v.example).map(([k, v]) => [k, v.example]));
  const inputSchema = {
    properties: Object.fromEntries(Object.entries(route.query ?? {}).map(([k, v]) => [k, { type: v.type, description: v.description }])),
    required: Object.entries(route.query ?? {}).filter(([, v]) => v.required).map(([k]) => k),
  };
  const ext: any = route.method === "POST"
    ? declareDiscoveryExtension({ method: "POST", bodyType: "json", input: bodyExample(route), inputSchema: { properties: {} }, output: { example: route.outputExample } } as any)
    : declareDiscoveryExtension({ method: "GET", input: inputExample, inputSchema, output: { example: route.outputExample } } as any);
  // The helper leaves `method` for the server-side enrichment hook; we set it explicitly.
  if (ext.bazaar?.info?.input) ext.bazaar.info.input.method = route.method;
  if (route.method === "POST" && Object.keys(inputExample).length) ext.bazaar.info.input.queryParams = inputExample;
  return ext;
}
function bodyExample(route: RouteDoc): Record<string, unknown> {
  if (route.body?.description?.startsWith("{")) { try { return JSON.parse(route.body.description); } catch { /* */ } }
  return { url: "https://example.com/file.csv", format: "csv" };
}

export function resourceInfo(svc: PaidService, url: string) {
  return {
    url, name: svc.name, description: svc.description, mimeType: "application/json",
    serviceName: svc.name.replace(/[^\x20-\x7e]/g, "").slice(0, 32),
    tags: svc.tags.slice(0, 5).map((t) => t.slice(0, 32)),
  };
}

export function routeFor(svc: PaidService, subpath: string): RouteDoc {
  return svc.routes.find((r) => r.path === subpath) ?? svc.routes[0];
}

// ---------- facilitator ----------
function facilitatorUrl(env: Env, network: string): string {
  if (network.startsWith("xrpl:")) return env.FACILITATOR_URL;
  if (network.startsWith("eip155:") || network.startsWith("solana:")) return env.EVM_FACILITATOR_URL || "https://facilitator.payai.network";
  throw new HttpError(400, `unsupported network ${network}`);
}
async function facilitator(env: Env, network: string, path: "/verify" | "/settle", body: unknown) {
  const r = await fetch(facilitatorUrl(env, network).replace(/\/+$/, "") + path, {
    method: "POST", headers: { "content-type": "application/json" }, body: canonicalJson(body), signal: AbortSignal.timeout(30000),
  });
  const text = await r.text();
  let data: any; try { data = text ? JSON.parse(text) : undefined; } catch { data = undefined; }
  return { ok: r.ok, status: r.status, data, extensionResponses: r.headers.get("EXTENSION-RESPONSES") };
}

function sameRequirement(a: Requirement, b: Requirement) {
  return a.scheme === b.scheme && a.network === b.network && a.amount === b.amount && a.asset === b.asset &&
    a.payTo === b.payTo && a.maxTimeoutSeconds === b.maxTimeoutSeconds && (a.extra?.invoiceId ?? null) === (b.extra?.invoiceId ?? null);
}

function paymentRequiredResponse(body: Record<string, unknown>, status = 402): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", [HEADER_PAYMENT_REQUIRED]: b64encodeJson(body), ...corsHeaders() },
  });
}

async function logCall(env: Env, slug: string, outcome: string, status: number) {
  await env.DB.prepare("INSERT INTO call_log (service_slug, outcome, status, created_at) VALUES (?,?,?,?)").bind(slug, outcome, status, Date.now()).run().catch(() => {});
}

const route0 = (svc: PaidService) => svc.routes[0];
function payerHint(p: any): string | undefined {
  const a = p?.payload?.authorization?.from; if (typeof a === "string") return a;
  return undefined;
}
/** Every payment attempt (a request that carried PAYMENT-SIGNATURE) is recorded with its stage and outcome for the dashboard. */
export async function logAttempt(env: Env, req: Request, slug: string, a: { stage: string; outcome: string; status: number; network?: string; asset?: string; amount?: string; payer?: string; tx?: string; detail?: string }) {
  const cf: any = (req as any).cf ?? {};
  await env.DB.prepare(`INSERT INTO payment_attempts (created_at, service_slug, stage, outcome, status, network, asset, amount, payer, tx_hash, detail, user_agent, as_org, country)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(Date.now(), slug, a.stage, a.outcome, a.status, a.network ?? null, a.asset ?? null, a.amount ?? null, a.payer ?? null, a.tx ?? null,
    (a.detail ?? "").slice(0, 400) || null, (req.headers.get("user-agent") ?? "").slice(0, 200) || null, String(cf.asOrganization ?? "").slice(0, 80) || null, cf.country ?? null).run()
    .catch((e: unknown) => console.warn("attempt log failed", String(e).slice(0, 120)));
}

function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) return json({ error: e.message }, e.status);
  console.error(e);
  return json({ error: "internal_error" }, 500);
}

/** Wrap a service handler with x402. */
export async function handlePaid(req: Request, env: Env, svc: PaidService, subpath: string, publicUrl: string,
  run: (payer: string) => Promise<Response>, ctx?: ExecutionContext): Promise<Response> {
  isMainnetAllowed(env);
  const sig = req.headers.get(HEADER_PAYMENT_SIGNATURE);
  // Malformed requests are never charged. With a payment attached we reject before verify/settle (400, nothing moves).
  // Without one we still answer 402 (discovery crawlers probe bare URLs, per x402scan DISCOVERY.md) and say what's wrong.
  let inputError: string | null = null;
  try { svc.validate?.(req, subpath); } catch (e) {
    // Probe-friendly: without a payment, input problems (incl. wrong method on POST-only endpoints) still answer 402 with a hint.
    if (sig || !(e instanceof HttpError) || ![400, 405, 411, 413, 415].includes(e.status)) {
      if (sig) await logAttempt(env, req, svc.slug, { stage: "precheck", outcome: "bad_input", status: e instanceof HttpError ? e.status : 500, detail: String((e as any)?.message ?? e) });
      return errorResponse(e);
    }
    inputError = e.status === 405 ? `${e.message} (this endpoint is ${route0(svc).method}-only)` : e.message;
  }
  const route = routeFor(svc, subpath);
  await refreshSolanaRail(env);
  const ttl = Number(env.INVOICE_TTL_SECONDS || "600");

  if (!sig) {
    const invoiceId = crypto.randomUUID().replace(/-/g, "").toUpperCase();
    const accepts = buildAccepts(env, svc, invoiceId);
    const now = Date.now();
    await env.DB.prepare("INSERT INTO invoices (id, service_slug, resource, accepts_json, status, created_at, expires_at) VALUES (?,?,?,?, 'open', ?, ?)")
      .bind(invoiceId, svc.slug, publicUrl, JSON.stringify(accepts), now, now + ttl * 1000).run();
    // Opportunistic cleanup of old invoices.
    await env.DB.prepare("DELETE FROM invoices WHERE expires_at < ? AND status != 'processing'").bind(now - 3600_000).run().catch(() => {});
    await logCall(env, svc.slug, "payment_required", 402);
    return paymentRequiredResponse({
      x402Version: 2,
      error: inputError ? `invalid_input: ${inputError}. Fix the request before paying (a paid request with bad input is rejected with 400 and not charged).` : `${HEADER_PAYMENT_SIGNATURE} header is required`,
      resource: resourceInfo(svc, publicUrl), accepts, extensions: bazaarExtension(route),
    });
  }

  let payload: any;
  const reject = async (status: number, outcome: string, extra: Record<string, unknown> = {}, network?: string) => {
    await logAttempt(env, req, svc.slug, { stage: "precheck", outcome, status, network: network ?? payload?.accepted?.network, payer: payerHint(payload) });
    return json({ error: outcome, ...extra }, status);
  };
  try { payload = b64decodeJson(sig); } catch { return reject(400, "invalid_payment_signature_header"); }
  if (payload?.x402Version !== 2 || !payload.accepted) return reject(400, "invalid_x402_payload", payload?.x402Version === 1 ? { hint: "x402 v1 payloads are not accepted; use an x402 v2 client (@x402/fetch, @x402/axios, x402-xrpl)" } : {});
  const invoiceId = String(payload.payload?.invoiceId ?? payload.accepted?.extra?.invoiceId ?? "");
  if (!invoiceId) return reject(400, "missing_invoiceId", { hint: "request the endpoint first and pay one of the accepts[] from that fresh 402" });
  const inv = await env.DB.prepare("SELECT * FROM invoices WHERE id = ?").bind(invoiceId).first<any>();
  if (!inv || inv.expires_at < Date.now()) return reject(400, "unknown_or_expired_invoice");
  if (inv.service_slug !== svc.slug) return reject(400, "invoice_is_for_a_different_service");
  if (inv.status !== "open") return reject(409, "invoice_already_used");
  const stored: Requirement[] = JSON.parse(inv.accepts_json);
  const selected = stored.find((r) => sameRequirement(r, payload.accepted));
  if (!selected) return reject(402, "payment_requirements_mismatch");

  // 1) verify (read-only)
  const v = await facilitator(env, selected.network, "/verify", { x402Version: 2, paymentPayload: payload, paymentRequirements: selected });
  if (!v.ok || v.data?.isValid !== true) {
    await logCall(env, svc.slug, "verify_failed", 402);
    await logAttempt(env, req, svc.slug, { stage: "verify", outcome: "verify_failed", status: v.status, network: selected.network, asset: assetSymbol(selected), amount: amountDisplay(selected), payer: v.data?.payer ?? payerHint(payload), detail: String(v.data?.invalidReason ?? v.data?.error ?? v.status) + (v.data?.invalidMessage ? ": " + String(v.data.invalidMessage).slice(0, 200) : "") });
    if (!v.ok && v.data?.retryable === true && v.data?.phase === "verify") return json({ error: v.data.reason ?? "facilitator_unavailable", retryable: true }, 503, { "retry-after": String(v.data.retryAfter ?? 30) });
    return paymentRequiredResponse({ x402Version: 2, error: `verify_failed:${v.data?.invalidReason ?? v.data?.error ?? v.status}`, resource: resourceInfo(svc, inv.resource), accepts: stored, extensions: bazaarExtension(route) });
  }
  // 2) claim invoice atomically (prevents two concurrent requests using one payment)
  const claim = await env.DB.prepare("UPDATE invoices SET status='processing' WHERE id=? AND status='open'").bind(invoiceId).run();
  if (claim.meta.changes !== 1) return reject(409, "invoice_already_used", {}, selected.network);

  // 3) do the work
  let result: Response;
  try { result = await run(String(v.data?.payer ?? "")); } catch (e) { result = errorResponse(e); }
  if (result.status >= 400) {
    await env.DB.prepare("UPDATE invoices SET status='open' WHERE id=?").bind(invoiceId).run();
    await logCall(env, svc.slug, "handler_error", result.status);
    await logAttempt(env, req, svc.slug, { stage: "handler", outcome: "handler_error_not_charged", status: result.status, network: selected.network, asset: assetSymbol(selected), amount: amountDisplay(selected), payer: v.data?.payer });
    const h = new Headers(result.headers); h.set("x-402-charged", "false");
    return new Response(result.body, { status: result.status, headers: h });
  }
  const resultBody = await result.arrayBuffer(); // buffer so we only release it after settlement

  // 4) settle
  const s = await facilitator(env, selected.network, "/settle", { x402Version: 2, paymentPayload: payload, paymentRequirements: selected });
  if (s.extensionResponses) console.log("facilitator EXTENSION-RESPONSES:", (() => { try { return JSON.stringify(b64decodeJson(s.extensionResponses!)); } catch { return s.extensionResponses; } })());
  if (!s.ok || s.data?.success !== true) {
    const unknown = s.data?.settlementAttempted === true || /^(submit_failed:|submit_missing_tx_hash|validation_failed:)/.test(String(s.data?.errorReason ?? ""));
    await env.DB.prepare("UPDATE invoices SET status=? WHERE id=?").bind(unknown ? "processing" : "open", invoiceId).run();
    await logCall(env, svc.slug, "settle_failed", unknown ? 409 : 402);
    await logAttempt(env, req, svc.slug, { stage: "settle", outcome: unknown ? "settle_status_unknown" : "settle_failed", status: s.status, network: selected.network, asset: assetSymbol(selected), amount: amountDisplay(selected), payer: v.data?.payer, detail: String(s.data?.errorReason ?? s.data?.error ?? s.status) });
    if (unknown) return json({ error: "settlement_status_unknown", retryable: false, invoiceId, hint: "reconcile the signed tx on-ledger before paying again" }, 409);
    return paymentRequiredResponse({ x402Version: 2, error: `settle_failed:${s.data?.errorReason ?? s.status}`, resource: resourceInfo(svc, inv.resource), accepts: stored, extensions: bazaarExtension(route) });
  }

  const tx = String(s.data.transaction ?? "");
  const payer = String(s.data.payer ?? v.data.payer ?? "");
  const feeBps = svc.kind === "listed" ? Number(env.PLATFORM_FEE_BPS || "0") : 0;
  const disp = amountDisplay(selected);
  const feeOwed = feeBps ? (Number(disp) * feeBps / 10000).toFixed(8).replace(/0+$/, "").replace(/\.$/, "") : "0";
  await env.DB.batch([
    env.DB.prepare("UPDATE invoices SET status='settled' WHERE id=?").bind(invoiceId),
    env.DB.prepare(`INSERT INTO settlements (invoice_id, service_slug, provider_id, pay_to, payer, asset, asset_symbol, amount, amount_display, fee_bps, fee_owed_display, network, tx_hash, resource, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(invoiceId, svc.slug, svc.providerId, selected.payTo, payer, selected.asset, assetSymbol(selected), selected.amount, disp, feeBps, feeOwed, s.data.network ?? selected.network, tx, inv.resource, Date.now()),
  ]);
  await logCall(env, svc.slug, "paid", result.status);
  await logAttempt(env, req, svc.slug, { stage: "settle", outcome: "paid", status: result.status, network: String(s.data.network ?? selected.network), asset: assetSymbol(selected), amount: disp, payer, tx });
  notifyPayment(env, ctx, { service: svc.slug, amount: disp, asset: assetSymbol(selected), network: String(s.data.network ?? selected.network), payer, tx, at: Date.now() });
  const h = new Headers(result.headers);
  h.set(HEADER_PAYMENT_RESPONSE, b64encodeJson({ success: true, transaction: tx, network: s.data.network ?? selected.network, payer }));
  h.set("x-402-charged", "true");
  for (const [k, val] of Object.entries(corsHeaders())) h.set(k, val);
  return new Response(resultBody, { status: result.status, headers: h });
}

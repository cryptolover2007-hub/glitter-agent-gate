// x402 v2 resource-server logic for the gateway.
// Wire format follows the x402 v2 spec and the x402-xrpl 0.3.4 SDK (read from its source):
//   402 body/PAYMENT-REQUIRED = base64(canonical JSON PaymentRequired)
//   PAYMENT-SIGNATURE = base64(PaymentPayload) ; XRPL payload = { signedTxBlob, invoiceId }
//   PAYMENT-RESPONSE  = base64({ success, transaction, network, payer })
// Flow (buyer-protective AND seller-protective): verify -> run handler -> settle -> release result.
//   * handler fails  => nothing is settled, buyer is not charged, invoice re-opens.
//   * settle fails   => result is withheld (402/409), so work is never given away for free.
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
  return out;
}

export function assetSymbol(r: { asset: string }): "XRP" | "RLUSD" | "USDC" | string {
  if (r.asset === "XRP") return "XRP";
  if (r.asset === RLUSD_HEX) return "RLUSD";
  if (r.asset.startsWith("0x")) return "USDC";
  return r.asset;
}
export function amountDisplay(r: { asset: string; amount: string }): string {
  const s = assetSymbol(r);
  if (s === "XRP") return dropsToXrp(r.amount);
  if (s === "USDC") { const n = BigInt(r.amount); const f = (n % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, ""); return `${n / 1_000_000n}${f ? "." + f : ""}`; }
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
  if (network.startsWith("eip155:")) return env.EVM_FACILITATOR_URL;
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

function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) return json({ error: e.message }, e.status);
  console.error(e);
  return json({ error: "internal_error" }, 500);
}

/** Wrap a service handler with x402. */
export async function handlePaid(req: Request, env: Env, svc: PaidService, subpath: string, publicUrl: string,
  run: (payer: string) => Promise<Response>): Promise<Response> {
  isMainnetAllowed(env);
  try { svc.validate?.(req, subpath); } catch (e) { return errorResponse(e); } // never charge for a malformed request
  const route = routeFor(svc, subpath);
  const sig = req.headers.get(HEADER_PAYMENT_SIGNATURE);
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
      x402Version: 2, error: `${HEADER_PAYMENT_SIGNATURE} header is required`,
      resource: resourceInfo(svc, publicUrl), accepts, extensions: bazaarExtension(route),
    });
  }

  let payload: any;
  try { payload = b64decodeJson(sig); } catch { return json({ error: "invalid_payment_signature_header" }, 400); }
  if (payload?.x402Version !== 2 || !payload.accepted) return json({ error: "invalid_x402_payload" }, 400);
  const invoiceId = String(payload.payload?.invoiceId ?? payload.accepted?.extra?.invoiceId ?? "");
  if (!invoiceId) return json({ error: "missing_invoiceId" }, 400);
  const inv = await env.DB.prepare("SELECT * FROM invoices WHERE id = ?").bind(invoiceId).first<any>();
  if (!inv || inv.expires_at < Date.now()) return json({ error: "unknown_or_expired_invoice" }, 400);
  if (inv.service_slug !== svc.slug) return json({ error: "invoice_is_for_a_different_service" }, 400);
  if (inv.status !== "open") return json({ error: "invoice_already_used" }, 409);
  const stored: Requirement[] = JSON.parse(inv.accepts_json);
  const selected = stored.find((r) => sameRequirement(r, payload.accepted));
  if (!selected) return json({ error: "payment_requirements_mismatch" }, 402);

  // 1) verify (read-only)
  const v = await facilitator(env, selected.network, "/verify", { x402Version: 2, paymentPayload: payload, paymentRequirements: selected });
  if (!v.ok || v.data?.isValid !== true) {
    await logCall(env, svc.slug, "verify_failed", 402);
    if (!v.ok && v.data?.retryable === true && v.data?.phase === "verify") return json({ error: v.data.reason ?? "facilitator_unavailable", retryable: true }, 503, { "retry-after": String(v.data.retryAfter ?? 30) });
    return paymentRequiredResponse({ x402Version: 2, error: `verify_failed:${v.data?.invalidReason ?? v.data?.error ?? v.status}`, resource: resourceInfo(svc, inv.resource), accepts: stored, extensions: bazaarExtension(route) });
  }
  // 2) claim invoice atomically (prevents two concurrent requests using one payment)
  const claim = await env.DB.prepare("UPDATE invoices SET status='processing' WHERE id=? AND status='open'").bind(invoiceId).run();
  if (claim.meta.changes !== 1) return json({ error: "invoice_already_used" }, 409);

  // 3) do the work
  let result: Response;
  try { result = await run(String(v.data?.payer ?? "")); } catch (e) { result = errorResponse(e); }
  if (result.status >= 400) {
    await env.DB.prepare("UPDATE invoices SET status='open' WHERE id=?").bind(invoiceId).run();
    await logCall(env, svc.slug, "handler_error", result.status);
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
  const h = new Headers(result.headers);
  h.set(HEADER_PAYMENT_RESPONSE, b64encodeJson({ success: true, transaction: tx, network: s.data.network ?? selected.network, payer }));
  h.set("x-402-charged", "true");
  for (const [k, val] of Object.entries(corsHeaders())) h.set(k, val);
  return new Response(resultBody, { status: result.status, headers: h });
}

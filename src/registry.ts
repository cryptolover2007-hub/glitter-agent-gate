// Secondary feature: let other agents/developers list their own paid API behind the gateway.
// Non-custodial: buyers pay the provider's payTo directly; the gateway never holds funds.
import type { Env, PaidService } from "./types";
import { assertPublicHttpUrl, HttpError, isClassicAddress, json, randomToken, readCapped, sha256Hex, xrpToDrops } from "./util";

const SLUG = /^[a-z0-9][a-z0-9-]{2,40}$/;
const RESERVED = new Set(["web-markdown", "xrpl-data", "convert", "json-tools", "hello", "api", "admin", "dashboard"]);

export function rowToService(r: any): PaidService {
  return {
    slug: r.slug, name: r.name, description: r.description, kind: "listed", providerId: r.provider_id, payTo: r.pay_to,
    price: { xrpDrops: r.price_xrp_drops ?? undefined, rlusd: r.price_rlusd ?? undefined },
    tags: JSON.parse(r.tags_json || "[]"), upstreamUrl: r.upstream_url, upstreamSecret: r.upstream_secret, method: r.method,
    routes: [{ path: "", method: r.method === "POST" ? "POST" : "GET", summary: r.name }],
  };
}
export async function listedServices(env: Env): Promise<PaidService[]> {
  const { results } = await env.DB.prepare("SELECT * FROM listed_services WHERE active = 1 ORDER BY created_at").all();
  return (results ?? []).map(rowToService);
}
export async function getListed(env: Env, slug: string): Promise<PaidService | null> {
  const r = await env.DB.prepare("SELECT * FROM listed_services WHERE slug = ? AND active = 1").bind(slug).first();
  return r ? rowToService(r) : null;
}

async function authProvider(req: Request, env: Env): Promise<string | null> {
  const key = req.headers.get("x-provider-key");
  if (!key) return null;
  const row = await env.DB.prepare("SELECT id FROM providers WHERE key_hash = ?").bind(await sha256Hex(key)).first<any>();
  return row?.id ?? null;
}

export async function registerService(req: Request, env: Env): Promise<Response> {
  if (env.REGISTRATION_MODE === "closed") throw new HttpError(403, "registration is closed");
  if (env.REGISTRATION_MODE !== "open") {
    const tok = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!env.REGISTRY_ADMIN_TOKEN || tok !== env.REGISTRY_ADMIN_TOKEN) throw new HttpError(401, "admin token required to register (REGISTRATION_MODE=admin)");
  }
  const b: any = JSON.parse(new TextDecoder().decode(await readCapped(req.body, 32_000)) || "{}");
  const slug = String(b.slug ?? "").toLowerCase();
  if (!SLUG.test(slug) || RESERVED.has(slug)) throw new HttpError(400, "slug must be 3-41 chars [a-z0-9-] and not reserved");
  const name = String(b.name ?? "").slice(0, 80);
  const description = String(b.description ?? "").slice(0, 1000);
  if (!name || !description) throw new HttpError(400, "name and description are required");
  const up = assertPublicHttpUrl(String(b.upstream_url ?? ""), env.ALLOW_HTTP_UPSTREAM === "true");
  const payTo = String(b.pay_to ?? "");
  if (!isClassicAddress(payTo)) throw new HttpError(400, "pay_to must be an XRPL classic address");
  const priceDrops = b.price_xrp ? xrpToDrops(String(b.price_xrp)) : null;
  const priceRlusd = b.price_rlusd ? String(b.price_rlusd) : null;
  if (priceRlusd && !/^\d+(\.\d{1,15})?$/.test(priceRlusd)) throw new HttpError(400, "price_rlusd must be a decimal string");
  if (!priceDrops && !priceRlusd) throw new HttpError(400, "set price_xrp and/or price_rlusd");
  const method = b.method === "POST" ? "POST" : "GET";
  const tags = Array.isArray(b.tags) ? b.tags.slice(0, 5).map((t: unknown) => String(t).slice(0, 32)) : [];

  let providerId = await authProvider(req, env);
  let providerKey: string | null = null;
  if (!providerId) {
    providerId = "p_" + randomToken(8);
    providerKey = "pk_" + randomToken(24);
    await env.DB.prepare("INSERT INTO providers (id, name, key_hash, created_at) VALUES (?,?,?,?)").bind(providerId, String(b.provider_name ?? name).slice(0, 80), await sha256Hex(providerKey), Date.now()).run();
  }
  const existing = await env.DB.prepare("SELECT provider_id FROM listed_services WHERE slug = ?").bind(slug).first<any>();
  if (existing && existing.provider_id !== providerId) throw new HttpError(409, "slug taken");
  const upstreamSecret = "us_" + randomToken(24);
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO listed_services (slug, provider_id, name, description, upstream_url, method, price_xrp_drops, price_rlusd, pay_to, tags_json, upstream_secret, active, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?) ON CONFLICT(slug) DO UPDATE SET name=excluded.name, description=excluded.description, upstream_url=excluded.upstream_url, method=excluded.method,
    price_xrp_drops=excluded.price_xrp_drops, price_rlusd=excluded.price_rlusd, pay_to=excluded.pay_to, tags_json=excluded.tags_json, upstream_secret=excluded.upstream_secret, active=1, updated_at=excluded.updated_at`)
    .bind(slug, providerId, name, description, up.toString(), method, priceDrops, priceRlusd, payTo, JSON.stringify(tags), upstreamSecret, now, now).run();
  return json({
    ok: true, slug, providerId,
    providerKey: providerKey ?? "(unchanged; you authenticated with x-provider-key)",
    upstreamSecret,
    note: "Store providerKey and upstreamSecret now; they are not shown again. Your upstream receives header X-Gateway-Secret: <upstreamSecret> on every paid call — reject requests without it. Make sure pay_to has an RLUSD trust line if you price in RLUSD.",
    callUrl: `/s/${slug}`,
  }, 201);
}

export async function deactivateService(req: Request, env: Env, slug: string): Promise<Response> {
  const pid = await authProvider(req, env);
  if (!pid) throw new HttpError(401, "x-provider-key required");
  const r = await env.DB.prepare("UPDATE listed_services SET active = 0, updated_at = ? WHERE slug = ? AND provider_id = ?").bind(Date.now(), slug, pid).run();
  if (r.meta.changes !== 1) throw new HttpError(404, "not found");
  return json({ ok: true, slug, active: false });
}

/** Proxy a paid request to the provider's upstream. Called only after payment verification. */
export async function proxyUpstream(req: Request, env: Env, svc: PaidService, subpath: string, payer: string): Promise<Response> {
  const base = new URL(svc.upstreamUrl!);
  const inUrl = new URL(req.url);
  const target = new URL(base.toString().replace(/\/+$/, "") + subpath + inUrl.search);
  assertPublicHttpUrl(target.toString(), env.ALLOW_HTTP_UPSTREAM === "true");
  const headers = new Headers();
  for (const k of ["content-type", "accept", "accept-language"]) { const v = req.headers.get(k); if (v) headers.set(k, v); }
  headers.set("x-gateway-secret", svc.upstreamSecret!);
  headers.set("x-x402-service", svc.slug);
  if (payer) headers.set("x-x402-payer", payer);
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readCapped(req.body, 5 * 1024 * 1024);
  const r = await fetch(target.toString(), { method: req.method, headers, body, redirect: "manual", signal: AbortSignal.timeout(30000) });
  const out = await readCapped(r.body, 10 * 1024 * 1024);
  const h = new Headers();
  h.set("content-type", r.headers.get("content-type") ?? "application/octet-stream");
  return new Response(out, { status: r.status >= 300 && r.status < 400 ? 502 : r.status, headers: h });
}

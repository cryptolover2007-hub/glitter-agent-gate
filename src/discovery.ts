// Machine-readable discovery: service catalog, x402 Bazaar-format listing, /.well-known/x402 (XRPL AI Hub crawl),
// A2A Agent Card, llms.txt and OpenAPI. Prices are advertised for network xrpl (XRP, RLUSD) and, if enabled, Base USDC.
import type { Env, PaidService } from "./types";
import { amountDisplay, assetSymbol, bazaarExtension, buildAccepts, resourceInfo } from "./x402";
import { json } from "./util";

export const VERSION = "0.1.0";
const urlFor = (origin: string, svc: PaidService, path: string) => `${origin}/s/${svc.slug}${path}`;
/** Probe-able URL for crawlers: routes with required query params get their documented example values, so a bare GET returns the 402 instead of a 400. */
const probeUrlFor = (origin: string, svc: PaidService, r: { path: string; query?: Record<string, { required?: boolean; example?: string }> }) => {
  const req = Object.entries(r.query ?? {}).filter(([, q]) => q.required && q.example);
  return urlFor(origin, svc, r.path) + (req.length ? "?" + new URLSearchParams(req.map(([k, q]) => [k, String(q.example)])).toString() : "");
};

function priceList(env: Env, svc: PaidService) {
  return buildAccepts(env, svc, null).map((r) => ({ network: r.network, asset: assetSymbol(r), assetId: r.asset, amount: r.amount, amountDisplay: amountDisplay(r), payTo: r.payTo, issuer: (r.extra as any)?.issuer }));
}

export function servicesCatalog(env: Env, origin: string, services: PaidService[]) {
  return {
    gateway: env.GATEWAY_NAME, version: VERSION, x402Version: 2,
    networks: { xrpl: env.X402_NETWORK, base: env.BASE_PAY_TO ? env.BASE_NETWORK : null },
    howToPay: "Call any endpoint. You get HTTP 402 with a PAYMENT-REQUIRED header (base64 JSON, x402 v2). Sign one of the accepts[] options (XRPL: presigned Payment via the x402-xrpl SDK) and retry with PAYMENT-SIGNATURE. Success returns PAYMENT-RESPONSE with the tx hash. Failed calls are not charged.",
    services: services.map((s) => ({
      slug: s.slug, name: s.name, description: s.description, kind: s.kind, tags: s.tags,
      prices: priceList(env, s),
      endpoints: s.routes.map((r) => ({ url: urlFor(origin, s, r.path), method: r.method, summary: r.summary, query: r.query ?? {}, body: r.body ?? null, outputExample: r.outputExample ?? null })),
    })),
  };
}

/** x402 v2 spec §8.1 GET /discovery/resources (Bazaar list shape). */
export function discoveryResources(env: Env, origin: string, services: PaidService[], q: URLSearchParams) {
  const items = services.flatMap((s) => s.routes.map((r) => ({
    resource: urlFor(origin, s, r.path), type: "http", x402Version: 2,
    accepts: buildAccepts(env, s, null),
    lastUpdated: new Date().toISOString(),
    metadata: resourceInfo(s, urlFor(origin, s, r.path)),
    extensions: bazaarExtension(r),
  }))).filter((i) => (!q.get("network") || i.accepts.some((a) => a.network === q.get("network"))) && (!q.get("payTo") || i.accepts.some((a) => a.payTo === q.get("payTo"))));
  const limit = Math.min(Math.max(Number(q.get("limit") ?? 20), 1), 100);
  const offset = Math.max(Number(q.get("offset") ?? 0), 0);
  return { x402Version: 2, items: items.slice(offset, offset + limit), pagination: { limit, offset, total: items.length } };
}

/** /.well-known/x402 fan-out catalog.
 * `resources` is a list of URL strings (x402scan DISCOVERY.md minimal format; XRPL AI Hub crawls it hourly and probes each URL,
 * reading name/description from the 402 response). `resourceDetails` repeats them with names/prices for humans and richer crawlers. */
export function wellKnownX402(env: Env, origin: string, services: PaidService[]) {
  const all = services.flatMap((s) => s.routes.map((r) => ({ s, r })));
  return {
    version: 1, x402Version: 2,
    name: env.GATEWAY_NAME,
    description: "Pay-per-call tools for AI agents: web page to Markdown, XRPL/crypto data, file conversion and JSON utilities. Pay in XRP or RLUSD on the XRP Ledger via x402.",
    resources: all.map(({ s, r }) => probeUrlFor(origin, s, r)),
    resourceDetails: all.map(({ s, r }) => ({
      url: probeUrlFor(origin, s, r), method: r.method, name: `${s.name}${r.path ? " " + r.path : ""}`, description: `${s.description} ${r.summary}.`,
      accepts: buildAccepts(env, s, null).map((a) => ({ network: a.network, asset: assetSymbol(a), amount: a.amount, amountDisplay: amountDisplay(a), payTo: a.payTo })),
    })),
    instructions: `Call any resource, pay the 402 (x402 v2, exact scheme) in XRP or RLUSD on ${env.X402_NETWORK}, retry with PAYMENT-SIGNATURE. Docs: ${origin}/llms.txt`,
  };
}

/** A2A Agent Card (A2A spec v1.0 AgentCard: name, description, supportedInterfaces, version, capabilities, default modes, skills). */
export function agentCard(env: Env, origin: string, services: PaidService[]) {
  return {
    name: env.GATEWAY_NAME,
    description: "Paid tool endpoints for AI agents, settled per call with x402 on the XRP Ledger (XRP or RLUSD). Skills are plain HTTPS endpoints; the A2A interface returns call instructions and prices.",
    supportedInterfaces: [{ url: `${origin}/a2a`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
    provider: { organization: "Glitter Chain Scout", url: env.CONTACT_URL || origin },
    version: VERSION,
    documentationUrl: `${origin}/llms.txt`,
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
    defaultInputModes: ["application/json", "text/plain"],
    defaultOutputModes: ["application/json"],
    skills: services.map((s) => ({
      id: s.slug, name: s.name,
      description: `${s.description} Price per call: ${priceList(env, s).map((p) => `${p.amountDisplay} ${p.asset}`).join(" or ")}. Endpoint: ${urlFor(origin, s, s.routes[0].path)} (x402).`,
      tags: s.tags, examples: s.routes.map((r) => `${r.method} ${urlFor(origin, s, r.path)}`),
      inputModes: s.routes.some((r) => r.method === "POST") ? ["application/json", "application/octet-stream"] : ["application/json"],
      outputModes: ["application/json"],
    })),
  };
}

/** Minimal A2A JSON-RPC: SendMessage (v1.0) / message/send (v0.3). Answers with how to call + price; payment happens over HTTP x402. */
export async function a2aRpc(req: Request, env: Env, origin: string, services: PaidService[]): Promise<Response> {
  let rpc: any;
  try { rpc = await req.json(); } catch { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
  if (!["SendMessage", "message/send"].includes(rpc?.method)) return json({ jsonrpc: "2.0", id: rpc?.id ?? null, error: { code: -32601, message: "Method not found (supported: SendMessage)" } });
  const parts = rpc.params?.message?.parts ?? [];
  const text = parts.map((p: any) => p.text ?? JSON.stringify(p.data ?? "")).join(" ").toLowerCase();
  const match = services.filter((s) => text.includes(s.slug) || s.tags.some((t) => text.includes(t)));
  const chosen = match.length ? match : services;
  return json({
    jsonrpc: "2.0", id: rpc.id ?? null,
    result: { message: {
      role: "ROLE_AGENT", messageId: crypto.randomUUID(),
      parts: [
        { text: `These skills are paid per call via x402 over HTTPS. Call the endpoint, pay the 402 in XRP or RLUSD on ${env.X402_NETWORK}, retry with PAYMENT-SIGNATURE.` },
        { data: { services: servicesCatalog(env, origin, chosen).services } },
      ],
    } },
  });
}

export function llmsTxt(env: Env, origin: string, services: PaidService[]): string {
  const lines = [
    `# ${env.GATEWAY_NAME}`, "",
    "> Pay-per-call tools for AI agents. No API keys or accounts: every endpoint uses x402 (HTTP 402). Pay in XRP or RLUSD on the XRP Ledger" + (env.BASE_PAY_TO ? " or USDC on Base" : "") + ". Calls that fail are not charged.", "",
    `Network: ${env.X402_NETWORK}${env.X402_NETWORK === "xrpl:1" ? " (TESTNET - test funds only)" : ""}. Facilitator: t54 (${env.FACILITATOR_URL}).`, "",
    "## How to pay",
    "1. Request an endpoint. You receive 402 + PAYMENT-REQUIRED (base64 JSON, x402 v2) with accepts[] options and an invoiceId.",
    "2. Sign a presigned XRPL Payment for one option (npm/PyPI package `x402-xrpl`: x402Fetch / x402Purchase do this automatically).",
    "3. Retry with header PAYMENT-SIGNATURE. Success returns 200 + PAYMENT-RESPONSE (tx hash).", "",
    "## Services",
    ...services.flatMap((s) => [
      `### ${s.name} (${s.slug})`, s.description,
      `Price: ${priceList(env, s).map((p) => `${p.amountDisplay} ${p.asset} (${p.network})`).join(" | ")}`,
      ...s.routes.map((r) => `- ${r.method} ${urlFor(origin, s, r.path)} — ${r.summary}${r.query ? "; query: " + Object.entries(r.query).map(([k, v]) => `${k}${v.required ? "*" : ""}`).join(", ") : ""}`), "",
    ]),
    "## Machine-readable",
    `- Catalog: ${origin}/services`, `- x402 discovery (Bazaar format): ${origin}/discovery/resources`, `- x402 catalog: ${origin}/.well-known/x402`,
    `- OpenAPI: ${origin}/openapi.json`, `- A2A Agent Card: ${origin}/.well-known/agent-card.json`, "",
  ];
  return lines.join("\n");
}

export function openapi(env: Env, origin: string, services: PaidService[]) {
  const paths: Record<string, any> = {};
  for (const s of services) for (const r of s.routes) {
    const op: any = {
      operationId: `${s.slug}${r.path.replace(/\W+/g, "_")}`, summary: `${s.name}: ${r.summary}`, description: s.description, tags: [s.slug],
      parameters: Object.entries(r.query ?? {}).map(([name, q]) => ({ name, in: "query", required: !!q.required, description: q.description, schema: { type: q.type }, example: q.example })),
      // x402scan reads x-payment-info.protocols + price (USD); accepts lists the real on-chain options.
      "x-payment-info": { protocols: [{ x402: { x402Version: 2, schemes: ["exact"] } }], price: { mode: "fixed", currency: "USD", amount: s.price.usdc ?? s.price.rlusd ?? "0" }, x402Version: 2, accepts: priceList(env, s) },
      responses: {
        "200": { description: "Paid result. PAYMENT-RESPONSE header carries the settlement tx.", content: { "application/json": { example: r.outputExample ?? {} } } },
        "402": { description: "Payment required. PAYMENT-REQUIRED header (base64 x402 v2 PaymentRequired).", headers: { "PAYMENT-REQUIRED": { schema: { type: "string" } } } },
        "400": { description: "Invalid input (checked before payment; never charged)" },
      },
    };
    if (r.body) op.requestBody = { required: true, description: r.body.description, content: Object.fromEntries(r.body.contentTypes.map((c) => [c, { schema: c.includes("json") ? { type: "object" } : { type: "string", format: "binary" } }])) };
    paths[`/s/${s.slug}${r.path}`] = { [r.method.toLowerCase()]: op };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: env.GATEWAY_NAME, version: VERSION,
      description: "x402 pay-per-call endpoints for AI agents. No API keys or accounts: call, receive 402 + PAYMENT-REQUIRED, pay, retry with PAYMENT-SIGNATURE.",
      contact: { name: "Glitter Chain Scout", url: env.CONTACT_URL || origin },
      license: { name: "MIT", identifier: "MIT" },
      "x-guidance": `Every /s/* route is paid per call with x402 v2 (exact scheme). Options in each 402: XRP or RLUSD on ${env.X402_NETWORK} (t54 facilitator) and USDC on ${env.BASE_NETWORK || "Base"}. Failed calls are not charged; bad input is rejected before settlement. Prices: ${origin}/services. Guide: ${origin}/llms.txt`,
    },
    servers: [{ url: origin }],
    paths,
  };
}

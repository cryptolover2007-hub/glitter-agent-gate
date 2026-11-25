// Hosted MCP server (Streamable HTTP, JSON responses) at /mcp. Every GET route of a first-party service is a tool.
// Payment uses the x402 MCP convention: an unpaid tools/call returns the requirements (structuredContent and
// _meta["x402/error"]); the client pays and retries with params._meta["x402/payment"] (v2 PaymentPayload, or v1).
// Calls run through the same /s/* handler, so pricing, verify -> run -> settle and "failed calls are not charged" are identical.
import type { Env, PaidService } from "./types";
import { b64decodeJson, b64encodeJson } from "./x402";
import { corsHeaders, readCapped } from "./util";

const PROTOCOL = "2025-06-18";
const MAX_BATCH = 10, MAX_BODY = 64 * 1024;
const out = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", ...corsHeaders(), "access-control-expose-headers": "mcp-session-id" } });
const ok = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
const err = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
const toolName = (slug: string, path: string) => (slug + (path ? "_" + path.replace(/^\//, "").replace(/[^a-z0-9]+/gi, "_") : "")).replace(/-/g, "_").slice(0, 64);

function tools(services: PaidService[]) {
  return services.filter((s) => s.kind === "own").flatMap((s) => s.routes.filter((r) => r.method === "GET").map((r) => {
    const properties: Record<string, unknown> = {}, required: string[] = [];
    for (const [k, v] of Object.entries(r.query ?? {})) { properties[k] = { type: v.type === "number" ? "number" : "string", description: v.description, ...(v.example ? { examples: [v.example] } : {}) }; if (v.required) required.push(k); }
    return { name: toolName(s.slug, r.path), title: `${s.name}${r.path ? ": " + r.summary : ""}`,
      description: `${r.summary}. ${s.description} Price per call: ${s.price.usdc} USDC (Base/Solana) or ${s.price.rlusd} RLUSD / XRP on the XRP Ledger, paid with x402.`,
      inputSchema: { type: "object", properties, required }, annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: { "x402/price": { usdc: s.price.usdc, rlusd: s.price.rlusd, xrpDrops: s.price.xrpDrops } }, slug: s.slug, path: r.path };
  }));
}

export async function handleMcp(req: Request, env: Env, origin: string, services: PaidService[], call: (r: Request) => Promise<Response>): Promise<Response> {
  if (req.method === "GET") return out({ name: "glitter-agent-gate", transport: "streamable-http", endpoint: `${origin}/mcp`, protocolVersion: PROTOCOL, payments: "x402 in _meta[\"x402/payment\"]", tools: tools(services).map((t) => t.name) });
  if (req.method !== "POST") return out(err(null, -32600, "use POST"), 405);
  let msg: any;
  try { msg = JSON.parse(new TextDecoder().decode(await readCapped(req.body, MAX_BODY))); } catch { return out(err(null, -32700, "parse error (or body over 64 KB)"), 400); }
  if (Array.isArray(msg)) {
    if (msg.length > MAX_BATCH) return out(err(null, -32600, `batch too large (max ${MAX_BATCH})`), 400);
    const res = (await Promise.all(msg.map((m) => one(m, req, origin, services, call)))).filter(Boolean);
    return res.length ? out(res) : new Response(null, { status: 202, headers: corsHeaders() });
  }
  const r = await one(msg, req, origin, services, call);
  return r ? out(r) : new Response(null, { status: 202, headers: corsHeaders() });
}

async function one(m: any, req: Request, origin: string, services: PaidService[], call: (r: Request) => Promise<Response>) {
  const { id, method, params = {} } = m ?? {};
  if (id === undefined || id === null) return null; // notifications
  if (method === "initialize") return ok(id, { protocolVersion: PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "glitter-agent-gate", title: "Glitter Agent Gate", version: "1.2.0" },
    instructions: "Pay-per-call tools: Base and XRPL token safety, honeypot/tax simulation, XRPL pre-send checks, Base and XRPL on-chain data, web page Markdown and summaries. Call a tool without payment to get its x402 requirements, then retry with params._meta[\"x402/payment\"]. Failed calls are not charged." });
  if (method === "ping") return ok(id, {});
  if (method === "tools/list") return ok(id, { tools: tools(services).map(({ slug, path, ...t }) => t) });
  if (method === "resources/list") return ok(id, { resources: [] });
  if (method === "prompts/list") return ok(id, { prompts: [] });
  if (method !== "tools/call") return err(id, -32601, "method not found: " + method);
  const tool = tools(services).find((t) => t.name === params.name);
  if (!tool) return err(id, -32602, "unknown tool: " + params.name);
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params.arguments ?? {})) if (v != null && v !== "" && k in (tool.inputSchema.properties as object)) qs.set(k, String(v));
  const headers = new Headers({ "user-agent": (req.headers.get("user-agent") ?? "mcp-client").slice(0, 150) + " via-mcp", accept: "application/json" });
  const pay = params._meta?.["x402/payment"];
  if (pay) {
    let p: any; try { p = typeof pay === "string" ? b64decodeJson(pay) : pay; } catch { return err(id, -32602, "x402/payment must be a PaymentPayload object or base64 JSON"); }
    headers.set(p?.x402Version === 1 ? "x-payment" : "payment-signature", typeof pay === "string" ? pay : b64encodeJson(pay));
  }
  const inner = new Request(`${origin}/s/${tool.slug}${tool.path}${qs.size ? "?" + qs : ""}`, { headers });
  Object.defineProperty(inner, "cf", { value: (req as any).cf });
  const res = await call(inner);
  const text = await res.text(); let data: any = null; try { data = JSON.parse(text); } catch { /* not json */ }
  if (res.status === 402) {
    let reqs = data; const h = res.headers.get("payment-required"); if (h) { try { reqs = b64decodeJson(h); } catch { /* body */ } }
    return ok(id, { isError: true, content: [{ type: "text", text: `Payment required: ${tool._meta["x402/price"].usdc} USDC (or XRP/RLUSD). Pay with x402 and retry with params._meta["x402/payment"]. ${reqs?.error ?? ""}`.trim() }], structuredContent: reqs, _meta: { "x402/error": reqs } });
  }
  const meta: Record<string, unknown> = {}; const pr = res.headers.get("payment-response") ?? res.headers.get("x-payment-response"); if (pr) { try { meta["x402/payment-response"] = b64decodeJson(pr); } catch { meta["x402/payment-response"] = pr; } }
  if (res.status >= 400) return ok(id, { isError: true, content: [{ type: "text", text: `Error ${res.status} (not charged): ${data?.error ?? text.slice(0, 400)}` }], _meta: meta });
  return ok(id, { content: [{ type: "text", text: data ? JSON.stringify(data, null, 2) : text }], ...(data && typeof data === "object" && !Array.isArray(data) ? { structuredContent: data } : {}), _meta: meta });
}

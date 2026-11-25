export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders(), ...headers },
  });
}
export function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, payment-signature, x-payment, authorization, mcp-session-id, mcp-protocol-version",
    "access-control-expose-headers": "payment-required, payment-response, x-payment-response, x-402-charged, x-correlation-id",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  };
}
export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export function dropsToXrp(drops: string): string {
  const n = BigInt(drops);
  const whole = n / 1_000_000n;
  const frac = (n % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}
export function xrpToDrops(xrp: string): string {
  if (!/^\d+(\.\d{1,6})?$/.test(xrp)) throw new HttpError(400, "invalid XRP amount (max 6 decimals)");
  const [w, f = ""] = xrp.split(".");
  return (BigInt(w) * 1_000_000n + BigInt(f.padEnd(6, "0"))).toString();
}
export function isClassicAddress(a: string): boolean {
  return /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(a);
}
export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export function randomToken(bytes = 24): string {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}
/** Basic SSRF guard for user-supplied URLs. Workers can't reach private networks in production,
 * but local dev can, so we block obvious internal targets either way. */
export function assertPublicHttpUrl(raw: string, allowHttp = false): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new HttpError(400, "invalid url"); }
  if (u.protocol !== "https:" && !(allowHttp && u.protocol === "http:")) throw new HttpError(400, "url must be https");
  if (u.username || u.password) throw new HttpError(400, "credentials in url not allowed");
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const blocked =
    h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") ||
    /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) ||
    h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80") || /^\d+$/.test(h) || h.startsWith("0x");
  if (blocked && !allowHttp) throw new HttpError(400, "private or local addresses are not allowed");
  if (u.port && !["80", "443", ""].includes(u.port) && !allowHttp) throw new HttpError(400, "non-standard ports are not allowed");
  return u;
}
/** Read a body with a hard size cap. */
export async function readCapped(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel(); throw new HttpError(413, `payload exceeds ${max} bytes`); }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}

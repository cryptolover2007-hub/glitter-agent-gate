// Base (EVM) JSON-RPC with keyless public fallbacks. Node problems throw HttpError(502), so the paid call is never settled.
import type { Env } from "../types";
import { HttpError } from "../util";

export const BASE_RPCS = ["https://mainnet.base.org", "https://base.drpc.org", "https://1rpc.io/base", "https://base.meowrpc.com", "https://base-rpc.publicnode.com"];
export const WETH = "0x4200000000000000000000000000000000000006";
export const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
export const isEvmAddr = (a: string | null | undefined): a is string => /^0x[0-9a-fA-F]{40}$/.test(a ?? "");
export const pad32 = (a: string) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
export const addrFromWord = (w: string | null) => (w && w.length >= 66 ? "0x" + w.slice(-40) : null);
export const isZero = (a: string | null) => !a || /^0x0*$/.test(a);

/** Error a node returns for a deterministic revert (no point retrying another node). */
class RevertError extends Error {}

export async function rpc(env: Env, method: string, params: unknown[], timeoutMs = 10000): Promise<any> {
  const urls = [env.BASE_RPC_URL, ...BASE_RPCS].filter(Boolean) as string[];
  let last = "";
  for (const url of urls) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) { last = `${new URL(url).host} HTTP ${r.status}`; continue; }
      const d: any = await r.json();
      if (d.error) {
        const msg = String(d.error.message ?? "");
        if (/revert|execution reverted/i.test(msg) || d.error.code === 3) throw new RevertError(msg);
        last = `${new URL(url).host}: ${msg.slice(0, 80)}`; continue; // rate limits, range limits, unsupported: next node
      }
      if (!("result" in d)) { last = `${new URL(url).host}: no result`; continue; }
      return d.result;
    } catch (e) {
      if (e instanceof RevertError) throw e;
      last = `${new URL(url).host}: ${String((e as any)?.message ?? e).slice(0, 60)}`;
    }
  }
  throw new HttpError(502, `Base RPC nodes unavailable (${last}); not charged`);
}
/** eth_call that returns null on revert (missing function etc.) but still throws 502 when every node is down. */
export async function ethCall(env: Env, to: string, data: string, overrides?: Record<string, unknown>, gas?: string): Promise<string | null> {
  try {
    const tx: Record<string, string> = { to, data }; if (gas) tx.gas = gas;
    const r = await rpc(env, "eth_call", overrides ? [tx, "latest", overrides] : [tx, "latest"], 15000);
    return r === "0x" ? null : r;
  } catch (e) { if (e instanceof RevertError) return null; throw e; }
}
export const word = (hex: string | null, i = 0) => (hex && hex.length >= 2 + 64 * (i + 1) ? "0x" + hex.slice(2 + 64 * i, 2 + 64 * (i + 1)) : null);
export const toBig = (hex: string | null) => (hex ? BigInt(hex) : null);
export function decodeString(hex: string | null): string | null {
  if (!hex) return null; const h = hex.slice(2);
  try {
    if (h.length === 64) { const s = new TextDecoder().decode(Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)).filter(Boolean))); return s || null; }
    const off = parseInt(h.slice(0, 64), 16) * 2, len = parseInt(h.slice(off, off + 64), 16);
    if (len > 200) return null;
    return new TextDecoder().decode(Uint8Array.from((h.slice(off + 64, off + 64 + len * 2).match(/../g) ?? []).map((x) => parseInt(x, 16)))) || null;
  } catch { return null; }
}
export const units = (v: bigint | null, d: number | null) => (v == null ? null : Number(v) / 10 ** (d ?? 0));

export async function erc20Info(env: Env, a: string) {
  const [name, symbol, dec, sup] = await Promise.all(["0x06fdde03", "0x95d89b41", "0x313ce567", "0x18160ddd"].map((s) => ethCall(env, a, s)));
  const decimals = dec ? Number(BigInt(dec)) : null;
  return { address: a, name: decodeString(name), symbol: decodeString(symbol), decimals, totalSupply: units(toBig(sup), decimals) };
}
export async function balanceOf(env: Env, token: string, who: string): Promise<bigint> {
  return toBig(await ethCall(env, token, "0x70a08231" + pad32(who))) ?? 0n;
}

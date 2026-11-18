// XRPL + crypto data aggregator: clean JSON from public XRPL nodes and CoinGecko's public API.
import type { Env } from "../types";
import { HttpError, isClassicAddress, json, dropsToXrp } from "../util";

const RLUSD_HEX = "524C555344000000000000000000000000000000";
const KNOWN_ISSUERS: Record<string, Record<string, string>> = {
  mainnet: { RLUSD: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De" },
  testnet: { RLUSD: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV" },
};

function rpcUrl(env: Env, network: string) {
  return network === "testnet" ? env.XRPL_RPC_TESTNET : env.XRPL_RPC_MAINNET;
}
async function rpc(env: Env, network: string, method: string, params: Record<string, unknown>): Promise<any> {
  const r = await fetch(rpcUrl(env, network), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, params: [params] }),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new HttpError(502, `XRPL node HTTP ${r.status}`);
  const j: any = await r.json();
  if (j.result?.status === "error") {
    if (j.result.error === "actNotFound") throw new HttpError(404, "account not found on this network");
    throw new HttpError(502, `XRPL error: ${j.result.error}`);
  }
  return j.result;
}
function currencyCode(sym: string): string {
  const s = sym.trim();
  if (/^[0-9A-Fa-f]{40}$/.test(s)) return s.toUpperCase();
  if (s.length === 3) return s.toUpperCase();
  const hex = [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  if (hex.length > 40) throw new HttpError(400, "currency symbol too long");
  return hex.padEnd(40, "0");
}
function displayCurrency(code: string): string {
  if (code.length !== 40) return code;
  const bytes = code.match(/../g)!.map((h) => parseInt(h, 16)).filter((b) => b !== 0);
  const s = new TextDecoder().decode(new Uint8Array(bytes));
  return /^[\x20-\x7e]+$/.test(s) ? s : code;
}
const rippleEpoch = (t: number) => new Date((t + 946684800) * 1000).toISOString();

function network(q: URLSearchParams) {
  const n = (q.get("network") ?? "mainnet").toLowerCase();
  if (n !== "mainnet" && n !== "testnet") throw new HttpError(400, "network must be mainnet or testnet");
  return n;
}

async function account(env: Env, q: URLSearchParams) {
  const address = q.get("address") ?? "";
  if (!isClassicAddress(address)) throw new HttpError(400, "invalid or missing ?address=");
  const net = network(q);
  const [info, lines, txs, server] = await Promise.all([
    rpc(env, net, "account_info", { account: address, ledger_index: "validated" }),
    rpc(env, net, "account_lines", { account: address, ledger_index: "validated", limit: 100 }),
    rpc(env, net, "account_tx", { account: address, limit: 10 }),
    rpc(env, net, "server_state", {}),
  ]);
  const a = info.account_data;
  const v = server.state?.validated_ledger ?? {};
  const base = BigInt(v.reserve_base ?? 1_000_000);
  const inc = BigInt(v.reserve_inc ?? 200_000);
  const reserve = base + inc * BigInt(a.OwnerCount ?? 0);
  const bal = BigInt(a.Balance);
  return {
    network: net,
    address,
    balanceXrp: dropsToXrp(a.Balance),
    reserveXrp: dropsToXrp(reserve.toString()),
    spendableXrp: dropsToXrp((bal > reserve ? bal - reserve : 0n).toString()),
    ownerCount: a.OwnerCount,
    sequence: a.Sequence,
    domain: a.Domain ? new TextDecoder().decode(new Uint8Array(a.Domain.match(/../g).map((h: string) => parseInt(h, 16)))) : null,
    flags: info.account_flags ?? null,
    trustLines: (lines.lines ?? []).map((l: any) => ({
      currency: displayCurrency(l.currency), currencyCode: l.currency, issuer: l.account, balance: l.balance, limit: l.limit,
    })),
    recentTransactions: (txs.transactions ?? []).map((t: any) => {
      const tx = t.tx_json ?? t.tx ?? {};
      return {
        hash: t.hash ?? tx.hash, type: tx.TransactionType, result: t.meta?.TransactionResult,
        from: tx.Account, to: tx.Destination ?? null, ledger: t.ledger_index ?? tx.ledger_index,
        date: tx.date != null ? rippleEpoch(tx.date) : null,
      };
    }),
    ledgerIndex: info.ledger_index,
    fetchedAt: new Date().toISOString(),
  };
}

async function token(env: Env, q: URLSearchParams) {
  const net = network(q);
  const sym = q.get("currency") ?? "RLUSD";
  const issuer = q.get("issuer") ?? KNOWN_ISSUERS[net][sym.toUpperCase()];
  if (!issuer || !isClassicAddress(issuer)) throw new HttpError(400, "missing/invalid ?issuer= (known: RLUSD)");
  const code = currencyCode(sym);
  const [info, gb] = await Promise.all([
    rpc(env, net, "account_info", { account: issuer, ledger_index: "validated" }),
    rpc(env, net, "gateway_balances", { account: issuer, ledger_index: "validated", strict: true }),
  ]);
  let amm: any = null;
  try {
    const r = await rpc(env, net, "amm_info", { asset: { currency: "XRP" }, asset2: { currency: code, issuer }, ledger_index: "validated" });
    const xrp = Number(r.amm.amount) / 1e6;
    const tok = Number(r.amm.amount2.value);
    amm = { account: r.amm.account, xrpReserve: xrp, tokenReserve: tok, tradingFeeBps: r.amm.trading_fee / 10, spotPriceXrpPerToken: tok ? xrp / tok : null };
  } catch { amm = null; }
  const supply = gb.obligations?.[code] ?? null;
  return {
    network: net, currency: displayCurrency(code), currencyCode: code, issuer,
    circulatingSupply: supply,
    issuerFlags: info.account_flags ?? null,
    issuerDomain: info.account_data.Domain ? new TextDecoder().decode(new Uint8Array(info.account_data.Domain.match(/../g).map((h: string) => parseInt(h, 16)))) : null,
    xrpAmm: amm,
    fetchedAt: new Date().toISOString(),
  };
}

async function prices(q: URLSearchParams) {
  const ids = (q.get("ids") ?? "ripple,ripple-usd").split(",").map((s) => s.trim().toLowerCase()).filter((s) => /^[a-z0-9-]{1,64}$/.test(s)).slice(0, 25);
  if (!ids.length) throw new HttpError(400, "invalid ?ids=");
  const vs = (q.get("vs") ?? "usd").toLowerCase().replace(/[^a-z,]/g, "");
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(",")}&vs_currencies=${vs}&include_24hr_change=true&include_last_updated_at=true`;
  const cache = (globalThis as any).caches?.default as Cache | undefined;
  let r = cache ? await cache.match(url) : undefined;
  if (!r) {
    r = await fetch(url, { headers: { accept: "application/json", "user-agent": "GlitterAgentGate/0.1 (+https://agents.glitterchainscout.trade)" }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new HttpError(502, `price source HTTP ${r.status}`);
    const copy = new Response(r.clone().body, { headers: { "content-type": "application/json", "cache-control": "max-age=60" } });
    if (cache) await cache.put(url, copy).catch(() => {});
  }
  const data: any = await r.json();
  return {
    source: "CoinGecko public API (simple/price)", vs,
    prices: Object.fromEntries(Object.entries(data).map(([id, v]: any) => [id, {
      ...v, last_updated_at: v.last_updated_at ? new Date(v.last_updated_at * 1000).toISOString() : null,
    }])),
    fetchedAt: new Date().toISOString(),
  };
}

export function validateXrplData(req: Request, subpath: string) {
  const q = new URL(req.url).searchParams;
  if (subpath === "/account" && !isClassicAddress(q.get("address") ?? "")) throw new HttpError(400, "invalid or missing ?address=");
  if (!["/account", "/token", "/prices"].includes(subpath)) throw new HttpError(404, "unknown route; use /account, /token or /prices");
}

export async function xrplDataHandler(req: Request, env: Env, subpath: string): Promise<Response> {
  const q = new URL(req.url).searchParams;
  if (subpath === "/account") return json(await account(env, q));
  if (subpath === "/token") return json(await token(env, q));
  if (subpath === "/prices") return json(await prices(q));
  throw new HttpError(404, "unknown route; use /account, /token or /prices");
}
export { RLUSD_HEX };

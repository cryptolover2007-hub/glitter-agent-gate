// More XRP Ledger data: NFTs held, AMM pool for any pair, live DEX order book, recent account history.
import type { Env } from "../types";
import { HttpError, isClassicAddress, json, dropsToXrp } from "../util";
import { currencyCode, displayCurrency, rpc } from "./xrpl-data";

const RLUSD = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";
const net = (q: URLSearchParams) => { const n = (q.get("network") ?? "mainnet").toLowerCase(); if (n !== "mainnet" && n !== "testnet") throw new HttpError(400, "network must be mainnet or testnet"); return n; };
const rippleTime = (t: number) => new Date((t + 946684800) * 1000).toISOString();
const hexToStr = (h: string) => { try { const s = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)))); return /^[\x20-\x7e]*$/.test(s) ? s : null; } catch { return null; } };
function asset(s: string | null, name: string) {
  if (!s) throw new HttpError(400, `missing ?${name}= (XRP or CODE.rIssuer)`);
  if (s.toUpperCase() === "XRP") return { currency: "XRP" };
  const [cur, iss] = s.split(/[.:]/);
  if (!cur || !iss || !isClassicAddress(iss)) throw new HttpError(400, `?${name}= must be XRP or CODE.rIssuer (e.g. RLUSD.${RLUSD})`);
  return { currency: currencyCode(cur), issuer: iss };
}
const amt = (x: any) => (typeof x === "string" ? { currency: "XRP", value: Number(dropsToXrp(x)) } : { currency: displayCurrency(x.currency), issuer: x.issuer, value: Number(x.value) });

export function validateXrplMore(req: Request, subpath: string) {
  const q = new URL(req.url).searchParams;
  if (subpath === "/nfts" || subpath === "/history") { if (!isClassicAddress(q.get("address") ?? "")) throw new HttpError(400, "missing or invalid ?address= (r-address)"); }
  else if (subpath === "/amm") { asset(q.get("asset") ?? "XRP", "asset"); const b = asset(q.get("asset2"), "asset2"); if (b.currency === "XRP" && (q.get("asset") ?? "XRP").toUpperCase() === "XRP") throw new HttpError(400, "asset and asset2 must differ"); }
  else if (subpath === "/orderbook") { asset(q.get("base") ?? "XRP", "base"); asset(q.get("quote"), "quote"); }
  else throw new HttpError(404, "unknown route; use /nfts, /amm, /orderbook or /history");
  net(q);
}

export async function xrplMoreHandler(req: Request, env: Env, subpath: string): Promise<Response> {
  const q = new URL(req.url).searchParams, n = net(q);
  if (subpath === "/nfts") {
    const a = q.get("address")!;
    const r = await rpc(env, n, "account_nfts", { account: a, ledger_index: "validated", limit: Math.min(400, Math.max(20, Number(q.get("limit") ?? 100) || 100)) });
    const nfts = (r.account_nfts ?? []).map((x: any) => ({ id: x.NFTokenID, issuer: x.Issuer, taxon: x.NFTokenTaxon, serial: x.nft_serial, uri: x.URI ? hexToStr(x.URI) ?? x.URI : null, transferFeePercent: (x.TransferFee ?? 0) / 1000, transferable: !!(x.Flags & 8), burnable: !!(x.Flags & 1) }));
    return json({ network: n, address: a, count: nfts.length, more: !!r.marker, nfts });
  }
  if (subpath === "/amm") {
    const A = asset(q.get("asset") ?? "XRP", "asset"), B = asset(q.get("asset2"), "asset2");
    let r: any;
    try { r = await rpc(env, n, "amm_info", { asset: A, asset2: B, ledger_index: "validated" }); } catch (e) { if (e instanceof HttpError && /actNotFound|not found/i.test(e.message)) throw new HttpError(404, "no AMM pool for this pair (not charged)"); throw e; }
    if (!r?.amm) throw new HttpError(404, "no AMM pool for this pair (not charged)");
    const a1 = amt(r.amm.amount), a2 = amt(r.amm.amount2);
    return json({ network: n, pool: r.amm.account, asset: a1, asset2: a2, price: a2.value ? +(a1.value / a2.value).toPrecision(8) : null, priceUnit: `${a1.currency} per 1 ${a2.currency}`,
      tradingFeePercent: (r.amm.trading_fee ?? 0) / 1000, lpTokens: Number(r.amm.lp_token?.value ?? 0), auctionSlot: r.amm.auction_slot ? { account: r.amm.auction_slot.account, discountedFeePercent: (r.amm.auction_slot.discounted_fee ?? 0) / 1000, expires: r.amm.auction_slot.expiration } : null });
  }
  if (subpath === "/orderbook") {
    const base = asset(q.get("base") ?? "XRP", "base"), quote = asset(q.get("quote"), "quote"), lim = Math.min(50, Math.max(1, Number(q.get("limit") ?? 10) || 10));
    const [asks, bids] = await Promise.all([rpc(env, n, "book_offers", { taker_gets: base, taker_pays: quote, limit: lim, ledger_index: "validated" }), rpc(env, n, "book_offers", { taker_gets: quote, taker_pays: base, limit: lim, ledger_index: "validated" })]);
    const v = (x: any) => (typeof x === "string" ? Number(dropsToXrp(x)) : Number(x.value));
    const side = (offers: any[], isAsk: boolean) => (offers ?? []).slice(0, lim).map((o) => { const g = v(o.taker_gets_funded ?? o.TakerGets), p = v(o.taker_pays_funded ?? o.TakerPays); return isAsk ? { price: g ? +(p / g).toPrecision(8) : null, amount: g, owner: o.Account } : { price: p ? +(g / p).toPrecision(8) : null, amount: p, owner: o.Account }; }).filter((o) => o.amount > 0);
    const A = side(asks.offers, true), Bd = side(bids.offers, false);
    if (!A.length && !Bd.length) throw new HttpError(404, "no open offers for this pair (not charged)");
    return json({ network: n, base: q.get("base") ?? "XRP", quote: q.get("quote"), priceUnit: "quote per 1 base", bestAsk: A[0]?.price ?? null, bestBid: Bd[0]?.price ?? null, asks: A, bids: Bd });
  }
  // /history
  const a = q.get("address")!;
  const r = await rpc(env, n, "account_tx", { account: a, limit: Math.min(100, Math.max(1, Number(q.get("limit") ?? 25) || 25)), ledger_index_min: -1, ledger_index_max: -1 });
  const txs = (r.transactions ?? []).map((t: any) => { const tx = t.tx_json ?? t.tx ?? {}; const d = t.meta?.delivered_amount ?? tx.DeliverMax ?? tx.Amount;
    return { hash: t.hash ?? tx.hash, type: tx.TransactionType, from: tx.Account, to: tx.Destination ?? null, amount: d && d !== "unavailable" ? amt(d) : null, result: t.meta?.TransactionResult, ledger: t.ledger_index ?? tx.ledger_index, date: tx.date ? rippleTime(tx.date) : (t.close_time_iso ?? null) }; });
  if (!txs.length) throw new HttpError(404, "no transactions found for this account (not charged)");
  return json({ network: n, address: a, count: txs.length, transactions: txs });
}

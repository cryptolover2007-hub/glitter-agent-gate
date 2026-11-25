// XRPL token safety check: issuer controls (freeze, clawback, auth, transfer fee, keys/blackhole), XRP AMM depth and
// holder concentration, from public XRPL nodes. Informational risk data only (not financial advice).
import type { Env } from "../types";
import { HttpError, isClassicAddress, json, dropsToXrp } from "../util";
import { rpc, currencyCode, displayCurrency } from "./xrpl-data";

const KNOWN: Record<string, Record<string, string>> = {
  mainnet: { RLUSD: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De" },
  testnet: { RLUSD: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV" },
};
const BLACKHOLES = new Set(["rrrrrrrrrrrrrrrrrrrrrhoLvTp", "rrrrrrrrrrrrrrrrrrrrBZbvji", "rrrrrrrrrrrrrrrrrrrn5RM1rHd", "rrrrrrrrrrrrrrrrrNAMEtxvNvQ"]);
const F = { defaultRipple: 0x00800000, requireAuth: 0x00040000, disableMaster: 0x00100000, noFreeze: 0x00200000, globalFreeze: 0x00400000, depositAuth: 0x01000000, clawback: 0x80000000 };
const MAX_PAGES = 5; // account_lines pages of 400 (up to 2,000 trust lines sampled)

function net(q: URLSearchParams) {
  const n = (q.get("network") ?? "mainnet").toLowerCase();
  if (n !== "mainnet" && n !== "testnet") throw new HttpError(400, "network must be mainnet or testnet");
  return n;
}

export function validateSafety(req: Request) {
  const q = new URL(req.url).searchParams;
  const cur = q.get("currency") ?? "";
  const issuer = q.get("issuer") ?? "";
  if (!cur) throw new HttpError(400, "missing ?currency= (symbol like SOLO or a 40-hex code)");
  if (cur.length > 40) throw new HttpError(400, "currency too long");
  if (cur.toUpperCase() === "XRP") throw new HttpError(400, "XRP is the native asset (no issuer); pass an issued token");
  if (issuer && !isClassicAddress(issuer)) throw new HttpError(400, "invalid ?issuer= (classic r-address)");
  if (!issuer && !KNOWN[(q.get("network") ?? "mainnet").toLowerCase()]?.[cur.toUpperCase()]) throw new HttpError(400, "missing ?issuer= (only RLUSD is known without an issuer)");
}

const decodeDomain = (h?: string) => { try { return h ? new TextDecoder().decode(new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)))) : null; } catch { return null; } };
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 10000) / 100 : null);

export async function safetyHandler(req: Request, env: Env): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const network = net(q);
  const sym = q.get("currency")!;
  const issuer = q.get("issuer") || KNOWN[network][sym.toUpperCase()];
  const code = currencyCode(sym);

  const [info, gb] = await Promise.all([
    rpc(env, network, "account_info", { account: issuer, ledger_index: "validated", signer_lists: true }),
    rpc(env, network, "gateway_balances", { account: issuer, ledger_index: "validated", strict: true }).catch(() => ({})),
  ]);
  const a = info.account_data ?? {};
  const flags = Number(a.Flags ?? 0);
  const has = (bit: number) => (flags & bit) === bit;
  const af = info.account_flags ?? {};
  const signerLists = info.signer_lists ?? a.signer_lists ?? [];
  const regularKey: string | null = a.RegularKey ?? null;
  const masterDisabled = af.disableMasterKey ?? has(F.disableMaster);
  const blackholed = masterDisabled && signerLists.length === 0 && (!regularKey || BLACKHOLES.has(regularKey));
  const transferFeePct = a.TransferRate ? Math.round((Number(a.TransferRate) / 1e9 - 1) * 1e6) / 1e4 : 0;
  const supplyStr: string | null = gb?.obligations?.[code] ?? null;
  const supply = supplyStr ? Number(supplyStr) : 0;

  // AMM (XRP / token)
  let amm: any = null;
  try {
    const r = await rpc(env, network, "amm_info", { asset: { currency: "XRP" }, asset2: { currency: code, issuer }, ledger_index: "validated" });
    const xrp = Number(r.amm.amount) / 1e6, tok = Number(r.amm.amount2.value);
    amm = { account: r.amm.account, xrpReserve: xrp, tokenReserve: tok, tvlXrp: Math.round(xrp * 2 * 1e6) / 1e6, priceXrpPerToken: tok ? xrp / tok : null,
      tradingFeePct: (r.amm.trading_fee ?? 0) / 1000, lpTokens: r.amm.lp_token?.value ?? null, tokenReserveShareOfSupplyPct: pct(tok, supply) };
  } catch { amm = null; }

  // Holders (trust lines on the issuer; holder balances appear negative from the issuer's side)
  const holders: { account: string; balance: number; frozen: boolean }[] = [];
  let marker: unknown, pages = 0, truncated = false, frozenLines = 0;
  do {
    const r: any = await rpc(env, network, "account_lines", { account: issuer, ledger_index: "validated", limit: 400, ...(marker ? { marker } : {}) });
    for (const l of r.lines ?? []) {
      if (l.currency !== code) continue;
      const bal = -Number(l.balance);
      const frozen = !!(l.freeze || l.freeze_peer);
      if (frozen) frozenLines++;
      if (bal > 0) holders.push({ account: l.account, balance: bal, frozen });
    }
    marker = r.marker; pages++;
  } while (marker && pages < MAX_PAGES);
  if (marker) truncated = true;
  holders.sort((x, y) => y.balance - x.balance);
  const sum = (n: number) => holders.slice(0, n).reduce((t, h) => t + h.balance, 0);
  const base = supply || holders.reduce((t, h) => t + h.balance, 0);
  const top = holders.slice(0, 10).map((h) => ({ account: h.account, balance: h.balance, sharePct: pct(h.balance, base), isAmm: amm?.account === h.account, frozen: h.frozen }));
  const exAmm = holders.filter((h) => h.account !== amm?.account);
  const top10ExAmm = exAmm.slice(0, 10).reduce((t, h) => t + h.balance, 0);

  // Risk flags (informational)
  const flagsOut: { level: "high" | "medium" | "low" | "info"; code: string; message: string }[] = [];
  const add = (level: any, code: string, message: string) => flagsOut.push({ level, code, message });
  const clawback = af.allowTrustLineClawback ?? has(F.clawback);
  const globalFreeze = af.globalFreeze ?? has(F.globalFreeze);
  const noFreeze = af.noFreeze ?? has(F.noFreeze);
  const requireAuth = af.requireAuthorization ?? has(F.requireAuth);
  if (globalFreeze) add("high", "global_freeze_on", "Issuer has frozen ALL trust lines for its tokens (transfers blocked).");
  if (clawback) add("high", "clawback_enabled", "Issuer can claw back tokens from holders.");
  if (!noFreeze && !globalFreeze) add("medium", "freeze_possible", "Issuer has not set NoFreeze, so it can freeze individual trust lines or all of them.");
  if (requireAuth) add("medium", "require_auth", "Holders need the issuer's authorization to hold the token.");
  if (transferFeePct >= 1) add("medium", "transfer_fee", `Issuer charges a ${transferFeePct}% transfer fee on every transfer between holders.`);
  else if (transferFeePct > 0) add("low", "transfer_fee", `Issuer charges a ${transferFeePct}% transfer fee.`);
  if (!blackholed) add("low", "issuer_controllable", "Issuer keys are active (not blackholed): supply and settings can still change.");
  else add("info", "blackholed", "Issuer is blackholed: master key disabled and no usable regular key/signer list.");
  if (!amm) add("medium", "no_xrp_amm", "No XRP/token AMM pool found.");
  else if (amm.tvlXrp < 1000) add("medium", "thin_amm", `XRP AMM pool is thin (~${Math.round(amm.tvlXrp)} XRP total value).`);
  const top10Pct = pct(top10ExAmm, base);
  if (truncated) add("info", "holders_sampled", `Issuer has more than ${MAX_PAGES * 400} trust lines; holder shares are minimums from a sample, not a full ranking.`);
  else if (top10Pct !== null && top10Pct >= 80) add("high", "concentrated", `Top 10 non-AMM holders own ${top10Pct}% of supply.`);
  else if (top10Pct !== null && top10Pct >= 50) add("medium", "concentrated", `Top 10 non-AMM holders own ${top10Pct}% of supply.`);
  if (frozenLines) add("info", "frozen_lines", `${frozenLines} sampled trust line(s) are frozen.`);
  if (!supply) add("info", "no_supply", "Issuer reports no outstanding supply for this currency.");
  const level = flagsOut.some((f) => f.level === "high") ? "high" : flagsOut.filter((f) => f.level === "medium").length >= 2 ? "elevated" : flagsOut.some((f) => f.level === "medium") ? "moderate" : "low";

  return json({
    network, currency: displayCurrency(code), currencyCode: code, issuer,
    riskLevel: level, riskFlags: flagsOut,
    issuerControls: {
      globalFreeze, noFreeze, clawbackEnabled: clawback, requireAuth, defaultRipple: af.defaultRipple ?? has(F.defaultRipple), depositAuth: af.depositAuth ?? has(F.depositAuth),
      transferFeePct, masterKeyDisabled: masterDisabled, regularKey, signerList: signerLists.length > 0, blackholed,
      domain: decodeDomain(a.Domain), issuerBalanceXrp: a.Balance ? dropsToXrp(String(a.Balance)) : null, ownerCount: a.OwnerCount ?? null,
    },
    supply: { outstanding: supplyStr },
    xrpAmm: amm,
    holders: {
      counted: holders.length, sampledTrustLines: truncated ? `first ${MAX_PAGES * 400}` : "all", truncated,
      sharesAreMinimums: truncated,
      top1SharePct: pct(sum(1), base), top10SharePct: pct(sum(10), base), top10ExcludingAmmSharePct: top10Pct, top10: top,
    },
    disclaimer: "Informational on-ledger data, not financial advice. Holder figures are sampled when the issuer has many trust lines.",
    ledgerIndex: info.ledger_index ?? null, fetchedAt: new Date().toISOString(),
  });
}

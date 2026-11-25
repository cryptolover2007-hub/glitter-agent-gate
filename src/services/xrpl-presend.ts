// XRPL pre-send check: will a payment to this destination succeed, and does it need a destination tag?
import type { Env } from "../types";
import { HttpError, isClassicAddress, json, dropsToXrp } from "../util";
import { currencyCode, displayCurrency, rpc } from "./xrpl-data";

const RLUSD_ISSUER = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";
const F = { requireDest: 0x00020000, requireAuth: 0x00040000, disallowXRP: 0x00080000, disableMaster: 0x00100000, noFreeze: 0x00200000, globalFreeze: 0x00400000, defaultRipple: 0x00800000, depositAuth: 0x01000000, disallowIncomingTrustline: 0x20000000, allowClawback: 0x80000000 };
const L = { lowAuth: 0x00040000, highAuth: 0x00080000, lowNoRipple: 0x00100000, highNoRipple: 0x00200000, lowFreeze: 0x00400000, highFreeze: 0x00800000 };
const BLACKHOLES = new Set(["rrrrrrrrrrrrrrrrrrrrrhoLvTp", "rrrrrrrrrrrrrrrrrrrrBZbvji", "rrrrrrrrrrrrrrrrrNAMEtxvNvQ", "rrrrrrrrrrrrrrrrrrrn5RM1rHd"]);

export function validatePresend(req: Request) {
  const q = new URL(req.url).searchParams;
  if (!isClassicAddress(q.get("destination") ?? "")) throw new HttpError(400, "missing or invalid ?destination= (classic r-address; X-addresses: decode first)");
  if (q.get("source") && !isClassicAddress(q.get("source")!)) throw new HttpError(400, "invalid ?source=");
  const amount = q.get("amount"); if (amount && !/^\d+(\.\d{1,15})?$/.test(amount)) throw new HttpError(400, "invalid ?amount= (decimal, e.g. 25 or 0.5)");
  const cur = (q.get("currency") ?? "XRP").toUpperCase();
  if (cur !== "XRP" && cur !== "RLUSD" && !isClassicAddress(q.get("issuer") ?? "")) throw new HttpError(400, "?issuer= is required for issued tokens other than RLUSD");
  if (q.get("tag") && !/^\d{1,10}$/.test(q.get("tag")!)) throw new HttpError(400, "invalid ?tag= (0-4294967295)");
  const n = (q.get("network") ?? "mainnet").toLowerCase(); if (n !== "mainnet" && n !== "testnet") throw new HttpError(400, "network must be mainnet or testnet");
}

export async function presendHandler(req: Request, env: Env): Promise<Response> {
  const q = new URL(req.url).searchParams, n = (q.get("network") ?? "mainnet").toLowerCase();
  const dest = q.get("destination")!, source = q.get("source"), amount = q.get("amount"), tag = q.get("tag");
  const curIn = (q.get("currency") ?? "XRP").trim(), isXrp = curIn.toUpperCase() === "XRP";
  const issuer = isXrp ? null : (q.get("issuer") || (curIn.toUpperCase() === "RLUSD" && n === "mainnet" ? RLUSD_ISSUER : null));
  if (!isXrp && !issuer) throw new HttpError(400, "?issuer= is required on testnet");
  const currency = isXrp ? "XRP" : currencyCode(curIn);
  const checks: Array<{ check: string; ok: boolean | null; level: "block" | "warn" | "info"; message: string }> = [];
  const add = (check: string, ok: boolean | null, level: "block" | "warn" | "info", message: string) => checks.push({ check, ok, level, message });

  const [server, destInfo] = await Promise.all([
    rpc(env, n, "server_state", {}),
    rpc(env, n, "account_info", { account: dest, ledger_index: "validated" }).catch((e) => { if (e instanceof HttpError && e.status === 404) return null; throw e; }),
  ]);
  const vl = server.state?.validated_ledger ?? {};
  const baseReserveXrp = Number(dropsToXrp(String(vl.reserve_base ?? 1_000_000))), ownerReserveXrp = Number(dropsToXrp(String(vl.reserve_inc ?? 200_000)));
  let destination: Record<string, unknown> = { address: dest, exists: !!destInfo };

  if (!destInfo) {
    if (!isXrp) add("account_exists", false, "block", "Destination account does not exist. Issued tokens cannot be sent to it; it must first be funded with XRP and set a trust line.");
    else if (!amount) add("account_exists", false, "warn", `Destination account does not exist. Sending XRP will create it only if the amount is at least the base reserve (${baseReserveXrp} XRP).`);
    else add("account_exists", Number(amount) >= baseReserveXrp, Number(amount) >= baseReserveXrp ? "info" : "block", Number(amount) >= baseReserveXrp ? `Destination does not exist yet; ${amount} XRP will create and fund it (reserve ${baseReserveXrp} XRP, locked).` : `Destination does not exist and ${amount} XRP is below the ${baseReserveXrp} XRP base reserve: the payment would fail (tecNO_DST_INSUF_XRP).`);
  } else {
    const d = destInfo.account_data, f = d.Flags ?? 0;
    const owner = Number(d.OwnerCount ?? 0), reserve = baseReserveXrp + owner * ownerReserveXrp, bal = Number(dropsToXrp(d.Balance));
    destination = { address: dest, exists: true, balanceXrp: bal, reserveXrp: reserve, domain: d.Domain ? safeHex(d.Domain) : null,
      flags: { requireDestinationTag: !!(f & F.requireDest), depositAuth: !!(f & F.depositAuth), disallowXRP: !!(f & F.disallowXRP), globalFreeze: !!(f & F.globalFreeze), masterKeyDisabled: !!(f & F.disableMaster) },
      regularKey: d.RegularKey ?? null };
    add("account_exists", true, "info", "Destination account exists.");
    if (f & F.requireDest) add("destination_tag", !!tag, tag ? "info" : "block", tag ? `Destination requires a destination tag; you supplied ${tag}.` : "Destination REQUIRES a destination tag (exchanges/custodians). Without one the payment is rejected (tecDST_TAG_NEEDED) or funds may be unattributable.");
    else add("destination_tag", true, "info", tag ? `Tag ${tag} will be included (not required by this account).` : "No destination tag required.");
    if (f & F.depositAuth) {
      if (!source) add("deposit_auth", null, "block", "Destination has DepositAuth: only preauthorized senders can pay it. Pass ?source= to check your address.");
      else { const da = await rpc(env, n, "deposit_authorized", { source_account: source, destination_account: dest, ledger_index: "validated" }).catch(() => null); add("deposit_auth", !!da?.deposit_authorized, da?.deposit_authorized ? "info" : "block", da?.deposit_authorized ? `Source ${source} is preauthorized to pay this DepositAuth account.` : `Destination has DepositAuth and ${source} is NOT preauthorized: payment will fail (tecNO_PERMISSION).`); }
    }
    if (isXrp && (f & F.disallowXRP)) add("disallow_xrp", null, "warn", "Destination set DisallowXRP: it asks not to receive XRP (advisory, not enforced).");
    if (!d.RegularKey && (f & F.disableMaster)) add("keys", null, "warn", "Destination has its master key disabled and no regular key; check for a signer list before relying on it.");
    if (d.RegularKey && BLACKHOLES.has(d.RegularKey) && (f & F.disableMaster)) add("blackholed", false, "block", "Destination is a blackholed account: funds sent there can never be moved again.");
  }

  let token: Record<string, unknown> | null = null;
  if (!isXrp && destInfo && issuer) {
    const [iss, lines] = await Promise.all([
      rpc(env, n, "account_info", { account: issuer, ledger_index: "validated" }).catch((e) => { if (e instanceof HttpError && e.status === 404) return null; throw e; }),
      rpc(env, n, "account_lines", { account: dest, peer: issuer, ledger_index: "validated" }),
    ]);
    if (!iss) add("issuer_exists", false, "block", "Token issuer account not found.");
    const fi = iss?.account_data?.Flags ?? 0;
    const line = (lines.lines ?? []).find((l: any) => l.currency === currency);
    token = { currency: displayCurrency(currency), issuer, trustLine: line ? { balance: Number(line.balance), limit: Number(line.limit), frozenByIssuer: !!line.freeze_peer, frozenByHolder: !!line.freeze, authorized: line.peer_authorized ?? null } : null,
      issuerFlags: iss ? { globalFreeze: !!(fi & F.globalFreeze), requireAuth: !!(fi & F.requireAuth), clawback: !!(fi & F.allowClawback) } : null };
    if (dest === issuer) add("trust_line", true, "info", "Destination is the issuer itself (payment redeems the tokens).");
    else if (!line) add("trust_line", false, "block", `Destination has no ${displayCurrency(currency)} trust line to ${issuer}: the payment would fail (tecPATH_DRY).`);
    else {
      add("trust_line", true, "info", "Destination has a trust line for this token.");
      if (line.freeze_peer) add("frozen", false, "block", "The issuer has FROZEN this trust line: the destination cannot receive the token.");
      if (fi & F.globalFreeze) add("global_freeze", false, "block", "The issuer has a GLOBAL FREEZE on this token.");
      if ((fi & F.requireAuth) && !line.peer_authorized) add("authorized", false, "block", "Issuer requires authorization and this trust line is not authorized.");
      if (amount) { const room = Number(line.limit) - Number(line.balance); add("trust_limit", room >= Number(amount), room >= Number(amount) ? "info" : "block", room >= Number(amount) ? `Trust line has room for ${amount} (${room} left).` : `Trust line limit leaves room for only ${room}: ${amount} would fail or be partial.`); }
    }
  }
  const blockers = checks.filter((c) => c.level === "block" && c.ok !== true);
  const verdict = blockers.length ? "do_not_send" : checks.some((c) => c.level === "warn") ? "send_with_caution" : "ok_to_send";
  return json({ network: n, verdict, summary: blockers.length ? blockers.map((b) => b.message).join(" ") : verdict === "ok_to_send" ? "No problems found for this payment." : checks.filter((c) => c.level === "warn").map((c) => c.message).join(" "),
    payment: { destination: dest, destinationTag: tag ?? null, source: source ?? null, amount: amount ?? null, currency: isXrp ? "XRP" : displayCurrency(currency), issuer },
    destination, token, checks, reserves: { baseXrp: baseReserveXrp, perObjectXrp: ownerReserveXrp }, checkedAt: new Date().toISOString(),
    disclaimer: "Read-only ledger checks at the latest validated ledger; conditions can change before you send." });
}
function safeHex(h: string) { try { return new TextDecoder().decode(Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)))); } catch { return null; } }

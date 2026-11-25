// One real $0.001 USDC payment on Base via PayAI to the live gateway (json-tools).
// Usage (from repo root): npx tsx e2e/pay-once-base.ts   — key read from .secrets/test-payer-base.key, never printed.
import "./selftest-ua.mjs";
import { readFileSync } from "node:fs";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm";
import { wrapFetchWithPayment } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";

const BASE = process.argv[2] || "https://agents.glitterchainscout.trade";
const account = privateKeyToAccount(readFileSync(".secrets/test-payer-base.key", "utf8").trim() as `0x${string}`);
const client = new x402Client().register("eip155:8453", new ExactEvmScheme(account));
// Hard cap: refuse anything other than Base USDC at <= 1000 atomic units ($0.001).
client.registerPolicy?.((_v: number, reqs: any[]) => reqs.filter((r) => r.network === "eip155:8453" && BigInt(r.amount) <= 1000n));
const pay = wrapFetchWithPayment(fetch, client);
const r = await pay(`${BASE}/s/json-tools`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: [1, 2, 3], ops: [{ op: "count" }] }) });
console.log("status", r.status);
let pr: any = null;
try { pr = new x402HTTPClient(client).getPaymentSettleResponse((n) => r.headers.get(n)); } catch { console.log("no PAYMENT-RESPONSE (not settled)"); }
console.log("settle", JSON.stringify(pr));
if (pr?.transaction) console.log("tx https://basescan.org/tx/" + pr.transaction);
console.log((await r.text()).slice(0, 300));

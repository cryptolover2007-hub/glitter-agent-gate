// TESTNET ONLY: opens RLUSD trust lines for the demo wallets and buys a little test RLUSD
// for the agent wallet from the public testnet XRP/RLUSD AMM (cross-currency payment to self).
import { Client, Wallet, xrpToDrops } from "xrpl";
import fs from "node:fs";
const WS = process.env.XRPL_TESTNET_WS ?? "wss://testnet.xrpl-labs.com";
const RLUSD = "524C555344000000000000000000000000000000";
const ISSUER = process.env.RLUSD_TESTNET_ISSUER ?? "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
const W = JSON.parse(fs.readFileSync(".secrets/testnet-wallets.json", "utf8"));
const buy = process.argv[2] ?? "2"; // RLUSD to acquire
const client = new Client(WS); await client.connect();
const si = await client.request({ command: "server_info" });
if (si.result.info.network_id !== 1) throw new Error("not testnet");
const iss = await client.request({ command: "account_info", account: ISSUER });
console.log("issuer flags:", iss.result.account_flags?.requireAuthorization ? "requireAuth" : "open");
for (const role of ["agent", "provider"]) {
  const w = Wallet.fromSeed(W[role].seed);
  const r = await client.submitAndWait({ TransactionType: "TrustSet", Account: w.classicAddress,
    LimitAmount: { currency: RLUSD, issuer: ISSUER, value: "1000000" } }, { wallet: w, autofill: true });
  console.log(`${role} TrustSet:`, r.result.meta.TransactionResult, r.result.hash);
}
const a = Wallet.fromSeed(W.agent.seed);
const r = await client.submitAndWait({ TransactionType: "Payment", Account: a.classicAddress, Destination: a.classicAddress,
  Amount: { currency: RLUSD, issuer: ISSUER, value: buy }, SendMax: xrpToDrops("60"), Flags: 0 }, { wallet: a, autofill: true });
console.log("agent buy RLUSD:", r.result.meta.TransactionResult, r.result.hash);
const lines = await client.request({ command: "account_lines", account: a.classicAddress, peer: ISSUER });
console.log("agent RLUSD balance:", lines.result.lines[0]?.balance);
await client.disconnect();

// Agent client demo (TESTNET): discover services, hit a paid endpoint, get 402, sign an XRPL Payment with
// the x402-xrpl SDK, retry, print the result + tx hash.
// Usage: npx tsx clients/ts/agent-demo.ts [--service hello] [--path ""] [--asset XRP|RLUSD] [--query "name=johnny"]
//        [--method POST --file e2e/fixtures/sample.pdf --content-type application/pdf] [--method POST --body '{"data":[1,2],"ops":[{"op":"count"}]}' --content-type application/json]
// Wallet: XRPL_SEED env, or the "agent" entry in .secrets/testnet-wallets.json (never printed).
import fs from "node:fs";
import { Wallet } from "xrpl";
import { x402Purchase, decodePaymentResponseHeader } from "x402-xrpl";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc: string[][], a, i, arr) => (a.startsWith("--") ? [...acc, [a.slice(2), arr[i + 1] ?? ""]] : acc), []));
const GATEWAY = process.env.GATEWAY_URL ?? "http://127.0.0.1:8787";
const NETWORK = (process.env.X402_NETWORK ?? "xrpl:1") as "xrpl:1";
if (NETWORK !== "xrpl:1") throw new Error("This demo is testnet-only (xrpl:1).");
const WS = process.env.XRPL_WS ?? "wss://testnet.xrpl-labs.com";
const ASSET = (args.asset ?? "XRP").toUpperCase();
const RLUSD_HEX = "524C555344000000000000000000000000000000";
// Spend caps (agent safety): refuse anything above these per call.
const MAX_XRP_DROPS = BigInt(process.env.MAX_XRP_DROPS ?? "100000"); // 0.1 XRP
const MAX_RLUSD = Number(process.env.MAX_RLUSD ?? "0.1");

const seed = process.env.XRPL_SEED ?? JSON.parse(fs.readFileSync(".secrets/testnet-wallets.json", "utf8")).agent.seed;
const wallet = Wallet.fromSeed(seed);

const catalog = await (await fetch(`${GATEWAY}/services`)).json();
console.log(`Discovered ${catalog.services.length} services at ${GATEWAY}:`);
for (const s of catalog.services) console.log(`  - ${s.slug}: ${s.prices.map((p: any) => `${p.amountDisplay} ${p.asset}`).join(" | ")}`);

const service = args.service ?? "hello";
const url = `${GATEWAY}/s/${service}${args.path ?? ""}${args.query ? "?" + args.query : ""}`;
console.log(`\nCalling ${url} as ${wallet.classicAddress}, paying in ${ASSET}...`);

const result = await x402Purchase({
  url, method: args.method ?? "GET",
  headers: args["content-type"] ? { "content-type": args["content-type"] } : undefined,
  body: args.file ? fs.readFileSync(args.file) : (args.body ?? undefined),
  wallet, network: NETWORK, wsUrl: WS,
  paymentRequirementsSelector: (accepts) => {
    const want = ASSET === "RLUSD" ? RLUSD_HEX : "XRP";
    const opt = accepts.find((a: any) => a.network === NETWORK && a.asset === want);
    if (!opt) throw new Error(`no ${ASSET} option offered`);
    if (want === "XRP" && BigInt(String(opt.amount)) > MAX_XRP_DROPS) throw new Error(`price ${opt.amount} drops exceeds cap`);
    if (want !== "XRP" && Number(opt.amount) > MAX_RLUSD) throw new Error(`price ${opt.amount} RLUSD exceeds cap`);
    console.log(`  402 received. Chose ${want === "XRP" ? opt.amount + " drops XRP" : opt.amount + " RLUSD"} -> ${opt.payTo} (invoice ${(opt as any).extra?.invoiceId})`);
    return opt;
  },
});

console.log(`\nStatus: ${result.status}${result.reason ? " (" + result.reason + ")" : ""}`);
if (result.response) {
  const pr = result.response.headers.get("PAYMENT-RESPONSE");
  const body = await result.response.text();
  console.log(`HTTP ${result.response.status}`);
  console.log(body.length > 1500 ? body.slice(0, 1500) + "\n... (truncated)" : body);
  if (pr) {
    const s = decodePaymentResponseHeader(pr);
    console.log(`\nPaid. tx: ${s.transaction}\nExplorer: https://testnet.xrpl.org/transactions/${s.transaction}`);
    fs.mkdirSync("e2e", { recursive: true });
    fs.appendFileSync("e2e/tx-log.jsonl", JSON.stringify({ at: new Date().toISOString(), service, url, asset: ASSET, tx: s.transaction, network: s.network, payer: s.payer, http: result.response.status }) + "\n");
  }
}
if (result.transaction && !result.response) console.log(`tx: ${result.transaction}`);

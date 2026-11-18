// Negative tests against the local gateway on TESTNET: replay, underpayment, cross-service invoice reuse.
import fs from "node:fs";
import { Wallet } from "xrpl";
import { XRPLPresignedPaymentPayer, paymentRequiredFromWire } from "x402-xrpl";
const G = process.env.GATEWAY_URL ?? "http://127.0.0.1:8787";
const wallet = Wallet.fromSeed(JSON.parse(fs.readFileSync(".secrets/testnet-wallets.json", "utf8")).agent.seed);
const payer = new XRPLPresignedPaymentPayer({ wallet, network: "xrpl:1", wsUrl: "wss://testnet.xrpl-labs.com" });
const get402 = async (u: string) => paymentRequiredFromWire(await (await fetch(u)).json());
const results: any[] = [];
const check = (name: string, ok: boolean, detail: unknown) => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}`, detail); };

// 1) underpayment: tamper with the amount before signing
{
  const pr = await get402(`${G}/s/hello?name=tamper`);
  const req = { ...pr.accepts.find((a) => a.asset === "XRP")!, amount: "1" };
  const h = await payer.createPaymentHeader(req as any);
  const r = await fetch(`${G}/s/hello?name=tamper`, { headers: { "PAYMENT-SIGNATURE": h } });
  check("underpayment rejected", r.status === 402, { status: r.status, body: await r.json() });
}
// 2) invoice for one service presented to another
{
  const pr = await get402(`${G}/s/hello?name=x`);
  const h = await payer.createPaymentHeader(pr.accepts.find((a) => a.asset === "XRP")!);
  const r = await fetch(`${G}/s/xrpl-data/prices`, { headers: { "PAYMENT-SIGNATURE": h } });
  check("cross-service invoice rejected", r.status === 400, { status: r.status, body: await r.json() });
}
// 3) replay: pay once (real testnet tx), then resend the same PAYMENT-SIGNATURE
{
  const pr = await get402(`${G}/s/hello?name=replay`);
  const h = await payer.createPaymentHeader(pr.accepts.find((a) => a.asset === "XRP")!);
  const r1 = await fetch(`${G}/s/hello?name=replay`, { headers: { "PAYMENT-SIGNATURE": h } });
  const pay = r1.headers.get("PAYMENT-RESPONSE");
  const tx = pay ? JSON.parse(Buffer.from(pay, "base64").toString()).transaction : null;
  const r2 = await fetch(`${G}/s/hello?name=replay`, { headers: { "PAYMENT-SIGNATURE": h } });
  check("first payment accepted", r1.status === 200, { status: r1.status, tx });
  check("replay rejected", r2.status === 409, { status: r2.status, body: await r2.json() });
  if (tx) fs.appendFileSync("e2e/tx-log.jsonl", JSON.stringify({ at: new Date().toISOString(), service: "hello", url: `${G}/s/hello?name=replay`, asset: "XRP", tx, network: "xrpl:1", payer: wallet.classicAddress, http: 200, note: "security-test first payment" }) + "\n");
}
fs.writeFileSync("e2e/security-results.json", JSON.stringify(results, null, 2));
process.exit(results.every((r) => r.ok) ? 0 : 1);

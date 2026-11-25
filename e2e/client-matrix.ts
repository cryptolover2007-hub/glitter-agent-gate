// Builds a real payment with the official client for EVERY network in the 402, using fresh UNFUNDED keys,
// and sends it to the gateway. Expected: facilitator verify runs and refuses for balance/unfunded -> nothing can move.
// Usage: tsx clients.ts <base> [path]
import "./selftest-ua.mjs";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm";
import { ExactSvmScheme } from "@x402/svm";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { generateKeyPairSigner } from "@solana/kit";
import * as xrpl from "xrpl";
import { XRPLPresignedPaymentPayer } from "x402-xrpl";
const B = process.argv[2] ?? "http://localhost:8788";
const path = process.argv[3] ?? "/s/hello?name=clienttest";
const evm = privateKeyToAccount(generatePrivateKey());
const svm = await generateKeyPairSigner();
const results: string[] = [];
async function fresh() { const r = await fetch(B + path); return { r, body: await r.json() }; }
for (const want of ["eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "xrpl:0:XRP", "xrpl:0:RLUSD"]) {
  const { r, body } = await fresh();
  const client = new x402Client((_v: number, accepts: any[]) => {
    const a = accepts.find((x: any) => want.startsWith(x.network) && (!want.startsWith("xrpl") || (want.endsWith("XRP") ? x.asset === "XRP" : x.asset !== "XRP")));
    if (!a) throw new Error("not offered: " + want); return a;
  });
  client.register("eip155:8453", new ExactEvmScheme(evm) as any);
  client.register("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", new ExactSvmScheme(svm as any) as any);
  const http = new x402HTTPClient(client);
  const pr: any = http.getPaymentRequiredResponse((n: string) => r.headers.get(n), body);
  let header: string;
  try {
    if (want.startsWith("xrpl")) {
      const req = pr.accepts.find((x: any) => x.network === "xrpl:0" && (want.endsWith("XRP") ? x.asset === "XRP" : x.asset !== "XRP"));
      // Official x402-xrpl payer. The fresh wallet is unfunded, so autofill is stubbed offline (real nodes would reject an unknown account).
      const real = new xrpl.Client("wss://xrplcluster.com");
      const stub: any = { isConnected: () => true, connect: async () => {}, disconnect: async () => {},
        autofill: async (tx: any) => ({ ...tx, Fee: "12", Sequence: 1, LastLedgerSequence: 999999999 }),
        request: async (q: any) => { if (!real.isConnected()) await real.connect(); return real.request(q); } };
      const payer = new XRPLPresignedPaymentPayer({ wallet: xrpl.Wallet.generate(), network: "xrpl:0" as any, wsUrl: "wss://xrplcluster.com" }, { client: stub });
      header = await payer.createPaymentHeader(req, { invoiceId: req.extra.invoiceId, resource: pr.resource });
      if (real.isConnected()) await real.disconnect();
    } else {
      const payload = await http.createPaymentPayload(pr);
      header = Object.values(http.encodePaymentSignatureHeader(payload))[0] as string;
    }
  } catch (e) { results.push(`${want}: CLIENT FAILED to build: ${String(e).slice(0, 160)}`); continue; }
  const paid = await fetch(B + path, { headers: { "PAYMENT-SIGNATURE": header } });
  const t = await paid.text();
  let err = ""; try { err = JSON.parse(t).error; } catch { err = t.slice(0, 120); }
  results.push(`${want}: client built payment OK -> gateway ${paid.status} ${String(err).slice(0, 170)}`);
}
console.log(results.join("\n"));

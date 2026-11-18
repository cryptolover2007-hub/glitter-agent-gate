// Optional second rail demo: pay a gateway endpoint in USDC on Base SEPOLIA (testnet) using the official
// @x402/fetch + @x402/evm buyer SDK. Needs test USDC from https://faucet.circle.com (Base Sepolia) on the agent address.
import fs from "node:fs";
import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

const G = process.env.GATEWAY_URL ?? "http://127.0.0.1:8787";
const pk = (process.env.EVM_PRIVATE_KEY ?? JSON.parse(fs.readFileSync(".secrets/base-sepolia-wallets.json", "utf8")).agent.privateKey) as `0x${string}`;
const account = privateKeyToAccount(pk);
const path = process.argv[2] ?? "/s/hello?name=base";
const fetchPaid = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: "eip155:84532", client: new ExactEvmScheme(account) }],
  paymentRequirementsSelector: (_v: number, accepts: any[]) => {
    const a = accepts.find((x) => x.network === "eip155:84532");
    if (!a) throw new Error("gateway does not offer Base Sepolia USDC");
    if (BigInt(a.amount) > 100000n) throw new Error("price above 0.10 USDC cap");
    console.log(`402 -> paying ${Number(a.amount) / 1e6} USDC to ${a.payTo} from ${account.address}`);
    return a;
  },
} as any);
const r = await fetchPaid(`${G}${path}`);
console.log("HTTP", r.status, (await r.text()).slice(0, 800));
const pr = r.headers.get("PAYMENT-RESPONSE");
if (pr) { const s = decodePaymentResponseHeader(pr); console.log("tx:", s.transaction, `https://sepolia.basescan.org/tx/${s.transaction}`); }

// Deliberate bad-payment checks (garbage X-PAYMENT header, v1 underpayment, unfunded v1 payment).
// LOCAL DEV ONLY: refuses any non-localhost gateway so these never pollute the live payment log.
// Usage: npx wrangler dev --env production --local --port 8788  then  npx tsx e2e/v1-local-checks.ts [http://localhost:8788]
import "./selftest-ua.mjs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
const B = process.argv[2] ?? "http://localhost:8788";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(B)) { console.error("refusing: v1-local-checks only runs against local dev (localhost/127.0.0.1)"); process.exit(2); }
let fail = 0;
const report = (ok: boolean, ...m: unknown[]) => { if (!ok) fail++; console.log(ok ? "ok  " : "FAIL", ...m); };
{ const r = await fetch(B + "/s/hello", { headers: { "x-payment": "not-base64!" } }); report(r.status === 400, r.status, "garbage X-PAYMENT -> 400"); }
const svc = await (await fetch(B + "/services")).json();
const ep = (svc.services ?? svc).find((s: any) => s.slug === "xrpl-presend").endpoints[0];
const r1 = ep.x402v1; report(!!r1 && r1.network === "base" && r1.extra?.name === "USD Coin" && r1.extra?.version === "2", "x402v1 requirement", r1?.network, r1?.maxAmountRequired);
const acct = privateKeyToAccount(generatePrivateKey());
const now = Math.floor(Date.now() / 1000);
const nonce = ("0x" + [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("")) as `0x${string}`;
const auth = { from: acct.address, to: r1.payTo, value: r1.maxAmountRequired, validAfter: String(now - 600), validBefore: String(now + r1.maxTimeoutSeconds), nonce };
const sign = (a: typeof auth) => acct.signTypedData({ domain: { name: r1.extra.name, version: r1.extra.version, chainId: 8453, verifyingContract: r1.asset },
  types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
  primaryType: "TransferWithAuthorization", message: { ...a, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore) } as any });
const url = B + "/s/xrpl-presend?destination=rEb8TK3gBgk5auZkwc6sHnwrGVJH8DuaLh&amount=25";
const send = async (a: typeof auth) => fetch(url, { headers: { "x-payment": Buffer.from(JSON.stringify({ x402Version: 1, scheme: "exact", network: "base", payload: { signature: await sign(a), authorization: a } })).toString("base64") } });
{ const r = await send(auth); const t = await r.text(); report(r.status === 402 && t.includes("insufficient_balance"), r.status, "unfunded v1 payment -> 402 insufficient balance"); }
{ const a = { ...auth, value: "1" }; const r = await send(a); const t = await r.text(); report(r.status === 402 && /amount 1 </.test(t), r.status, "underpaid v1 payment -> 402"); }
process.exit(fail ? 1 : 0);

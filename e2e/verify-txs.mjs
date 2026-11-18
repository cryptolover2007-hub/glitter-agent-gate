// Re-checks every tx in e2e/tx-log.jsonl on the XRPL TESTNET ledger and writes e2e/RESULTS.md.
import fs from "node:fs";
import { Client } from "xrpl";
const lines = fs.readFileSync("e2e/tx-log.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));
const c = new Client(process.env.XRPL_TESTNET_WS ?? "wss://testnet.xrpl-labs.com"); await c.connect();
const rows = [];
for (const l of lines) {
  const r = (await c.request({ command: "tx", transaction: l.tx })).result;
  const tx = r.tx_json ?? r; const d = r.meta.delivered_amount;
  const amt = typeof d === "string" ? `${Number(d) / 1e6} XRP` : `${d.value} ${d.currency === "524C555344000000000000000000000000000000" ? "RLUSD" : d.currency}`;
  rows.push({ ...l, validated: r.validated, result: r.meta.TransactionResult, delivered: amt, from: tx.Account, to: tx.Destination, sourceTag: tx.SourceTag, ledger: r.ledger_index });
}
await c.disconnect();
const md = ["# End-to-end results (XRPL TESTNET, xrpl:1)", "", `Re-verified on-ledger at ${new Date().toISOString()} via ${"wss://testnet.xrpl-labs.com"}.`, "",
  "| # | Service | Asset | Delivered | Result | Validated | SourceTag | Tx |", "|---|---|---|---|---|---|---|---|",
  ...rows.map((r, i) => `| ${i + 1} | ${r.service} | ${r.asset} | ${r.delivered} | ${r.result} | ${r.validated} | ${r.sourceTag} | [${r.tx.slice(0, 12)}…](https://testnet.xrpl.org/transactions/${r.tx}) |`), "",
  `Payer (agent): ${rows[0]?.from}`, ""].join("\n");
fs.writeFileSync("e2e/RESULTS.md", md);
console.log(md);

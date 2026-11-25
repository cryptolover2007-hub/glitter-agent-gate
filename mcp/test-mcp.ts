// Spawns the MCP server over stdio and calls list_services + one paid tool (testnet).
import "../e2e/selftest-ua.mjs";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const seed = JSON.parse(fs.readFileSync(".secrets/testnet-wallets.json", "utf8")).agent.seed;
const transport = new StdioClientTransport({ command: "npx", args: ["tsx", "mcp/src/index.ts"], env: { ...process.env, XRPL_SEED: seed, GATEWAY_URL: "http://127.0.0.1:8787", NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${new URL("../e2e/selftest-ua.mjs", import.meta.url).pathname}`.trim() } as any });
const client = new Client({ name: "mcp-test", version: "0.0.1" });
await client.connect(transport);
console.log("tools:", (await client.listTools()).tools.map((t) => t.name).join(", "));
const r: any = await client.callTool({ name: "xrpl_account_info", arguments: { address: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De", network: "mainnet", asset: "RLUSD" } });
const out = JSON.parse(r.content[0].text);
console.log("status:", out.status, "http:", out.http, "balanceXrp:", out.result?.balanceXrp, "payment:", JSON.stringify(out.payment));
if (out.payment?.tx) fs.appendFileSync("e2e/tx-log.jsonl", JSON.stringify({ at: new Date().toISOString(), service: "xrpl-data/account (via MCP)", asset: "RLUSD", tx: out.payment.tx, network: out.payment.network, http: out.http }) + "\n");
await client.close();

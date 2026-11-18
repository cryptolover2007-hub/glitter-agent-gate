#!/usr/bin/env node

// src/index.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Wallet } from "xrpl";
import { x402Purchase, decodePaymentResponseHeader } from "x402-xrpl";
var GATEWAY = (process.env.GATEWAY_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
var NETWORK = process.env.X402_NETWORK ?? "xrpl:1";
if (NETWORK === "xrpl:0" && process.env.X402_ALLOW_MAINNET !== "true") throw new Error("Refusing mainnet without X402_ALLOW_MAINNET=true");
var WS = process.env.XRPL_WS ?? (NETWORK === "xrpl:0" ? "wss://xrplcluster.com" : "wss://testnet.xrpl-labs.com");
var RLUSD_HEX = "524C555344000000000000000000000000000000";
var MAX_XRP_PER_CALL = Number(process.env.MAX_XRP_PER_CALL ?? "0.1");
var MAX_RLUSD_PER_CALL = Number(process.env.MAX_RLUSD_PER_CALL ?? "0.1");
var SESSION_BUDGET_XRP = Number(process.env.SESSION_BUDGET_XRP ?? "1");
var SESSION_BUDGET_RLUSD = Number(process.env.SESSION_BUDGET_RLUSD ?? "1");
var spent = { XRP: 0, RLUSD: 0 };
var wallet = process.env.XRPL_SEED ? Wallet.fromSeed(process.env.XRPL_SEED) : null;
async function paidCall(opts) {
  if (!wallet) return { error: "XRPL_SEED is not set; the MCP server cannot pay. Set it in the MCP client config (use a dedicated low-balance agent wallet)." };
  const asset = opts.asset ?? "XRP";
  const qs = opts.query && Object.keys(opts.query).length ? "?" + new URLSearchParams(opts.query).toString() : "";
  const url = `${GATEWAY}/s/${encodeURIComponent(opts.service)}${opts.path ?? ""}${qs}`;
  let charged = 0;
  const res = await x402Purchase({
    url,
    method: opts.method ?? "GET",
    wallet,
    network: NETWORK,
    wsUrl: WS,
    headers: opts.body !== void 0 ? { "content-type": "application/json" } : void 0,
    body: opts.body !== void 0 ? JSON.stringify(opts.body) : void 0,
    paymentRequirementsSelector: (accepts) => {
      const want = asset === "RLUSD" ? RLUSD_HEX : "XRP";
      const a = accepts.find((x) => x.network === NETWORK && x.asset === want);
      if (!a) throw new Error(`service does not accept ${asset} on ${NETWORK}`);
      charged = want === "XRP" ? Number(a.amount) / 1e6 : Number(a.amount);
      const cap = asset === "XRP" ? MAX_XRP_PER_CALL : MAX_RLUSD_PER_CALL;
      const budget = asset === "XRP" ? SESSION_BUDGET_XRP : SESSION_BUDGET_RLUSD;
      if (charged > cap) throw new Error(`price ${charged} ${asset} is above the per-call cap ${cap}`);
      if (spent[asset] + charged > budget) throw new Error(`session budget of ${budget} ${asset} would be exceeded`);
      return a;
    }
  });
  const out = { status: res.status, reason: res.reason };
  if (res.response) {
    out.http = res.response.status;
    const text = await res.response.text();
    try {
      out.result = JSON.parse(text);
    } catch {
      out.result = text.slice(0, 1e5);
    }
    const pr = res.response.headers.get("PAYMENT-RESPONSE");
    if (pr) {
      const s = decodePaymentResponseHeader(pr);
      spent[asset] += charged;
      out.payment = { asset, amount: charged, tx: s.transaction, network: s.network, explorer: NETWORK === "xrpl:1" ? `https://testnet.xrpl.org/transactions/${s.transaction}` : `https://livenet.xrpl.org/transactions/${s.transaction}`, sessionSpent: { ...spent } };
    } else out.payment = { charged: false };
  }
  return out;
}
var asText = (o) => ({ content: [{ type: "text", text: JSON.stringify(o, null, 2) }] });
var assetArg = z.enum(["XRP", "RLUSD"]).optional().describe("Pay in XRP (default) or RLUSD");
var server = new McpServer({ name: "xrpl-agent-tools", version: "0.1.0" });
server.registerTool(
  "list_services",
  { description: "List the gateway's paid tools with prices (free, no payment).", inputSchema: {} },
  async () => asText(await (await fetch(`${GATEWAY}/services`)).json())
);
server.registerTool("call_paid_service", {
  description: "Call any paid endpoint on the gateway. Pays automatically via x402 on the XRP Ledger within the configured spend caps. Failed calls are not charged.",
  inputSchema: {
    service: z.string().describe("Service slug from list_services, e.g. xrpl-data"),
    path: z.string().optional().describe('Sub-path, e.g. "/account"'),
    query: z.record(z.string(), z.string()).optional().describe("Query parameters"),
    method: z.enum(["GET", "POST"]).optional(),
    body: z.any().optional().describe("JSON body for POST endpoints"),
    asset: assetArg
  }
}, async (a) => asText(await paidCall(a)));
server.registerTool(
  "web_to_markdown",
  {
    description: "Fetch a public web page and return clean Markdown (paid). Respects robots.txt; no captcha/paywall bypass.",
    inputSchema: { url: z.string().url(), mode: z.enum(["readable", "full"]).optional(), asset: assetArg }
  },
  async ({ url, mode, asset }) => asText(await paidCall({ service: "web-markdown", query: { url, ...mode ? { mode } : {} }, asset }))
);
server.registerTool(
  "xrpl_account_info",
  {
    description: "XRPL account summary: balance, reserve, spendable, trust lines, recent txs (paid).",
    inputSchema: { address: z.string(), network: z.enum(["mainnet", "testnet"]).optional(), asset: assetArg }
  },
  async ({ address, network, asset }) => asText(await paidCall({ service: "xrpl-data", path: "/account", query: { address, network: network ?? "mainnet" }, asset }))
);
server.registerTool(
  "crypto_prices",
  {
    description: "Spot prices for CoinGecko ids, e.g. ripple,ripple-usd (paid).",
    inputSchema: { ids: z.string().optional(), vs: z.string().optional(), asset: assetArg }
  },
  async ({ ids, vs, asset }) => asText(await paidCall({ service: "xrpl-data", path: "/prices", query: { ids: ids ?? "ripple,ripple-usd", vs: vs ?? "usd" }, asset }))
);
server.registerTool(
  "convert_file",
  {
    description: "Convert a public PDF/CSV/XLSX/HTML file URL into JSON or text (paid).",
    inputSchema: { url: z.string().url(), to: z.enum(["json", "text"]).optional(), format: z.enum(["pdf", "csv", "tsv", "xlsx", "xls", "html"]).optional(), asset: assetArg }
  },
  async ({ url, to, format, asset }) => asText(await paidCall({ service: "convert", method: "POST", query: to ? { to } : void 0, body: { url, ...format ? { format } : {} }, asset }))
);
server.registerTool(
  "json_transform",
  {
    description: "Deterministic JSON transforms (pick, get, flatten, filter_eq, sort_by, dedupe, limit, count, keys, to_csv). Paid.",
    inputSchema: { data: z.any(), ops: z.array(z.record(z.string(), z.any())), asset: assetArg }
  },
  async ({ data, ops, asset }) => asText(await paidCall({ service: "json-tools", method: "POST", body: { data, ops }, asset }))
);
await server.connect(new StdioServerTransport());

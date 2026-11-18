#!/usr/bin/env node

// src/index.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Wallet } from "xrpl";
import { x402Purchase, decodePaymentResponseHeader } from "x402-xrpl";
var GATEWAY = (process.env.GATEWAY_URL ?? "https://agents.glitterchainscout.trade").replace(/\/+$/, "");
var VERSION = "0.1.1";
var RLUSD_HEX = "524C555344000000000000000000000000000000";
var MAX_XRP_PER_CALL = Number(process.env.MAX_XRP_PER_CALL ?? "0.1");
var MAX_RLUSD_PER_CALL = Number(process.env.MAX_RLUSD_PER_CALL ?? "0.1");
var SESSION_BUDGET_XRP = Number(process.env.SESSION_BUDGET_XRP ?? "1");
var SESSION_BUDGET_RLUSD = Number(process.env.SESSION_BUDGET_RLUSD ?? "1");
var spent = { XRP: 0, RLUSD: 0 };
var getJson = async (url, ms = 8e3) => (await fetch(url, { signal: AbortSignal.timeout(ms) })).json();
var networkPromise = null;
function getNetwork() {
  networkPromise ??= (async () => {
    let n = process.env.X402_NETWORK;
    if (!n) {
      try {
        n = (await getJson(`${GATEWAY}/services`))?.networks?.xrpl;
      } catch {
        n = void 0;
      }
    }
    return n === "xrpl:0" || n === "xrpl:1" ? n : "xrpl:1";
  })();
  return networkPromise;
}
var walletCache;
var walletError = null;
function getWallet() {
  if (walletCache !== void 0) return walletCache;
  const seed = process.env.XRPL_SEED;
  if (!seed) return walletCache = null;
  try {
    walletCache = Wallet.fromSeed(seed);
  } catch {
    walletCache = null;
    walletError = "XRPL_SEED is set but is not a valid XRPL seed.";
  }
  return walletCache;
}
async function quote(url, method, body) {
  try {
    const r = await fetch(url, { method, headers: body !== void 0 ? { "content-type": "application/json" } : void 0, body: body !== void 0 ? JSON.stringify(body) : void 0, signal: AbortSignal.timeout(1e4) });
    const h = r.headers.get("PAYMENT-REQUIRED");
    if (r.status !== 402 || !h) return { http: r.status };
    const pr = JSON.parse(Buffer.from(h, "base64").toString("utf8"));
    return {
      http: 402,
      accepts: (pr.accepts ?? []).map((a) => ({
        network: a.network,
        payTo: a.payTo,
        asset: a.asset === "XRP" ? "XRP" : a.asset === RLUSD_HEX ? "RLUSD" : a.extra?.name === "USD Coin" || a.extra?.name === "USDC" ? "USDC" : a.asset,
        amount: a.asset === "XRP" ? String(Number(a.amount) / 1e6) : a.asset.startsWith?.("0x") ? String(Number(a.amount) / 1e6) : a.amount
      })),
      ...pr.error?.startsWith?.("invalid_input") ? { inputError: pr.error } : {}
    };
  } catch (e) {
    return { error: `could not reach ${GATEWAY}: ${String(e).slice(0, 120)}` };
  }
}
async function paidCall(opts) {
  const asset = opts.asset ?? "XRP";
  const qs = opts.query && Object.keys(opts.query).length ? "?" + new URLSearchParams(opts.query).toString() : "";
  const url = `${GATEWAY}/s/${encodeURIComponent(opts.service)}${opts.path ?? ""}${qs}`;
  const wallet = getWallet();
  if (!wallet) return {
    status: "payment_required",
    charged: false,
    error: walletError ?? "No wallet configured (XRPL_SEED not set), so nothing was paid. Set XRPL_SEED in the MCP client config to a dedicated low-balance agent wallet to enable paid calls.",
    quote: await quote(url, opts.method ?? "GET", opts.body)
  };
  const NETWORK = await getNetwork();
  if (NETWORK === "xrpl:0" && process.env.X402_ALLOW_MAINNET !== "true") return { status: "payment_required", charged: false, error: `The gateway at ${GATEWAY} charges real funds on XRPL mainnet. Set X402_ALLOW_MAINNET=true to allow payments (use a dedicated low-balance wallet).`, quote: await quote(url, opts.method ?? "GET", opts.body) };
  const WS = process.env.XRPL_WS ?? (NETWORK === "xrpl:0" ? "wss://xrplcluster.com" : "wss://testnet.xrpl-labs.com");
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
var assetArg = z.enum(["XRP", "RLUSD"]).optional().describe("Asset to pay with on the XRP Ledger: XRP (default) or RLUSD");
var server = new McpServer({ name: "glitter-agent-gate", version: VERSION });
server.registerTool(
  "list_services",
  { description: "List every Glitter Agent Gate tool with its endpoints, parameters, examples and per-call prices in XRP, RLUSD and USDC. Free: makes no payment and needs no wallet. Use this first to pick a service slug for call_paid_service.", inputSchema: {}, annotations: { title: "List services and prices", readOnlyHint: true, openWorldHint: true } },
  async () => {
    try {
      return asText(await getJson(`${GATEWAY}/services`));
    } catch (e) {
      return asText({ error: `could not reach ${GATEWAY}: ${String(e).slice(0, 120)}` });
    }
  }
);
server.registerTool("call_paid_service", {
  description: "Generic caller for any Glitter Agent Gate endpoint (own tools or listed providers) by service slug and sub-path. Returns {status, http, result, payment:{asset, amount, tx, explorer}}. Paid per call with x402 from your XRPL_SEED wallet (XRP or RLUSD, capped by MAX_*_PER_CALL and SESSION_BUDGET_*). Without a wallet it returns the price quote and charges nothing. Failed calls are not charged.",
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
    description: "Fetch one public web page and return clean Markdown plus title, byline and word count (Readability extraction; mode=full keeps the whole body). Honors robots.txt and never bypasses logins, paywalls or captchas; blocked pages return an error. Price about $0.02. Paid per call with x402 from your XRPL_SEED wallet (XRP or RLUSD, capped by MAX_*_PER_CALL and SESSION_BUDGET_*). Without a wallet it returns the price quote and charges nothing. Failed calls are not charged.",
    inputSchema: { url: z.string().url().describe("Public http(s) page URL"), mode: z.enum(["readable", "full"]).optional(), asset: assetArg }
  },
  async ({ url, mode, asset }) => asText(await paidCall({ service: "web-markdown", query: { url, ...mode ? { mode } : {} }, asset }))
);
server.registerTool(
  "xrpl_account_info",
  {
    description: "Summarize an XRP Ledger account: XRP balance, reserve, spendable amount, trust lines (e.g. RLUSD) and the last 10 transactions, from mainnet (default) or testnet. Price about $0.002. Paid per call with x402 from your XRPL_SEED wallet (XRP or RLUSD, capped by MAX_*_PER_CALL and SESSION_BUDGET_*). Without a wallet it returns the price quote and charges nothing. Failed calls are not charged.",
    inputSchema: { address: z.string().describe("Classic XRPL r-address"), network: z.enum(["mainnet", "testnet"]).optional(), asset: assetArg }
  },
  async ({ address, network, asset }) => asText(await paidCall({ service: "xrpl-data", path: "/account", query: { address, network: network ?? "mainnet" }, asset }))
);
server.registerTool(
  "crypto_prices",
  {
    description: "Get spot prices for comma-separated CoinGecko ids (default ripple,ripple-usd) in a quote currency (default usd). Price about $0.002. Paid per call with x402 from your XRPL_SEED wallet (XRP or RLUSD, capped by MAX_*_PER_CALL and SESSION_BUDGET_*). Without a wallet it returns the price quote and charges nothing. Failed calls are not charged.",
    inputSchema: { ids: z.string().optional().describe("Comma-separated CoinGecko ids"), vs: z.string().optional().describe("Quote currency, e.g. usd"), asset: assetArg }
  },
  async ({ ids, vs, asset }) => asText(await paidCall({ service: "xrpl-data", path: "/prices", query: { ids: ids ?? "ripple,ripple-usd", vs: vs ?? "usd" }, asset }))
);
server.registerTool(
  "convert_file",
  {
    description: "Download a public PDF, CSV/TSV, XLSX/XLS or HTML file (max 10 MB) and convert it to structured JSON (rows, sheets, pages) or plain text. Price about $0.05. Paid per call with x402 from your XRPL_SEED wallet (XRP or RLUSD, capped by MAX_*_PER_CALL and SESSION_BUDGET_*). Without a wallet it returns the price quote and charges nothing. Failed calls are not charged.",
    inputSchema: { url: z.string().url().describe("Public file URL"), to: z.enum(["json", "text"]).optional(), format: z.enum(["pdf", "csv", "tsv", "xlsx", "xls", "html"]).optional(), asset: assetArg }
  },
  async ({ url, to, format, asset }) => asText(await paidCall({ service: "convert", method: "POST", query: to ? { to } : void 0, body: { url, ...format ? { format } : {} }, asset }))
);
server.registerTool(
  "json_transform",
  {
    description: "Apply a pipeline of deterministic JSON operations (pick, get, flatten, filter_eq, sort_by, dedupe, limit, count, keys, to_csv) to the given data. No code execution or regex. Price about $0.005. Paid per call with x402 from your XRPL_SEED wallet (XRP or RLUSD, capped by MAX_*_PER_CALL and SESSION_BUDGET_*). Without a wallet it returns the price quote and charges nothing. Failed calls are not charged.",
    inputSchema: { data: z.any().describe("Input JSON (object or array)"), ops: z.array(z.record(z.string(), z.any())).describe('Operations in order, e.g. [{"op":"pick","fields":["a"]}]'), asset: assetArg }
  },
  async ({ data, ops, asset }) => asText(await paidCall({ service: "json-tools", method: "POST", body: { data, ops }, asset }))
);
await server.connect(new StdioServerTransport());

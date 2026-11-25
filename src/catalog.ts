// First-party paid services ("the plumbing agents pay for").
// Prices follow Johnny's USD ranges, expressed in XRP / RLUSD / USDC.
// XRP amounts assume ~US$0.917/XRP (CoinGecko, 25 Nov 2026); re-check when XRP moves. Prices cut to market rates on 25 Nov 2026.
import type { Env, PaidService } from "./types";
import { webMarkdownHandler } from "./services/web-markdown";
import { validateXrplData, xrplDataHandler } from "./services/xrpl-data";
import { convertHandler, validateConvert } from "./services/convert";
import { jsonToolsHandler, validateJsonTools } from "./services/json-tools";
import { safetyHandler, validateSafety } from "./services/xrpl-safety";
import { baseTokenHandler, honeypotHandler, validateBaseToken } from "./services/base-token";
import { baseDataHandler, validateBaseData } from "./services/base-data";
import { validateXrplMore, xrplMoreHandler } from "./services/xrpl-more";
import { presendHandler, validatePresend } from "./services/xrpl-presend";
import { validateWebAi, webAiHandler } from "./services/web-ai";
import { HttpError, json } from "./util";

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", DEGEN = "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed", RLUSD_ISS = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";

export function ownServices(env: Env): PaidService[] {
  const payTo = env.OWN_PAY_TO;
  return [
    {
      slug: "web-markdown", kind: "own", providerId: "own", payTo,
      name: "Web page to clean Markdown",
      description: "Fetch a public web page and return clean Markdown (Readability main-content extraction), title, byline and word count. Honors robots.txt. Does not bypass logins, paywalls, captchas or bot protection; blocked pages return a clear error and are not charged.",
      price: { xrpDrops: "2182", rlusd: "0.002", usdc: "0.002" },
      tags: ["scrape", "markdown", "web", "readability", "llm-input"],
      validate: (req) => {
        const u = new URL(req.url).searchParams.get("url");
        if (!u || !/^https?:\/\//i.test(u)) throw new HttpError(400, "missing or invalid ?url= (must be http/https)");
      },
      handler: (req, env) => webMarkdownHandler(req, env),
      routes: [{
        path: "", method: "GET", summary: "Convert a URL to Markdown",
        query: {
          url: { type: "string", description: "Public http(s) URL to fetch", required: true, example: "https://xrpl.org/docs/agents/agentic-payments-x402" },
          mode: { type: "string", description: "readable (main content, default) or full (whole body)", example: "readable" },
        },
        outputExample: { url: "https://example.com", title: "Example Domain", markdown: "# Example Domain\n\nThis domain is for use in illustrative examples...", wordCount: 28 },
      }],
    },
    {
      slug: "xrpl-data", kind: "own", providerId: "own", payTo,
      name: "XRPL & crypto data feed",
      description: "Clean JSON from public sources: XRPL account summary (balance, reserve, spendable, trust lines, last 10 txs), XRPL token/issuer info with XRP AMM pool price, and spot prices from CoinGecko. Mainnet or testnet ledgers.",
      price: { xrpDrops: "1091", rlusd: "0.001", usdc: "0.001" },
      tags: ["xrpl", "crypto", "prices", "onchain-data", "rlusd"],
      validate: validateXrplData,
      handler: xrplDataHandler,
      routes: [
        { path: "/account", method: "GET", summary: "XRPL account summary",
          query: { address: { type: "string", description: "Classic r-address", required: true, example: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De" },
                   network: { type: "string", description: "mainnet (default) or testnet", example: "mainnet" } },
          outputExample: { address: "r...", balanceXrp: "25.5", reserveXrp: "1.2", spendableXrp: "24.3", trustLines: [], recentTransactions: [] } },
        { path: "/token", method: "GET", summary: "Issued token info + XRP AMM price",
          query: { currency: { type: "string", description: "Symbol or 40-hex code (default RLUSD)", example: "RLUSD" },
                   issuer: { type: "string", description: "Issuer r-address (optional for RLUSD)" },
                   network: { type: "string", description: "mainnet (default) or testnet", example: "mainnet" } },
          outputExample: { currency: "RLUSD", circulatingSupply: "123456789", xrpAmm: { spotPriceXrpPerToken: 1.02 } } },
        { path: "/prices", method: "GET", summary: "Spot prices (CoinGecko ids)",
          query: { ids: { type: "string", description: "Comma-separated CoinGecko ids", example: "ripple,ripple-usd" },
                   vs: { type: "string", description: "Quote currency", example: "usd" } },
          outputExample: { prices: { ripple: { usd: 0.98, usd_24h_change: -1.2 } } } },
      ],
    },
    {
      slug: "xrpl-token-safety", kind: "own", providerId: "own", payTo,
      name: "XRPL token safety check",
      description: "Risk check for any XRP Ledger issued token before you buy, hold or accept it: issuer freeze/global-freeze/NoFreeze, clawback, require-auth, transfer fee, blackholed or active issuer keys, XRP AMM pool depth and price, and holder concentration (top 1/top 10 share, AMM excluded). Returns a risk level with plain-English flags. Live from public XRPL nodes; informational, not financial advice.",
      price: { xrpDrops: "5454", rlusd: "0.005", usdc: "0.005" },
      tags: ["xrpl", "token-safety", "risk", "amm", "due-diligence"],
      validate: (req) => validateSafety(req),
      handler: (req, env) => safetyHandler(req, env),
      routes: [{
        path: "", method: "GET", summary: "Safety check an XRPL issued token",
        query: {
          currency: { type: "string", description: "Token symbol (e.g. SOLO) or 40-hex currency code", required: true, example: "RLUSD" },
          issuer: { type: "string", description: "Issuer classic r-address (optional only for RLUSD)", example: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De" },
          network: { type: "string", description: "mainnet (default) or testnet", example: "mainnet" },
        },
        outputExample: { currency: "SOLO", issuer: "rsoLo2S1kiGeCcn6hCUXVrCpGMWLrRrLZz", riskLevel: "moderate",
          riskFlags: [{ level: "medium", code: "freeze_possible", message: "Issuer has not set NoFreeze..." }],
          issuerControls: { globalFreeze: false, noFreeze: false, clawbackEnabled: false, transferFeePct: 0, blackholed: true },
          xrpAmm: { tvlXrp: 2400000, priceXrpPerToken: 0.21 }, holders: { counted: 2000, top10ExcludingAmmSharePct: 41.2 } },
      }],
    },
    {
      slug: "base-token-safety", kind: "own", providerId: "own", payTo,
      name: "Base token safety check",
      description: "Risk check for any ERC-20 on Base before you buy or accept it: upgradeable-proxy detection (EIP-1967, beacon, UUPS, FiatToken), mint/pause/blacklist/fee/trading-switch powers read from the real (implementation) bytecode, owner and renounce status, live paused state, Uniswap v2/v3 and Aerodrome pools with liquidity, plus a buy/transfer/sell honeypot and tax simulation. Returns a risk level with plain-English flags. Node errors are never charged. Informational, not financial advice.",
      price: { xrpDrops: "10905", rlusd: "0.01", usdc: "0.01" },
      tags: ["base", "token-safety", "honeypot", "risk", "erc20"],
      validate: (req) => validateBaseToken(req),
      handler: (req, env) => baseTokenHandler(req, env),
      routes: [{
        path: "", method: "GET", summary: "Safety check a Base ERC-20 token",
        query: { address: { type: "string", description: "Token contract 0x address on Base", required: true, example: DEGEN } },
        outputExample: { chain: "base", token: { symbol: "DEGEN", decimals: 18 }, riskLevel: "elevated", riskFlags: [{ level: "medium", code: "pausable", message: "The contract can pause transfers." }],
          controls: { ownerRenounced: false, proxy: { isProxy: false }, powers: { mint: false, pause: true, blacklist: false } }, liquidityUsdApprox: 178000,
          simulation: { canBuy: true, canSell: true, buyTaxPercent: 0, sellTaxPercent: 0, honeypot: false } },
      }],
    },
    {
      slug: "base-honeypot", kind: "own", providerId: "own", payTo,
      name: "Base honeypot and tax simulator",
      description: "Simulates a small buy, a wallet-to-wallet transfer and a sell of a Base ERC-20 against its deepest Uniswap v2/v3 or Aerodrome pool (eth_call with state overrides: nothing is sent on-chain) and reports whether you can sell, buy/sell/transfer tax and round-trip loss. Informational, not financial advice.",
      price: { xrpDrops: "5453", rlusd: "0.005", usdc: "0.005" },
      tags: ["base", "honeypot", "tax", "simulation", "erc20"],
      validate: (req) => validateBaseToken(req),
      handler: (req, env) => honeypotHandler(req, env),
      routes: [{
        path: "", method: "GET", summary: "Simulate buy/transfer/sell for a Base token",
        query: { address: { type: "string", description: "Token contract 0x address on Base", required: true, example: "0xFF0C532FDB8Cd566Ae169C1CB157ff2Bdc83E105" } },
        outputExample: { chain: "base", token: { symbol: "FP" }, riskLevel: "moderate", simulation: { pool: { dex: "uniswap-v2" }, canBuy: true, canTransfer: true, canSell: true, buyTaxPercent: 4, sellTaxPercent: 4, transferTaxPercent: 0, roundTripLossPercent: 9.3, honeypot: false } },
      }],
    },
    {
      slug: "base-data", kind: "own", providerId: "own", payTo,
      name: "Base chain data",
      description: "Live JSON from Base mainnet via several public nodes with fallback: ETH and ERC-20 balances, token info, latest block, transaction status, and recent ERC-20 transfers (whole token ~1 h, or one wallet ~24 h). Node failures and empty results are never charged.",
      price: { xrpDrops: "2182", rlusd: "0.002", usdc: "0.002" },
      tags: ["base", "evm", "onchain-data", "erc20", "balances"],
      validate: validateBaseData,
      handler: baseDataHandler,
      routes: [
        { path: "/balance", method: "GET", summary: "ETH balance (and optional ERC-20 balance)", query: { address: { type: "string", description: "Wallet 0x address", required: true, example: "0xEd31466eF9Ff467436F829eFF222bD2c07803d7a" }, token: { type: "string", description: "Optional ERC-20 contract", example: USDC_BASE } }, outputExample: { eth: 0.01, token: { symbol: "USDC", balance: 12.5 } } },
        { path: "/token", method: "GET", summary: "ERC-20 token info", query: { address: { type: "string", description: "Token contract", required: true, example: USDC_BASE } }, outputExample: { name: "USD Coin", symbol: "USDC", decimals: 6, totalSupply: 4000000000 } },
        { path: "/block", method: "GET", summary: "Latest block", outputExample: { number: 62000000, timestamp: "2026-11-25T07:00:00.000Z", transactions: 20, baseFeeGwei: 0.005 } },
        { path: "/tx", method: "GET", summary: "Transaction status", query: { hash: { type: "string", description: "0x transaction hash", required: true, example: "0x" + "ab".repeat(32) } }, outputExample: { status: "success", block: 62000000, gasUsed: 21000 } },
        { path: "/transfers", method: "GET", summary: "Recent ERC-20 transfers", query: { token: { type: "string", description: "Token contract", required: true, example: USDC_BASE }, address: { type: "string", description: "Optional wallet filter (searches ~24 h)" }, limit: { type: "number", description: "1-100 (default 50)" } }, outputExample: { count: 2, transfers: [{ tx: "0x...", from: "0x...", to: "0x...", amount: 10 }] } },
      ],
    },
    {
      slug: "xrpl-more", kind: "own", providerId: "own", payTo,
      name: "XRPL NFTs, AMM, order books, history",
      description: "More XRP Ledger data from public nodes with fallback: NFTs held by an account (decoded URIs), AMM pool reserves/price/fee for any pair, live DEX order book (funded amounts), and recent transaction history. Empty results are not charged.",
      price: { xrpDrops: "1091", rlusd: "0.001", usdc: "0.001" },
      tags: ["xrpl", "nft", "amm", "dex", "onchain-data"],
      validate: validateXrplMore,
      handler: xrplMoreHandler,
      routes: [
        { path: "/nfts", method: "GET", summary: "NFTs held by an account", query: { address: { type: "string", description: "r-address", required: true, example: "rLULtFuV1agdSQdVmSd7AYx2cfEiN6noxY" }, network: { type: "string", description: "mainnet (default) or testnet" } }, outputExample: { count: 1, nfts: [{ id: "000800...", issuer: "r...", uri: "ipfs://..." }] } },
        { path: "/amm", method: "GET", summary: "AMM pool reserves and price", query: { asset: { type: "string", description: "XRP or CODE.rIssuer (default XRP)", example: "XRP" }, asset2: { type: "string", description: "CODE.rIssuer", required: true, example: "RLUSD." + RLUSD_ISS } }, outputExample: { price: 2.17, priceUnit: "XRP per 1 RLUSD", tradingFeePercent: 0.1 } },
        { path: "/orderbook", method: "GET", summary: "DEX order book", query: { base: { type: "string", description: "XRP or CODE.rIssuer (default XRP)", example: "XRP" }, quote: { type: "string", description: "CODE.rIssuer", required: true, example: "RLUSD." + RLUSD_ISS }, limit: { type: "number", description: "1-50 (default 10)" } }, outputExample: { bestAsk: 0.92, bestBid: 0.918, asks: [], bids: [] } },
        { path: "/history", method: "GET", summary: "Recent transactions", query: { address: { type: "string", description: "r-address", required: true, example: RLUSD_ISS }, limit: { type: "number", description: "1-100 (default 25)" } }, outputExample: { count: 1, transactions: [{ type: "Payment", result: "tesSUCCESS" }] } },
      ],
    },
    {
      slug: "xrpl-presend", kind: "own", providerId: "own", payTo,
      name: "XRPL pre-send payment check",
      description: "Check an XRP Ledger payment before you sign it: destination exists (or the XRP amount covers the reserve to create it), destination tag required, DepositAuth and preauthorization, DisallowXRP, blackholed destination, and for tokens the trust line, its limit, issuer freeze/global freeze and authorization. Returns ok_to_send / send_with_caution / do_not_send.",
      price: { xrpDrops: "1091", rlusd: "0.001", usdc: "0.001" },
      tags: ["xrpl", "payments", "destination-tag", "pre-flight", "safety"],
      validate: (req) => validatePresend(req),
      handler: (req, env) => presendHandler(req, env),
      routes: [{
        path: "", method: "GET", summary: "Pre-flight an XRPL payment",
        query: {
          destination: { type: "string", description: "Destination classic r-address", required: true, example: "rEb8TK3gBgk5auZkwc6sHnwrGVJH8DuaLh" },
          amount: { type: "string", description: "Amount (decimal) to check reserve / trust-line room", example: "25" },
          currency: { type: "string", description: "XRP (default), RLUSD or a token code", example: "XRP" },
          issuer: { type: "string", description: "Token issuer (required for tokens other than RLUSD)" },
          tag: { type: "string", description: "Destination tag you plan to use" },
          source: { type: "string", description: "Your address (for DepositAuth preauthorization)" },
          network: { type: "string", description: "mainnet (default) or testnet" },
        },
        outputExample: { verdict: "do_not_send", summary: "Destination REQUIRES a destination tag...", checks: [{ check: "destination_tag", ok: false, level: "block" }] },
      }],
    },
    {
      slug: "web-ai", kind: "own", providerId: "own", payTo,
      name: "Web page summary and field extraction",
      description: "Summarize a public web page or extract the fields you name (title, author, published date, price, rating, etc. from page text, meta tags and JSON-LD). Honors robots.txt (also on redirects), refuses private/local addresses on every redirect, and does not harvest emails or phone numbers. Pages with no readable text or none of the fields are not charged.",
      price: { xrpDrops: "5453", rlusd: "0.005", usdc: "0.005" },
      tags: ["web", "summary", "extract", "llm-input", "readability"],
      validate: validateWebAi,
      handler: webAiHandler,
      routes: [
        { path: "/summary", method: "GET", summary: "Summarize a page", query: { url: { type: "string", description: "Public https URL", required: true, example: "https://xrpl.org/docs/agents/agentic-payments-x402" }, length: { type: "string", description: "short | medium | long", example: "short" } }, outputExample: { title: "...", summary: "...", method: "extractive", words: 1200 } },
        { path: "/extract", method: "GET", summary: "Extract named fields as JSON", query: { url: { type: "string", description: "Public https URL", required: true, example: "https://en.wikipedia.org/wiki/XRP_Ledger" }, fields: { type: "string", description: "Comma-separated field names (max 15)", required: true, example: "title,description,author,published" } }, outputExample: { fields: { title: "XRP Ledger - Wikipedia", author: "Contributors to Wikimedia projects" }, method: "metadata" } },
      ],
    },
    {
      slug: "convert", kind: "own", providerId: "own", payTo,
      name: "File to JSON/text converter",
      description: "Convert PDF, CSV/TSV, XLSX/XLS or HTML into structured JSON (rows, sheets, pages) or plain text. POST raw bytes, or JSON {\"url\": ...} / {\"content_base64\": ..., \"format\": ...}. Max 10 MB.",
      price: { xrpDrops: "5454", rlusd: "0.005", usdc: "0.005" },
      tags: ["pdf", "csv", "xlsx", "convert", "parse"],
      validate: (req) => validateConvert(req),
      handler: (req, env) => convertHandler(req, env),
      routes: [{
        path: "", method: "POST", summary: "Convert a file",
        query: { to: { type: "string", description: "json (default) or text" }, format: { type: "string", description: "pdf|csv|tsv|xlsx|xls|html (auto-detected if omitted)" } },
        body: { contentTypes: ["application/json", "application/pdf", "text/csv", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "text/html"], description: "Raw file bytes, or JSON {url} / {content_base64, format}" },
        outputExample: { format: "csv", columns: ["name", "amount"], rowCount: 2, rows: [{ name: "a", amount: "1" }] },
      }],
    },
    {
      slug: "json-tools", kind: "own", providerId: "own", payTo,
      name: "Safe JSON transform utility",
      description: "Deterministic JSON transforms with no code execution: pick, get, flatten, filter_eq, sort_by, dedupe, limit, count, keys, to_csv. Up to 20 ops, 512 KB input.",
      price: { xrpDrops: "1091", rlusd: "0.001", usdc: "0.001" },
      tags: ["json", "transform", "csv", "utility"],
      validate: (req) => validateJsonTools(req),
      handler: (req) => jsonToolsHandler(req, null),
      routes: [{
        path: "", method: "POST", summary: "Apply JSON ops",
        body: { contentTypes: ["application/json"], description: '{"data": [...], "ops": [{"op":"sort_by","path":"price","desc":true},{"op":"limit","n":5}]}' },
        outputExample: { ok: true, opsApplied: ["sort_by", "limit"], result: [] },
      }],
    },
    {
      slug: "hello", kind: "own", providerId: "own", payTo,
      name: "Hello (payment test)",
      description: "Smallest possible paid call for testing an x402 client end to end. Returns a greeting and the payer address.",
      price: { xrpDrops: "100", rlusd: "0.0001", usdc: "0.001" },
      tags: ["test", "demo"],
      handler: async (req) => json({ hello: new URL(req.url).searchParams.get("name") ?? "agent", paidAt: new Date().toISOString() }),
      routes: [{ path: "", method: "GET", summary: "Paid hello", query: { name: { type: "string", description: "Your name", example: "agent" } }, outputExample: { hello: "agent" } }],
    },
  ];
}

// First-party paid services ("the plumbing agents pay for").
// Prices follow Johnny's USD ranges, expressed in XRP / RLUSD / USDC.
// XRP amounts assume ~US$0.917/XRP (CoinGecko, 25 Nov 2026); re-check when XRP moves. Prices cut to market rates on 25 Nov 2026.
import type { Env, PaidService } from "./types";
import { webMarkdownHandler } from "./services/web-markdown";
import { validateXrplData, xrplDataHandler } from "./services/xrpl-data";
import { convertHandler, validateConvert } from "./services/convert";
import { jsonToolsHandler, validateJsonTools } from "./services/json-tools";
import { safetyHandler, validateSafety } from "./services/xrpl-safety";
import { HttpError, json } from "./util";

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
